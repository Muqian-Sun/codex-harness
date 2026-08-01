import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventStoreError, HarnessEventStore, type EventToAppend } from "./event-store.js";

const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

async function privateDatabasePath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-events-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return { directory, path: join(directory, "harness.db") };
}

async function openStore(
  path: string,
  options?: Readonly<{ busyTimeoutMs?: number }>,
): Promise<HarnessEventStore> {
  const store = await HarnessEventStore.open({
    path,
    busyTimeoutMs: options?.busyTimeoutMs ?? 100,
    now: () => 1_750_000_000_000,
  });
  stores.push(store);
  return store;
}

function event(overrides?: Partial<EventToAppend>): EventToAppend {
  return {
    eventId: randomUUID(),
    streamType: "task",
    streamId: randomUUID(),
    eventType: "task.created",
    eventVersion: 1,
    occurredAtMs: 1_750_000_000_001,
    payload: { z: true, nested: { b: 2, a: 1 } },
    metadata: {
      actor: "user.local",
      correlationId: "request-1",
    },
    ...overrides,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Test cleanup continues for a store deliberately placed in a failure state.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("SQLite Harness event store", () => {
  it("creates a private WAL database with the pinned schema", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    const appended = store.append(event());

    expect(appended.event.sequence).toBe(1);
    expect(store.inspect()).toMatchObject({
      schemaVersion: 1,
      eventCount: 1,
      lastSequence: 1,
      journalMode: "wal",
      sqliteVersion: expect.stringMatching(/^3\./),
    });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(`${path}-wal`)).mode & 0o777).toBe(0o600);
  });

  it("appends globally ordered events and makes identical retries idempotent", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    const firstInput = event();
    const first = store.append(firstInput);
    const duplicate = store.append({
      ...firstInput,
      payload: { nested: { a: 1, b: 2 }, z: true },
      metadata: { correlationId: "request-1", actor: "user.local" },
    });
    const second = store.append(event({ eventType: "task.updated" }));

    expect(first).toMatchObject({ duplicate: false, event: { sequence: 1 } });
    expect(duplicate).toEqual({ duplicate: true, event: first.event });
    expect(second.event.sequence).toBe(2);
    expect(store.readAfter(0, 10).map((stored) => stored.sequence)).toEqual([1, 2]);
    expect(Object.keys(first.event.payload as object)).toEqual(["nested", "z"]);
    expect(Object.isFrozen(first.event.payload)).toBe(true);
    expect(Object.isFrozen((first.event.payload as { nested: object }).nested)).toBe(true);
  });

  it("rejects conflicting event IDs and rolls the transaction back", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    const original = event();
    store.append(original);

    expect(() => store.append({ ...original, payload: { changed: true } })).toThrowError(
      EventStoreError,
    );
    try {
      store.append({ ...original, payload: { changed: true } });
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "conflict" });
      expect(String(error)).not.toContain(original.eventId);
    }
    expect(store.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
  });

  it("rejects invalid, oversized, cyclic events and invalid pagination", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => store.append(event({ eventType: "Invalid Event" }))).toThrowError(EventStoreError);
    expect(() => store.append({ ...event(), unexpected: true } as never)).toThrowError(
      EventStoreError,
    );
    expect(() => store.append(event({ payload: cyclic as never }))).toThrowError(EventStoreError);
    expect(() => store.append(event({ payload: { value: "x".repeat(1024 * 1024) } }))).toThrowError(
      EventStoreError,
    );
    expect(() => store.readAfter(-1)).toThrowError(EventStoreError);
    expect(() => store.readAfter(0, 1_001)).toThrowError(EventStoreError);
    expect(store.inspect().eventCount).toBe(0);
  });

  it("reopens the same migration and preserves ordered events", async () => {
    const { path } = await privateDatabasePath();
    const first = await openStore(path);
    const appended = first.append(event());
    first.close();

    const reopened = await openStore(path);
    expect(reopened.readAfter(0)).toEqual([appended.event]);
    expect(reopened.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
  });

  it("allows only one exclusive writer connection", async () => {
    const { path } = await privateDatabasePath();
    await openStore(path);

    await expect(openStore(path, { busyTimeoutMs: 20 })).rejects.toMatchObject({
      code: "database_busy",
    });
  });

  it("enforces immutable events and migration records at the SQLite layer", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    store.append(event());
    store.close();

    const raw = new DatabaseSync(path);
    try {
      expect(() => raw.exec("UPDATE event_log SET event_type = 'task.changed'")).toThrow();
      expect(() => raw.exec("DELETE FROM event_log")).toThrow();
      expect(() => raw.exec("UPDATE schema_migrations SET checksum = 'bad'")).toThrow();
    } finally {
      raw.close();
    }
    const reopened = await openStore(path);
    expect(reopened.inspect().eventCount).toBe(1);
  });

  it("rejects unrelated, symlinked, and shared database locations", async () => {
    const unrelated = await privateDatabasePath();
    const raw = new DatabaseSync(unrelated.path);
    raw.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    raw.close();
    await chmod(unrelated.path, 0o600);
    await expect(openStore(unrelated.path)).rejects.toMatchObject({
      code: "unsupported_database",
    });

    const linked = await privateDatabasePath();
    const target = join(linked.directory, "target.db");
    const targetDatabase = new DatabaseSync(target);
    targetDatabase.close();
    await symlink(target, linked.path);
    await expect(openStore(linked.path)).rejects.toMatchObject({
      code: "invalid_configuration",
    });

    const shared = await privateDatabasePath();
    await chmod(shared.directory, 0o755);
    await expect(openStore(shared.path)).rejects.toMatchObject({
      code: "invalid_configuration",
    });

    const hardLinked = await privateDatabasePath();
    const hardLinkTarget = join(hardLinked.directory, "target.db");
    const hardLinkDatabase = new DatabaseSync(hardLinkTarget);
    hardLinkDatabase.close();
    await chmod(hardLinkTarget, 0o600);
    await link(hardLinkTarget, hardLinked.path);
    await expect(openStore(hardLinked.path)).rejects.toMatchObject({
      code: "invalid_configuration",
    });

    const sidecarLinked = await privateDatabasePath();
    const sidecarTarget = join(sidecarLinked.directory, "sidecar-target");
    await writeFile(sidecarTarget, "sentinel", { mode: 0o600 });
    await symlink(sidecarTarget, `${sidecarLinked.path}-wal`);
    await expect(openStore(sidecarLinked.path)).rejects.toMatchObject({
      code: "invalid_configuration",
    });
  });

  it("detects schema and canonical event data tampering on reopen", async () => {
    const schemaTampered = await privateDatabasePath();
    const schemaStore = await openStore(schemaTampered.path);
    schemaStore.close();
    const schemaRaw = new DatabaseSync(schemaTampered.path);
    schemaRaw.exec(`
      DROP TRIGGER event_log_no_delete;
      CREATE TRIGGER event_log_no_delete
      BEFORE DELETE ON event_log
      BEGIN
        SELECT 1;
      END;
    `);
    schemaRaw.close();
    await expect(openStore(schemaTampered.path)).rejects.toMatchObject({
      code: "migration_mismatch",
    });

    const dataTampered = await privateDatabasePath();
    const dataStore = await openStore(dataTampered.path);
    dataStore.close();
    const dataRaw = new DatabaseSync(dataTampered.path);
    dataRaw
      .prepare(
        `INSERT INTO event_log (
           event_id, stream_type, stream_id, event_type, event_version,
           occurred_at_ms, payload_json, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        "task",
        randomUUID(),
        "task.created",
        1,
        1_750_000_000_001,
        '{"z":true,"a":false}',
        "{}",
      );
    dataRaw.close();
    await expect(openStore(dataTampered.path)).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("closes idempotently and rejects later operations", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    store.close();
    store.close();
    expect(() => store.inspect()).toThrowError(EventStoreError);
    expect(() => store.append(event())).toThrowError(EventStoreError);
  });
});
