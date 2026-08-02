import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DaemonStateStore } from "./daemon-state-store.js";
import { ProjectRegistryService } from "./project-registry-service.js";

const COMMAND_1 = "00000000-0000-4000-8000-000000000931";
const COMMAND_2 = "00000000-0000-4000-8000-000000000932";
const PROJECT_1 = "00000000-0000-4000-8000-000000000941";
const PROJECT_2 = "00000000-0000-4000-8000-000000000942";
const PROJECT_3 = "00000000-0000-4000-8000-000000000943";
const temporaryDirectories: string[] = [];
const stores: DaemonStateStore[] = [];

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-project-service-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openStore(path?: string): Promise<DaemonStateStore> {
  const store = await DaemonStateStore.open({ databasePath: path ?? (await createDatabasePath()) });
  stores.push(store);
  return store;
}

function registration(
  commandId = COMMAND_1,
  projectId = PROJECT_1,
  absolutePath = "/Users/example/alpha",
) {
  return {
    commandId,
    projectId,
    displayName: absolutePath.split("/").at(-1) ?? "workspace",
    workspace: { platform: "macos" as const, absolutePath },
  };
}

function service(store: DaemonStateStore, now = vi.fn(() => 1_750_000_000_001)) {
  return new ProjectRegistryService(store, { now, hostPlatform: "macos" });
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("ProjectRegistryService", () => {
  it("lists an empty registry and persists a frozen Project summary", async () => {
    const store = await openStore();
    const registry = service(store);

    expect(registry.list({ cursor: null, limit: 12 })).toEqual({
      schemaVersion: 1,
      projects: [],
      nextCursor: null,
    });
    const result = registry.register(registration());
    expect(result).toEqual({
      schemaVersion: 1,
      status: "registered",
      project: {
        projectId: PROJECT_1,
        projectVersion: 1,
        displayName: "alpha",
        workspace: {
          platform: "macos",
          absolutePath: "/Users/example/alpha",
          identityStatus: "unverified",
        },
      },
    });
    expect(registry.list({ cursor: null, limit: 12 }).projects).toEqual([result.project]);
    expect(store.inspect()).toMatchObject({ eventCount: 1 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.project)).toBe(true);
    expect(Object.isFrozen(result.project.workspace)).toBe(true);
  });

  it("makes exact command retries idempotent and rejects conflicting reuse", async () => {
    const store = await openStore();
    const now = vi.fn(() => 1_750_000_000_002);
    const registry = service(store, now);
    const command = registration();

    expect(registry.register(command).status).toBe("registered");
    expect(registry.register(command).status).toBe("registered");
    expect(now).toHaveBeenCalledTimes(1);
    expect(store.inspect()).toMatchObject({ eventCount: 1 });

    expect(() => registry.register({ ...command, displayName: "changed" })).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("returns an existing Project for a later selection of the same workspace", async () => {
    const store = await openStore();
    const now = vi.fn(() => 1_750_000_000_003);
    const registry = service(store, now);
    const first = registry.register(registration());
    const existing = registry.register(registration(COMMAND_2, PROJECT_2));

    expect(existing).toEqual({ ...first, status: "existing" });
    expect(now).toHaveBeenCalledTimes(1);
    expect(store.inspect()).toMatchObject({ eventCount: 1 });
  });

  it("returns stable bounded pages and recovers them after reopening SQLite", async () => {
    const path = await createDatabasePath();
    const firstStore = await openStore(path);
    const registry = service(
      firstStore,
      vi.fn(() => 1_750_000_000_004),
    );
    registry.register(registration(COMMAND_1, PROJECT_1, "/Users/example/alpha"));
    registry.register(registration(COMMAND_2, PROJECT_2, "/Users/example/beta"));
    registry.register(
      registration("00000000-0000-4000-8000-000000000933", PROJECT_3, "/Users/example/gamma"),
    );

    const firstPage = registry.list({ cursor: null, limit: 2 });
    expect(firstPage.projects.map((project) => project.projectId)).toEqual([PROJECT_1, PROJECT_2]);
    expect(firstPage.nextCursor).toBe(PROJECT_2);
    expect(
      registry
        .list({ cursor: firstPage.nextCursor, limit: 2 })
        .projects.map((project) => project.projectId),
    ).toEqual([PROJECT_3]);

    firstStore.close();
    const reopenedStore = await openStore(path);
    expect(service(reopenedStore).list({ cursor: null, limit: 12 }).projects).toHaveLength(3);
  });

  it("rejects a foreign platform and malformed commands without writing", async () => {
    const store = await openStore();
    const registry = service(store);

    expect(() =>
      registry.register({
        ...registration(),
        workspace: { platform: "linux", absolutePath: "/home/example/alpha" },
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() => registry.list({ cursor: null, limit: 13 })).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(store.inspect()).toMatchObject({ eventCount: 0 });
  });

  it("fails closed after its state owner closes", async () => {
    const store = await openStore();
    const registry = service(store);
    store.close();

    expect(() => registry.list({ cursor: null, limit: 12 })).toThrowError(
      expect.objectContaining({ code: "unavailable" }),
    );
    expect(() => registry.register(registration())).toThrowError(
      expect.objectContaining({ code: "unavailable" }),
    );
  });
});
