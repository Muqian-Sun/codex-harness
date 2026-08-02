import type { JsonValue } from "@codex-harness/protocol";
import { describe, expect, it } from "vitest";

import type {
  AppServerWorkerCloseResult,
  AppServerWorkerConfig,
  AppServerWorkerState,
} from "./app-server-worker.js";
import {
  AppServerWorkerManager,
  AppServerWorkerManagerError,
  type AppServerWorkerManagerDependencies,
  type ManagedAppServerWorker,
} from "./app-server-worker-manager.js";

const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000601";
const FIRST_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000602";
const SECOND_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000603";
const DUMMY_WORKER_CONFIG = {} as AppServerWorkerConfig;

function model(name: string, effort = "medium"): JsonValue {
  return {
    id: `id-${name}`,
    model: name,
    hidden: false,
    defaultReasoningEffort: effort,
    supportedReasoningEfforts: [{ reasoningEffort: effort }],
    inputModalities: ["text"],
  };
}

function page(data: JsonValue[], nextCursor: string | null): JsonValue {
  return { data, nextCursor };
}

function workerClose(
  containment: AppServerWorkerCloseResult["containment"] = "graceful",
  reason: AppServerWorkerCloseResult["reason"] = "requested",
): AppServerWorkerCloseResult {
  return Object.freeze({
    reason,
    containment,
    exitCode: containment === "graceful" ? 0 : null,
    signal: containment === "sigterm" ? "SIGTERM" : containment === "sigkill" ? "SIGKILL" : null,
    stderrObserved: false,
  });
}

type PendingResponse = JsonValue | Error | Readonly<{ promise: Promise<JsonValue> }>;

class FakeWorker implements ManagedAppServerWorker {
  state: AppServerWorkerState = "ready";
  readonly requests: unknown[] = [];
  readonly #responses: PendingResponse[];
  readonly #closeResult: AppServerWorkerCloseResult;
  readonly closed: Promise<AppServerWorkerCloseResult>;
  #resolveClosed!: (result: AppServerWorkerCloseResult) => void;
  closeCalls = 0;

  constructor(
    responses: readonly PendingResponse[],
    closeResult: AppServerWorkerCloseResult = workerClose(),
  ) {
    this.#responses = [...responses];
    this.#closeResult = closeResult;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async listModels(params: unknown): Promise<JsonValue> {
    this.requests.push(structuredClone(params));
    const response = this.#responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    if (response !== undefined && "promise" in Object(response)) {
      return await (response as Readonly<{ promise: Promise<JsonValue> }>).promise;
    }
    if (response === undefined) {
      throw new Error("missing fake response");
    }
    return response as JsonValue;
  }

  async close(): Promise<AppServerWorkerCloseResult> {
    this.closeCalls += 1;
    if (this.state !== "closed") {
      this.state = "closed";
      this.#resolveClosed(this.#closeResult);
    }
    return this.#closeResult;
  }

  fail(result: AppServerWorkerCloseResult = workerClose("already_exited", "worker_exited")): void {
    if (this.state !== "closed") {
      this.state = "closed";
      this.#resolveClosed(result);
    }
  }
}

function dependencies(
  worker: ManagedAppServerWorker,
  ids: readonly string[] = [WORKER_SESSION_ID, FIRST_SNAPSHOT_ID],
  times: readonly number[] = [1_750_000_000_100],
): AppServerWorkerManagerDependencies {
  const remainingIds = [...ids];
  const remainingTimes = [...times];
  return Object.freeze({
    startWorker: async () => worker,
    newId: () => remainingIds.shift() ?? "missing-id",
    now: () => remainingTimes.shift() ?? -1,
  });
}

async function startManager(
  worker: ManagedAppServerWorker,
  ids?: readonly string[],
  times?: readonly number[],
): Promise<AppServerWorkerManager> {
  return await AppServerWorkerManager.start(
    { provider: "openai", worker: DUMMY_WORKER_CONFIG },
    dependencies(worker, ids, times),
  );
}

describe("AppServerWorkerManager", () => {
  it("closes the complete model pagination chain and brands one current session snapshot", async () => {
    const worker = new FakeWorker([
      page([model("standard")], "page-2"),
      page([model("fast", "low")], null),
    ]);
    const manager = await startManager(worker);

    expect(worker.requests).toEqual([
      { cursor: null, includeHidden: true, limit: 1000 },
      { cursor: "page-2", includeHidden: true, limit: 1000 },
    ]);
    expect(manager.state).toBe("ready");
    expect(manager.provider).toBe("openai");
    expect(manager.workerSessionId).toBe(WORKER_SESSION_ID);
    expect(manager.catalog).toMatchObject({
      snapshotId: FIRST_SNAPSHOT_ID,
      workerSessionId: WORKER_SESSION_ID,
      provider: "openai",
      complete: true,
      includeHidden: true,
      observedAtMs: 1_750_000_000_100,
    });
    expect(manager.catalog?.models.map((entry) => entry.model)).toEqual(["fast", "standard"]);
    expect(manager.isCatalogCurrent(manager.catalog)).toBe(true);
    expect(manager.isCatalogCurrent(structuredClone(manager.catalog))).toBe(false);

    await manager.close();
  });

  it("invalidates immediately while serializing refresh and installs a new snapshot", async () => {
    const pending = deferred<JsonValue>();
    const worker = new FakeWorker([
      page([model("first")], null),
      Object.freeze({ promise: pending.promise }),
    ]);
    const manager = await startManager(
      worker,
      [WORKER_SESSION_ID, FIRST_SNAPSHOT_ID, SECOND_SNAPSHOT_ID],
      [100, 200],
    );
    const oldCatalog = manager.catalog;

    const refresh = manager.refreshCatalog();
    expect(manager.state).toBe("refreshing");
    expect(manager.catalog).toBeNull();
    expect(manager.isCatalogCurrent(oldCatalog)).toBe(false);
    await expect(manager.refreshCatalog()).rejects.toMatchObject({
      code: "refresh_unavailable",
    });

    pending.resolve(page([model("second", "high")], null));
    const refreshed = await refresh;
    expect(refreshed.snapshotId).toBe(SECOND_SNAPSHOT_ID);
    expect(refreshed.workerSessionId).toBe(WORKER_SESSION_ID);
    expect(refreshed.observedAtMs).toBe(200);
    expect(manager.catalog).toBe(refreshed);
    expect(manager.isCatalogCurrent(refreshed)).toBe(true);
    expect(worker.requests).toHaveLength(2);

    await manager.close();
  });

  it("fails closed on a repeated cursor without exposing it", async () => {
    const secretCursor = "secret-cursor";
    const worker = new FakeWorker([
      page([model("first")], secretCursor),
      page([model("second")], secretCursor),
    ]);

    const error = await AppServerWorkerManager.start(
      { provider: "openai", worker: DUMMY_WORKER_CONFIG },
      dependencies(worker),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AppServerWorkerManagerError);
    expect(error).toMatchObject({ code: "catalog_refresh_failed" });
    expect(String(error)).not.toContain(secretCursor);
    expect(worker.closeCalls).toBe(1);
    expect(worker.requests).toHaveLength(2);
  });

  it("bounds a non-closing catalog at 128 pages", async () => {
    const worker = new FakeWorker(
      Array.from({ length: 128 }, (_, index) => page([], `cursor-${index + 1}`)),
    );

    await expect(startManager(worker)).rejects.toMatchObject({
      code: "catalog_refresh_failed",
    });
    expect(worker.requests).toHaveLength(128);
    expect(worker.closeCalls).toBe(1);
  });

  it("rejects more than 10,000 models before retaining additional pages", async () => {
    const oversizedModels = Array.from({ length: 10_001 }, (_, index) => model(`model-${index}`));
    const worker = new FakeWorker([page(oversizedModels, null)]);

    await expect(startManager(worker)).rejects.toMatchObject({
      code: "catalog_refresh_failed",
    });
    expect(worker.requests).toHaveLength(1);
    expect(worker.closeCalls).toBe(1);
  });

  it.each([
    ["malformed cursor", { data: [], nextCursor: 7 } as unknown as JsonValue],
    ["invalid model", page([{ id: "id", model: "model" }], null)],
  ])("fails closed for %s", async (_name, response) => {
    const worker = new FakeWorker([response]);

    await expect(startManager(worker)).rejects.toMatchObject({
      code: "catalog_refresh_failed",
    });
    expect(worker.closeCalls).toBe(1);
  });

  it("fails closed when a model request rejects", async () => {
    const worker = new FakeWorker([new Error("private backend error")]);

    const error = await startManager(worker).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "catalog_refresh_failed" });
    expect(String(error)).not.toContain("private backend error");
    expect(worker.closeCalls).toBe(1);
  });

  it("invalidates the catalog when the worker closes unexpectedly", async () => {
    const worker = new FakeWorker([page([model("first")], null)]);
    const manager = await startManager(worker);
    expect(manager.catalog).not.toBeNull();

    worker.fail();
    await expect(manager.closed).resolves.toMatchObject({
      reason: "worker_failure",
      workerSessionId: WORKER_SESSION_ID,
      containment: "already_exited",
    });
    expect(manager.state).toBe("closed");
    expect(manager.catalog).toBeNull();
  });

  it("closes idempotently and preserves worker containment evidence", async () => {
    const worker = new FakeWorker(
      [page([model("first")], null)],
      workerClose("containment_unknown"),
    );
    const manager = await startManager(worker);

    const [first, second] = await Promise.all([manager.close(), manager.close()]);
    expect(first).toBe(second);
    expect(first).toMatchObject({
      reason: "requested",
      containment: "containment_unknown",
      workerSessionId: WORKER_SESSION_ID,
    });
    expect(worker.closeCalls).toBe(1);
    expect(manager.catalog).toBeNull();
    await expect(manager.refreshCatalog()).rejects.toMatchObject({ code: "closed" });
  });

  it("does not expose an invalid close result returned by a test worker", async () => {
    const worker = new FakeWorker([page([model("first")], null)], {
      ...workerClose(),
      containment: "invalid-containment",
      signal: "PRIVATE_SIGNAL",
    } as unknown as AppServerWorkerCloseResult);
    const manager = await startManager(worker);

    await expect(manager.close()).resolves.toMatchObject({
      reason: "requested",
      containment: "containment_unknown",
      signal: null,
    });
  });

  it("rejects invalid configuration and start dependencies without leaking a worker", async () => {
    const worker = new FakeWorker([page([], null)]);
    const startWorkerCalls: AppServerWorkerConfig[] = [];
    const invalidIdDependencies: AppServerWorkerManagerDependencies = Object.freeze({
      startWorker: async (config) => {
        startWorkerCalls.push(config);
        return worker;
      },
      newId: () => "not-a-uuid",
      now: () => 1,
    });

    await expect(
      AppServerWorkerManager.start(
        { provider: " openai", worker: DUMMY_WORKER_CONFIG },
        dependencies(worker),
      ),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      AppServerWorkerManager.start(
        { provider: "openai", worker: DUMMY_WORKER_CONFIG },
        invalidIdDependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(startWorkerCalls).toHaveLength(0);
    expect(worker.closeCalls).toBe(0);

    const startFailureDependencies: AppServerWorkerManagerDependencies = Object.freeze({
      startWorker: async () => {
        throw new Error("private executable path");
      },
      newId: () => WORKER_SESSION_ID,
      now: () => 1,
    });
    const error = await AppServerWorkerManager.start(
      { provider: "openai", worker: DUMMY_WORKER_CONFIG },
      startFailureDependencies,
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "worker_start_failed" });
    expect(String(error)).not.toContain("private executable path");
  });

  it("closes a worker when snapshot identity or observation time generation fails", async () => {
    const invalidSnapshotId = new FakeWorker([page([], null)]);
    await expect(
      startManager(invalidSnapshotId, [WORKER_SESSION_ID, "invalid-snapshot-id"], [1]),
    ).rejects.toMatchObject({ code: "catalog_refresh_failed" });
    expect(invalidSnapshotId.closeCalls).toBe(1);

    const invalidTime = new FakeWorker([page([], null)]);
    await expect(
      startManager(invalidTime, [WORKER_SESSION_ID, FIRST_SNAPSHOT_ID], [-1]),
    ).rejects.toMatchObject({ code: "catalog_refresh_failed" });
    expect(invalidTime.closeCalls).toBe(1);
  });
});

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return Object.freeze({ promise, resolve });
}
