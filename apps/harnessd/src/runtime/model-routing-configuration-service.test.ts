import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@codex-harness/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AppServerWorkerCloseResult,
  AppServerWorkerConfig,
  AppServerWorkerState,
} from "./app-server-worker.js";
import {
  AppServerWorkerManager,
  type ManagedAppServerWorker,
} from "./app-server-worker-manager.js";
import { DaemonStateStore } from "./daemon-state-store.js";
import {
  ModelRoutingConfigurationService,
  ModelRoutingConfigurationServiceError,
} from "./model-routing-configuration-service.js";

const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000911";
const CATALOG_ID = "00000000-0000-4000-8000-000000000912";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000913";
const REVISION_1 = "00000000-0000-4000-8000-000000000921";
const REVISION_2 = "00000000-0000-4000-8000-000000000922";
const temporaryDirectories: string[] = [];
const stores: DaemonStateStore[] = [];
const managers: AppServerWorkerManager[] = [];

class FakeWorker implements ManagedAppServerWorker {
  state: AppServerWorkerState = "ready";
  readonly closed: Promise<AppServerWorkerCloseResult>;
  #resolveClosed!: (result: AppServerWorkerCloseResult) => void;

  constructor(readonly models: readonly JsonValue[]) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async listModels(): Promise<JsonValue> {
    return { data: [...this.models], nextCursor: null };
  }

  async readAccount(): Promise<JsonValue> {
    return { account: null, requiresOpenaiAuth: true };
  }

  async close(): Promise<AppServerWorkerCloseResult> {
    const result = Object.freeze({
      reason: "requested" as const,
      containment: "graceful" as const,
      exitCode: 0,
      signal: null,
      stderrObserved: false,
    });
    if (this.state !== "closed") {
      this.state = "closed";
      this.#resolveClosed(result);
    }
    return result;
  }
}

function model(name: string, efforts: readonly string[], hidden = false): JsonValue {
  return {
    id: `id-${name}`,
    model: name,
    hidden,
    defaultReasoningEffort: efforts[0]!,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    inputModalities: ["text"],
  };
}

const visibleModels = Object.freeze([
  model("fast-model", ["low", "medium"]),
  model("standard-model", ["medium"]),
  model("deep-model", ["high", "xhigh"]),
]);

function tiers(suffix = ""): Record<string, JsonValue> {
  return {
    fast: { provider: "openai", model: `fast-model${suffix}`, reasoningEffort: "low" },
    standard: {
      provider: "openai",
      model: "standard-model",
      reasoningEffort: "medium",
    },
    deep: { provider: "openai", model: "deep-model", reasoningEffort: "high" },
  };
}

async function openStore(path?: string): Promise<DaemonStateStore> {
  const databasePath = path ?? (await createDatabasePath());
  const store = await DaemonStateStore.open({ databasePath });
  stores.push(store);
  return store;
}

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-routing-service-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function startManager(models = visibleModels): Promise<AppServerWorkerManager> {
  const worker = new FakeWorker(models);
  const ids = [WORKER_SESSION_ID, CATALOG_ID, ACCOUNT_ID];
  const times = [1_750_000_000_001, 1_750_000_000_002];
  const manager = await AppServerWorkerManager.start(
    { provider: "openai", worker: {} as AppServerWorkerConfig },
    {
      startWorker: async () => worker,
      newId: () => ids.shift() ?? "missing-id",
      now: () => times.shift() ?? -1,
    },
  );
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("ModelRoutingConfigurationService", () => {
  it("returns an explicit unconfigured state and persists an available three-tier mapping", async () => {
    const store = await openStore();
    const manager = await startManager();
    const now = vi.fn(() => 1_750_000_000_010);
    const service = new ModelRoutingConfigurationService(store, manager, { now });

    expect(service.read()).toEqual({
      schemaVersion: 1,
      configured: false,
      profileVersion: 0,
      configurationRevisionId: null,
      tiers: null,
      availability: null,
    });

    const saved = service.set({
      commandId: REVISION_1,
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: tiers(),
    });
    expect(saved).toMatchObject({
      configured: true,
      profileVersion: 1,
      configurationRevisionId: REVISION_1,
      availability: {
        fast: "observed_available",
        standard: "observed_available",
        deep: "observed_available",
      },
    });
    expect(store.inspect()).toMatchObject({ eventCount: 1 });
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.tiers?.fast)).toBe(true);
    expect(Object.isFrozen(saved.availability)).toBe(true);
  });

  it("makes complete retries idempotent without taking a second timestamp", async () => {
    const store = await openStore();
    const manager = await startManager();
    const now = vi.fn(() => 1_750_000_000_020);
    const service = new ModelRoutingConfigurationService(store, manager, { now });
    const command = {
      commandId: REVISION_1,
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: tiers(),
    };

    const first = service.set(command);
    expect(service.set(command)).toEqual(first);
    expect(now).toHaveBeenCalledTimes(1);
    expect(store.inspect()).toMatchObject({ eventCount: 1 });

    expect(() => service.set({ ...command, tiers: tiers("-changed") })).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(store.inspect()).toMatchObject({ eventCount: 1 });
  });

  it("enforces optimistic fences and restores the profile after reopening SQLite", async () => {
    const path = await createDatabasePath();
    const firstStore = await openStore(path);
    const manager = await startManager();
    const firstService = new ModelRoutingConfigurationService(firstStore, manager, {
      now: () => 1_750_000_000_030,
    });
    firstService.set({
      commandId: REVISION_1,
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: tiers(),
    });

    expect(() =>
      firstService.set({
        commandId: REVISION_2,
        expectedProfileVersion: 0,
        previousConfigurationRevisionId: null,
        tiers: tiers(),
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));

    firstStore.close();
    const reopenedStore = await openStore(path);
    const reopened = new ModelRoutingConfigurationService(reopenedStore, manager);
    expect(reopened.read()).toMatchObject({
      profileVersion: 1,
      configurationRevisionId: REVISION_1,
      tiers: { fast: { model: "fast-model" } },
    });
  });

  it("rejects hidden, unavailable, and unsupported targets without writing an event", async () => {
    const store = await openStore();
    const manager = await startManager([...visibleModels, model("hidden-model", ["low"], true)]);
    const service = new ModelRoutingConfigurationService(store, manager);
    const candidates = [
      { ...tiers(), fast: { provider: "openai", model: "missing", reasoningEffort: "low" } },
      {
        ...tiers(),
        fast: { provider: "openai", model: "hidden-model", reasoningEffort: "low" },
      },
      {
        ...tiers(),
        fast: { provider: "openai", model: "fast-model", reasoningEffort: "high" },
      },
      { ...tiers(), fast: { provider: "other", model: "fast-model", reasoningEffort: "low" } },
    ];

    for (const candidate of candidates) {
      expect(() =>
        service.set({
          commandId: REVISION_1,
          expectedProfileVersion: 0,
          previousConfigurationRevisionId: null,
          tiers: candidate,
        }),
      ).toThrowError(expect.objectContaining({ code: "conflict" }));
    }
    expect(store.inspect()).toMatchObject({ eventCount: 0 });
  });

  it("fails closed when its catalog owner is no longer ready", async () => {
    const service = new ModelRoutingConfigurationService(await openStore(), await startManager());
    await managers[0]!.close();

    expect(() => service.read()).toThrowError(ModelRoutingConfigurationServiceError);
    expect(() => service.read()).toThrowError(expect.objectContaining({ code: "unavailable" }));
  });
});
