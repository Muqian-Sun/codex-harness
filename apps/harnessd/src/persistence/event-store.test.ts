import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EventStoreError,
  HarnessEventStore,
  type EventToAppend,
  type ProjectionDefinition,
} from "./event-store.js";

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
  options?: Readonly<{
    busyTimeoutMs?: number;
    projections?: readonly ProjectionDefinition[];
  }>,
): Promise<HarnessEventStore> {
  const store = await HarnessEventStore.open({
    path,
    busyTimeoutMs: options?.busyTimeoutMs ?? 100,
    now: () => 1_750_000_000_000,
    ...(options?.projections === undefined ? {} : { projections: options.projections }),
  });
  stores.push(store);
  return store;
}

function counterProjection(
  version = 1,
  increment = 1,
  name = "task.counter",
): ProjectionDefinition {
  return {
    name,
    version,
    selectKeys: (stored) => (stored.streamType === "task" ? ["summary"] : []),
    reduce: ({ current, event: stored }) => {
      const count =
        typeof current === "object" &&
        current !== null &&
        !Array.isArray(current) &&
        typeof current.count === "number"
          ? current.count
          : 0;
      return {
        type: "set",
        state: { count: count + increment, lastEventType: stored.eventType },
      };
    },
  };
}

function downgradeToSchemaV1(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE projection_state");
  raw.exec("DROP TRIGGER schema_migrations_no_delete");
  raw.exec("DELETE FROM schema_migrations WHERE version = 2");
  raw.exec(`CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations_immutable');
END;`);
  raw.exec("PRAGMA user_version = 1");
  raw.close();
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
      schemaVersion: 2,
      eventCount: 1,
      lastSequence: 1,
      journalMode: "wal",
      projectionCount: 0,
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

  it("reads an exact immutable event by its identifier without scanning", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    const firstInput = event();
    const first = store.append(firstInput).event;

    const found = store.readByEventId(firstInput.eventId);
    expect(found).toEqual(first);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found?.payload)).toBe(true);
    expect(store.readByEventId(randomUUID())).toBeUndefined();
    expect(() => store.readByEventId("not-an-event-id")).toThrowError(
      expect.objectContaining({ code: "invalid_query" }),
    );

    store.close();
    expect(() => store.readByEventId(firstInput.eventId)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });

  it("appends an ordered batch atomically and makes the complete retry idempotent", async () => {
    const { path } = await privateDatabasePath();
    const projection = counterProjection();
    const store = await openStore(path, { projections: [projection] });
    const inputs = [
      event({ eventType: "task.created" }),
      event({ eventType: "task.updated" }),
      event({ eventType: "task.confirmed" }),
    ];
    const appended = store.appendBatch(inputs);
    const duplicate = store.appendBatch(inputs);

    expect(appended).toMatchObject({
      duplicate: false,
      events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
    });
    expect(duplicate).toEqual({ duplicate: true, events: appended.events });
    for (const conflictingRetry of [
      [inputs[0]!, { ...inputs[1]!, payload: { changed: true } }, inputs[2]!],
      [...inputs].reverse(),
    ]) {
      let captured: unknown;
      try {
        store.appendBatch(conflictingRetry);
      } catch (error: unknown) {
        captured = error;
      }
      expect(captured).toMatchObject({ code: "conflict" });
    }
    expect(Object.isFrozen(appended.events)).toBe(true);
    expect(store.readProjectionState(projection.name, "summary")?.state).toEqual({
      count: 3,
      lastEventType: "task.confirmed",
    });
    expect(store.inspect()).toMatchObject({ eventCount: 3, lastSequence: 3 });
  });

  it("rolls back every event and projection when a later batch reducer fails", async () => {
    const { path } = await privateDatabasePath();
    const projection: ProjectionDefinition = {
      name: "task.batch_rollback",
      version: 1,
      selectKeys: () => ["summary"],
      reduce: ({ current, event: stored }) => {
        if (stored.eventType === "task.fail") {
          throw new Error("secret batch reducer detail");
        }
        const count =
          typeof current === "object" &&
          current !== null &&
          !Array.isArray(current) &&
          typeof current.count === "number"
            ? current.count
            : 0;
        return { type: "set", state: { count: count + 1 } };
      },
    };
    const store = await openStore(path, { projections: [projection] });
    let captured: unknown;
    try {
      store.appendBatch([
        event({ eventType: "task.created" }),
        event({ eventType: "task.fail" }),
        event({ eventType: "task.never_applied" }),
      ]);
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toMatchObject({ code: "projection_failure" });
    expect(String(captured)).not.toContain("secret batch reducer detail");
    expect(store.inspect()).toMatchObject({ eventCount: 0, lastSequence: 0 });
    expect(store.readProjectionState(projection.name, "summary")).toBeUndefined();
    expect(store.append(event({ eventType: "task.recovered" })).event.sequence).toBe(1);
  });

  it("rejects partial, conflicting, and malformed batch retries without filling gaps", async () => {
    const { path } = await privateDatabasePath();
    const store = await openStore(path);
    const first = event();
    const second = event({ eventType: "task.updated" });
    store.append(first);

    let captured: unknown;
    try {
      store.appendBatch([first, second]);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "conflict" });
    expect(() => store.appendBatch([first, { ...first, payload: { changed: true } }])).toThrowError(
      EventStoreError,
    );
    expect(store.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
  });

  it("rejects empty, duplicate, sparse, accessor, oversized, and amplified batches", async () => {
    const invalidPath = await privateDatabasePath();
    const store = await openStore(invalidPath.path);
    expect(() => store.appendBatch([])).toThrowError(EventStoreError);
    const duplicate = event();
    expect(() => store.appendBatch([duplicate, duplicate])).toThrowError(EventStoreError);
    expect(() => store.appendBatch(new Array(1) as never)).toThrowError(EventStoreError);
    const accessorBatch = [event()];
    let accessorCalled = false;
    Object.defineProperty(accessorBatch, "0", {
      enumerable: true,
      get: () => {
        accessorCalled = true;
        return event();
      },
    });
    expect(() => store.appendBatch(accessorBatch)).toThrowError(EventStoreError);
    expect(accessorCalled).toBe(false);
    const tooMany = Array.from({ length: 17 }, () => event());
    expect(() => store.appendBatch(tooMany)).toThrowError(EventStoreError);
    const oversized = Array.from({ length: 5 }, () =>
      event({ payload: { value: "x".repeat(900_000) } }),
    );
    expect(() => store.appendBatch(oversized)).toThrowError(EventStoreError);
    expect(store.inspect().eventCount).toBe(0);

    const amplifiedPath = await privateDatabasePath();
    const largeValue = "x".repeat(900_000);
    const projections = ["alpha", "bravo", "charlie"].map((suffix): ProjectionDefinition => ({
      name: `task.batch_amplified_${suffix}`,
      version: 1,
      selectKeys: () => ["summary"],
      reduce: () => ({ type: "set", state: { value: largeValue } }),
    }));
    const amplified = await openStore(amplifiedPath.path, { projections });
    expect(() => amplified.appendBatch(Array.from({ length: 4 }, () => event()))).toThrowError(
      EventStoreError,
    );
    expect(amplified.inspect()).toMatchObject({ eventCount: 0, lastSequence: 0 });
    expect(amplified.readProjectionState(projections[0]!.name, "summary")).toBeUndefined();
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

  it("updates registered projections atomically and does not replay duplicate events", async () => {
    const { path } = await privateDatabasePath();
    const projection = counterProjection();
    const store = await openStore(path, { projections: [projection] });
    const firstInput = event();
    store.append(firstInput);
    store.append(firstInput);
    store.append(event({ eventType: "task.updated" }));

    expect(store.readProjectionState(projection.name, "summary")).toEqual({
      projectionName: projection.name,
      key: "summary",
      sourceSequence: 2,
      state: { count: 2, lastEventType: "task.updated" },
    });
    expect(store.listProjectionStates(projection.name)).toEqual([
      store.readProjectionState(projection.name, "summary"),
    ]);
    expect(Object.isFrozen(store.readProjectionState(projection.name, "summary")?.state)).toBe(
      true,
    );
    expect(store.inspect()).toMatchObject({ eventCount: 2, projectionCount: 1 });
    expect(() => store.readProjectionState("task.unknown", "summary")).toThrowError(
      EventStoreError,
    );
    expect(() => store.listProjectionStates(projection.name, "invalid key")).toThrowError(
      EventStoreError,
    );
  });

  it("rolls back the event and every projection when one reducer fails", async () => {
    const { path } = await privateDatabasePath();
    const good = counterProjection(1, 1, "task.a_good");
    const failing: ProjectionDefinition = {
      name: "task.z_failing",
      version: 1,
      selectKeys: () => ["summary"],
      reduce: () => {
        throw new Error("secret reducer detail");
      },
    };
    const store = await openStore(path, { projections: [good, failing] });

    let captured: unknown;
    try {
      store.append(event());
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "projection_failure" });
    expect(String(captured)).not.toContain("secret reducer detail");
    expect(store.inspect()).toMatchObject({ eventCount: 0, lastSequence: 0, projectionCount: 2 });
    expect(store.readProjectionState(good.name, "summary")).toBeUndefined();
    expect(store.readProjectionState(failing.name, "summary")).toBeUndefined();
  });

  it("replays missing projections, catches up a valid stale checkpoint, and rebuilds versions", async () => {
    const { path } = await privateDatabasePath();
    const first = await openStore(path);
    first.append(event({ eventType: "task.created" }));
    first.append(event({ eventType: "task.updated" }));
    first.close();

    const versionOne = counterProjection();
    const replayed = await openStore(path, { projections: [versionOne] });
    expect(replayed.readProjectionState(versionOne.name, "summary")?.state).toEqual({
      count: 2,
      lastEventType: "task.updated",
    });
    replayed.close();

    const raw = new DatabaseSync(path);
    raw
      .prepare(
        `UPDATE projection_state
         SET state_json = ?, source_sequence = 1
         WHERE projection_name = ? AND projection_key = ?`,
      )
      .run('{"count":1,"lastEventType":"task.created"}', versionOne.name, "summary");
    raw
      .prepare(
        `UPDATE projection_checkpoints SET last_sequence = 1
         WHERE projection_name = ?`,
      )
      .run(versionOne.name);
    raw.close();

    const caughtUp = await openStore(path, { projections: [versionOne] });
    expect(caughtUp.readProjectionState(versionOne.name, "summary")?.state).toEqual({
      count: 2,
      lastEventType: "task.updated",
    });
    caughtUp.close();

    const versionTwo = counterProjection(2, 10);
    const rebuilt = await openStore(path, { projections: [versionTwo] });
    expect(rebuilt.readProjectionState(versionTwo.name, "summary")?.state).toEqual({
      count: 20,
      lastEventType: "task.updated",
    });
  });

  it("rejects invalid projection definitions and reducer outputs", async () => {
    const duplicate = await privateDatabasePath();
    await expect(
      openStore(duplicate.path, { projections: [counterProjection(), counterProjection()] }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    const invalidKeys = await privateDatabasePath();
    const duplicateKeys: ProjectionDefinition = {
      name: "task.duplicate_keys",
      version: 1,
      selectKeys: () => ["same", "same"],
      reduce: () => ({ type: "keep" }),
    };
    const store = await openStore(invalidKeys.path, { projections: [duplicateKeys] });
    expect(() => store.append(event())).toThrowError(EventStoreError);
    expect(store.inspect().eventCount).toBe(0);

    const invalidState = await privateDatabasePath();
    const oversized: ProjectionDefinition = {
      name: "task.oversized",
      version: 1,
      selectKeys: () => ["summary"],
      reduce: () => ({ type: "set", state: { value: "x".repeat(1024 * 1024) } }),
    };
    const oversizedStore = await openStore(invalidState.path, { projections: [oversized] });
    expect(() => oversizedStore.append(event())).toThrowError(EventStoreError);
    expect(oversizedStore.inspect().eventCount).toBe(0);

    const amplified = await privateDatabasePath();
    const largeValue = "x".repeat(900_000);
    const projectionNames = ["alpha", "bravo", "charlie", "delta", "echo"];
    const projections = projectionNames.map((suffix): ProjectionDefinition => ({
      name: `task.amplified_${suffix}`,
      version: 1,
      selectKeys: () => ["summary"],
      reduce: () => ({ type: "set", state: { value: largeValue } }),
    }));
    const amplifiedStore = await openStore(amplified.path, { projections });
    expect(() => amplifiedStore.append(event())).toThrowError(EventStoreError);
    expect(amplifiedStore.inspect()).toMatchObject({ eventCount: 0, projectionCount: 5 });
  });

  it("upgrades a schema v1 database without rewriting migration history", async () => {
    const { path } = await privateDatabasePath();
    const current = await openStore(path);
    current.append(event());
    current.close();

    downgradeToSchemaV1(path);

    const upgraded = await openStore(path);
    expect(upgraded.inspect()).toMatchObject({
      schemaVersion: 2,
      eventCount: 1,
      projectionCount: 0,
    });
    upgraded.close();
    const verified = new DatabaseSync(path);
    expect(verified.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject(
      { count: 2 },
    );
    verified.close();
  });

  it("validates existing migration history before applying the next version", async () => {
    const { path } = await privateDatabasePath();
    const current = await openStore(path);
    current.close();
    downgradeToSchemaV1(path);

    const corrupted = new DatabaseSync(path);
    corrupted.exec("DROP TRIGGER schema_migrations_no_update");
    corrupted.exec(`UPDATE schema_migrations SET checksum = '${"0".repeat(64)}' WHERE version = 1`);
    corrupted.exec(`CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations_immutable');
END;`);
    corrupted.close();

    await expect(openStore(path)).rejects.toMatchObject({ code: "migration_mismatch" });
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    expect(
      unchanged
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_schema
           WHERE type = 'table' AND name = 'projection_state'`,
        )
        .get(),
    ).toMatchObject({ count: 0 });
    unchanged.close();
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

  it("rejects projection state tampering before recovery can write", async () => {
    const nonCanonical = await privateDatabasePath();
    const projection = counterProjection();
    const stateStore = await openStore(nonCanonical.path, { projections: [projection] });
    stateStore.append(event());
    stateStore.close();
    const stateRaw = new DatabaseSync(nonCanonical.path);
    stateRaw
      .prepare(
        `UPDATE projection_state SET state_json = ?
         WHERE projection_name = ? AND projection_key = ?`,
      )
      .run('{"lastEventType":"task.created","count":1}', projection.name, "summary");
    stateRaw.close();
    await expect(openStore(nonCanonical.path, { projections: [projection] })).rejects.toMatchObject(
      { code: "corrupt_data" },
    );

    const ahead = await privateDatabasePath();
    const aheadStore = await openStore(ahead.path, { projections: [projection] });
    aheadStore.append(event());
    aheadStore.close();
    const aheadRaw = new DatabaseSync(ahead.path);
    aheadRaw
      .prepare(
        `UPDATE projection_checkpoints SET last_sequence = 2
         WHERE projection_name = ?`,
      )
      .run(projection.name);
    aheadRaw.close();
    await expect(openStore(ahead.path, { projections: [projection] })).rejects.toMatchObject({
      code: "corrupt_data",
    });
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
