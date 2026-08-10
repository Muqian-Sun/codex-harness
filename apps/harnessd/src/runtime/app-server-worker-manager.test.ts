import type { JsonValue } from "@codex-harness/protocol";
import { describe, expect, it } from "vitest";

import type {
  AppServerReadOnlyAnalysisInput,
  AppServerWorkerCloseResult,
  AppServerWorkerConfig,
  AppServerWorkerEvent,
  AppServerWorkerState,
} from "./app-server-worker.js";
import {
  AppServerWorkerManager,
  AppServerWorkerManagerError,
  type AppServerWorkerManagerDependencies,
  type ManagedAppServerWorker,
} from "./app-server-worker-manager.js";

const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000601";
const FIRST_CATALOG_ID = "00000000-0000-4000-8000-000000000602";
const FIRST_ACCOUNT_ID = "00000000-0000-4000-8000-000000000603";
const SECOND_CATALOG_ID = "00000000-0000-4000-8000-000000000604";
const SECOND_ACCOUNT_ID = "00000000-0000-4000-8000-000000000605";
const THIRD_ACCOUNT_ID = "00000000-0000-4000-8000-000000000606";
const DUMMY_WORKER_CONFIG = {} as AppServerWorkerConfig;

const SIGNED_OUT_ACCOUNT: JsonValue = Object.freeze({
  account: null,
  requiresOpenaiAuth: true,
});

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
  readonly accountRequests: number[] = [];
  readonly #accountResponses: PendingResponse[];
  readonly #closeResult: AppServerWorkerCloseResult;
  readonly closed: Promise<AppServerWorkerCloseResult>;
  #resolveClosed!: (result: AppServerWorkerCloseResult) => void;
  closeCalls = 0;
  readonly analysisRequests: AppServerReadOnlyAnalysisInput[] = [];
  analysisFailure = false;

  constructor(
    responses: readonly PendingResponse[],
    closeResult: AppServerWorkerCloseResult = workerClose(),
    accountResponses: readonly PendingResponse[] = [SIGNED_OUT_ACCOUNT],
  ) {
    this.#responses = [...responses];
    this.#accountResponses = [...accountResponses];
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

  async readAccount(): Promise<JsonValue> {
    this.accountRequests.push(this.accountRequests.length + 1);
    const response = this.#accountResponses.shift();
    if (response instanceof Error) {
      throw response;
    }
    if (response !== undefined && "promise" in Object(response)) {
      return await (response as Readonly<{ promise: Promise<JsonValue> }>).promise;
    }
    if (response === undefined) {
      throw new Error("missing fake account response");
    }
    return response as JsonValue;
  }

  async runReadOnlyAnalysisTurn(input: AppServerReadOnlyAnalysisInput) {
    this.analysisRequests.push(structuredClone(input));
    if (this.analysisFailure) {
      throw new Error("private analysis failure");
    }
    return Object.freeze({ threadId: "thread-1", turnId: "turn-1", output: { ok: true } });
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
  ids: readonly string[] = [WORKER_SESSION_ID, FIRST_CATALOG_ID, FIRST_ACCOUNT_ID],
  times: readonly number[] = [1_750_000_000_100, 1_750_000_000_101],
  onStart?: (config: AppServerWorkerConfig) => void | Promise<void>,
): AppServerWorkerManagerDependencies {
  const remainingIds = [...ids];
  const remainingTimes = [...times];
  return Object.freeze({
    startWorker: async (config) => {
      await onStart?.(config);
      return worker;
    },
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
  it("runs one analysis only for an observed visible model target", async () => {
    const worker = new FakeWorker([page([model("deep", "high")], null)]);
    const manager = await startManager(worker);
    const input = {
      cwd: "/Users/example/project",
      modelProvider: "openai",
      model: "deep",
      reasoningEffort: "high",
      prompt: "Build a candidate plan.",
      outputSchema: { type: "object" },
    } as const;

    await expect(manager.runReadOnlyAnalysisTurn(input)).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(worker.analysisRequests).toEqual([input]);
    for (const invalid of [
      { ...input, modelProvider: "other" },
      { ...input, model: "missing" },
      { ...input, reasoningEffort: "low" },
    ]) {
      await expect(manager.runReadOnlyAnalysisTurn(invalid)).rejects.toMatchObject({
        code: "analysis_unavailable",
      });
    }
    worker.analysisFailure = true;
    await expect(manager.runReadOnlyAnalysisTurn(input)).rejects.toMatchObject({
      code: "analysis_unavailable",
    });
    await manager.close();
    await expect(manager.runReadOnlyAnalysisTurn(input)).rejects.toMatchObject({ code: "closed" });

    const imageOnlyWorker = new FakeWorker([
      page(
        [
          {
            ...(model("deep", "high") as Record<string, JsonValue>),
            inputModalities: ["image"],
          },
        ],
        null,
      ),
    ]);
    const imageOnlyManager = await startManager(imageOnlyWorker);
    await expect(imageOnlyManager.runReadOnlyAnalysisTurn(input)).rejects.toMatchObject({
      code: "analysis_unavailable",
    });
    await imageOnlyManager.close();
  });

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
      snapshotId: FIRST_CATALOG_ID,
      workerSessionId: WORKER_SESSION_ID,
      provider: "openai",
      complete: true,
      includeHidden: true,
      observedAtMs: 1_750_000_000_100,
    });
    expect(manager.catalog?.models.map((entry) => entry.model)).toEqual(["fast", "standard"]);
    expect(manager.isCatalogCurrent(manager.catalog)).toBe(true);
    expect(manager.isCatalogCurrent(structuredClone(manager.catalog))).toBe(false);
    expect(manager.accountStatus).toEqual({
      schemaVersion: 1,
      snapshotId: FIRST_ACCOUNT_ID,
      workerSessionId: WORKER_SESSION_ID,
      observedAtMs: 1_750_000_000_101,
      status: "authentication_required",
      credentialKind: null,
      planType: null,
    });
    expect(manager.isAccountStatusCurrent(manager.accountStatus)).toBe(true);
    expect(manager.isAccountStatusCurrent(structuredClone(manager.accountStatus))).toBe(false);
    expect(worker.accountRequests).toHaveLength(1);

    await manager.close();
  });

  it("reads a frozen visible-only public catalog page with a snapshot-bound cursor", async () => {
    const hidden = { ...(model("hidden") as Record<string, JsonValue>), hidden: true };
    const worker = new FakeWorker([page([model("standard"), hidden, model("fast", "low")], null)]);
    const manager = await startManager(worker);

    const first = manager.readCatalogPage({ cursor: null, limit: 1 });
    expect(first).toMatchObject({
      schemaVersion: 1,
      provider: "openai",
      totalVisibleModels: 2,
      models: [
        {
          model: "fast",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low"],
          inputModalities: ["text"],
        },
      ],
    });
    expect(first.nextCursor).toMatch(/^00000000-0000-4000-8000-000000000602\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(first)).not.toContain("id-fast");
    expect(JSON.stringify(first)).not.toContain("hidden");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.models)).toBe(true);
    expect(Object.isFrozen(first.models[0])).toBe(true);

    const second = manager.readCatalogPage({ cursor: first.nextCursor, limit: 1 });
    expect(second.models.map((entry) => entry.model)).toEqual(["standard"]);
    expect(second.nextCursor).toBeNull();

    await manager.close();
  });

  it("returns an empty page for a valid catalog containing only hidden models", async () => {
    const hidden = { ...(model("hidden") as Record<string, JsonValue>), hidden: true };
    const manager = await startManager(new FakeWorker([page([hidden], null)]));

    expect(manager.readCatalogPage({ cursor: null, limit: 16 })).toEqual({
      schemaVersion: 1,
      provider: "openai",
      totalVisibleModels: 0,
      models: [],
      nextCursor: null,
    });

    await manager.close();
  });

  it("rejects malformed and stale public catalog cursors without leaking them", async () => {
    const worker = new FakeWorker([
      page([model("first"), model("second")], null),
      page([model("refreshed")], null),
    ]);
    const manager = await startManager(
      worker,
      [WORKER_SESSION_ID, FIRST_CATALOG_ID, FIRST_ACCOUNT_ID, SECOND_CATALOG_ID],
      [100, 101, 200],
    );
    const first = manager.readCatalogPage({ cursor: null, limit: 1 });
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();

    for (const invalid of [
      { cursor: "private-invalid-cursor", limit: 1 },
      { cursor: null, limit: 17 },
      { cursor: null, limit: 1, unexpected: true },
    ]) {
      const error = capture(() => manager.readCatalogPage(invalid));
      expect(error).toMatchObject({ code: "catalog_page_unavailable" });
      expect(String(error)).not.toContain("private-invalid-cursor");
    }

    await manager.refreshCatalog();
    expect(() => manager.readCatalogPage({ cursor, limit: 1 })).toThrowError(
      expect.objectContaining({ code: "catalog_page_unavailable" }),
    );

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
      [WORKER_SESSION_ID, FIRST_CATALOG_ID, FIRST_ACCOUNT_ID, SECOND_CATALOG_ID],
      [100, 101, 200],
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
    expect(refreshed.snapshotId).toBe(SECOND_CATALOG_ID);
    expect(refreshed.workerSessionId).toBe(WORKER_SESSION_ID);
    expect(refreshed.observedAtMs).toBe(200);
    expect(manager.catalog).toBe(refreshed);
    expect(manager.isCatalogCurrent(refreshed)).toBe(true);
    expect(worker.requests).toHaveLength(2);

    await manager.close();
  });

  it("serializes account refresh, preserves the catalog, and invalidates the old snapshot", async () => {
    const pending = deferred<JsonValue>();
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      SIGNED_OUT_ACCOUNT,
      Object.freeze({ promise: pending.promise }),
      {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    ]);
    let onEvent: AppServerWorkerConfig["onEvent"];
    const manager = await AppServerWorkerManager.start(
      { provider: "openai", worker: DUMMY_WORKER_CONFIG },
      dependencies(
        worker,
        [
          WORKER_SESSION_ID,
          FIRST_CATALOG_ID,
          FIRST_ACCOUNT_ID,
          SECOND_ACCOUNT_ID,
          THIRD_ACCOUNT_ID,
        ],
        [100, 101, 300, 301],
        (config) => {
          onEvent = config.onEvent;
        },
      ),
    );
    const catalog = manager.catalog;
    const oldAccount = manager.accountStatus;

    const refresh = manager.refreshAccountStatus();
    expect(manager.state).toBe("refreshing_account");
    expect(manager.accountStatus).toBeNull();
    expect(manager.isAccountStatusCurrent(oldAccount)).toBe(false);
    expect(manager.catalog).toBe(catalog);
    expect(manager.isCatalogCurrent(catalog)).toBe(true);
    await expect(manager.refreshAccountStatus()).rejects.toMatchObject({
      code: "refresh_unavailable",
    });
    await expect(manager.refreshCatalog()).rejects.toMatchObject({
      code: "refresh_unavailable",
    });
    await onEvent?.({ type: "account_updated" });
    expect(worker.accountRequests).toHaveLength(2);

    pending.resolve({
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    const refreshed = await refresh;
    expect(refreshed).toMatchObject({
      snapshotId: THIRD_ACCOUNT_ID,
      workerSessionId: WORKER_SESSION_ID,
      observedAtMs: 301,
      status: "authenticated",
      credentialKind: "chatgpt",
      planType: "pro",
    });
    expect(manager.accountStatus).toBe(refreshed);
    expect(manager.isAccountStatusCurrent(refreshed)).toBe(true);
    expect(worker.accountRequests).toHaveLength(3);

    await manager.close();
  });

  it("publishes every newly installed account snapshot and supports idempotent unsubscribe", async () => {
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      SIGNED_OUT_ACCOUNT,
      {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      },
      {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    ]);
    const manager = await startManager(
      worker,
      [WORKER_SESSION_ID, FIRST_CATALOG_ID, FIRST_ACCOUNT_ID, SECOND_ACCOUNT_ID, THIRD_ACCOUNT_ID],
      [100, 101, 102, 103],
    );
    const published: unknown[] = [];
    const listener = (snapshot: unknown): void => {
      published.push(snapshot);
    };
    const unsubscribeFirst = manager.subscribeAccountStatusChanges(listener);
    const unsubscribeSecond = manager.subscribeAccountStatusChanges(listener);
    unsubscribeFirst();
    unsubscribeFirst();

    const first = await manager.refreshAccountStatus();
    expect(published).toEqual([first]);
    expect(first.planType).toBe("pro");

    unsubscribeSecond();
    unsubscribeSecond();
    const second = await manager.refreshAccountStatus();
    expect(second.snapshotId).toBe(THIRD_ACCOUNT_ID);
    expect(second.planType).toBe("pro");
    expect(published).toEqual([first]);

    await manager.close();
  });

  it("fails closed and withdraws snapshots when an account snapshot listener throws", async () => {
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      SIGNED_OUT_ACCOUNT,
      {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    ]);
    const manager = await startManager(
      worker,
      [WORKER_SESSION_ID, FIRST_CATALOG_ID, FIRST_ACCOUNT_ID, SECOND_ACCOUNT_ID],
      [100, 101, 102],
    );
    manager.subscribeAccountStatusChanges(() => {
      throw new Error("private desktop listener error");
    });

    const error = await manager.refreshAccountStatus().catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: "account_snapshot_failed" });
    expect(String(error)).not.toContain("private desktop listener error");
    await expect(manager.closed).resolves.toMatchObject({ reason: "account_snapshot_failed" });
    expect(manager.catalog).toBeNull();
    expect(manager.accountStatus).toBeNull();
  });

  it("re-reads the authoritative account snapshot when an update arrives during startup", async () => {
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      SIGNED_OUT_ACCOUNT,
      {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    ]);
    const manager = await AppServerWorkerManager.start(
      { provider: "openai", worker: DUMMY_WORKER_CONFIG },
      dependencies(
        worker,
        [WORKER_SESSION_ID, FIRST_CATALOG_ID, FIRST_ACCOUNT_ID, SECOND_ACCOUNT_ID],
        [100, 101, 102],
        async (config) => {
          await config.onEvent?.({ type: "account_updated" });
        },
      ),
    );

    expect(worker.accountRequests).toHaveLength(2);
    expect(manager.accountStatus).toMatchObject({
      snapshotId: SECOND_ACCOUNT_ID,
      observedAtMs: 102,
      status: "authenticated",
      credentialKind: "chatgpt",
      planType: "pro",
    });

    await manager.close();
  });

  it("invalidates immediately and coalesces repeated updates within one account read", async () => {
    const pending = deferred<JsonValue>();
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      SIGNED_OUT_ACCOUNT,
      Object.freeze({ promise: pending.promise }),
      {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    ]);
    let onEvent: AppServerWorkerConfig["onEvent"];
    const manager = await AppServerWorkerManager.start(
      { provider: "openai", worker: DUMMY_WORKER_CONFIG },
      dependencies(
        worker,
        [
          WORKER_SESSION_ID,
          FIRST_CATALOG_ID,
          FIRST_ACCOUNT_ID,
          SECOND_ACCOUNT_ID,
          THIRD_ACCOUNT_ID,
        ],
        [100, 101, 102, 103],
        (config) => {
          onEvent = config.onEvent;
        },
      ),
    );
    const oldAccount = manager.accountStatus;
    const publishedAccountIds: string[] = [];
    manager.subscribeAccountStatusChanges((snapshot) => {
      publishedAccountIds.push(snapshot.snapshotId);
    });

    const firstUpdate = Promise.resolve(onEvent?.({ type: "account_updated" }));
    expect(manager.state).toBe("refreshing_account");
    expect(manager.accountStatus).toBeNull();
    expect(manager.isAccountStatusCurrent(oldAccount)).toBe(false);
    const repeatedUpdates = [
      Promise.resolve(onEvent?.({ type: "account_updated" })),
      Promise.resolve(onEvent?.({ type: "account_updated" })),
    ];
    expect(worker.accountRequests).toHaveLength(2);

    pending.resolve({
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    await Promise.all([firstUpdate, ...repeatedUpdates]);

    expect(worker.accountRequests).toHaveLength(3);
    expect(manager.state).toBe("ready");
    expect(manager.accountStatus).toMatchObject({
      snapshotId: THIRD_ACCOUNT_ID,
      observedAtMs: 103,
      planType: "pro",
    });
    expect(publishedAccountIds).toEqual([SECOND_ACCOUNT_ID, THIRD_ACCOUNT_ID]);

    await manager.close();
  });

  it("defers an account update until an in-flight catalog refresh is complete", async () => {
    const pendingCatalog = deferred<JsonValue>();
    const worker = new FakeWorker(
      [page([model("first")], null), Object.freeze({ promise: pendingCatalog.promise })],
      workerClose(),
      [
        SIGNED_OUT_ACCOUNT,
        {
          account: { type: "chatgpt", planType: "team" },
          requiresOpenaiAuth: true,
        },
      ],
    );
    let onEvent: AppServerWorkerConfig["onEvent"];
    const manager = await AppServerWorkerManager.start(
      { provider: "openai", worker: DUMMY_WORKER_CONFIG },
      dependencies(
        worker,
        [
          WORKER_SESSION_ID,
          FIRST_CATALOG_ID,
          FIRST_ACCOUNT_ID,
          SECOND_CATALOG_ID,
          SECOND_ACCOUNT_ID,
        ],
        [100, 101, 102, 103],
        (config) => {
          onEvent = config.onEvent;
        },
      ),
    );
    const oldAccount = manager.accountStatus;

    const catalogRefresh = manager.refreshCatalog();
    await onEvent?.({ type: "account_updated" });
    expect(manager.state).toBe("refreshing");
    expect(manager.accountStatus).toBe(oldAccount);
    expect(worker.accountRequests).toHaveLength(1);

    pendingCatalog.resolve(page([model("second")], null));
    await catalogRefresh;

    expect(worker.accountRequests).toHaveLength(2);
    expect(manager.state).toBe("ready");
    expect(manager.accountStatus).toMatchObject({
      snapshotId: SECOND_ACCOUNT_ID,
      observedAtMs: 103,
      planType: "team",
    });

    await manager.close();
  });

  it("fails closed when a notification-triggered authoritative re-read fails", async () => {
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      SIGNED_OUT_ACCOUNT,
      new Error("private notification refresh error"),
    ]);
    let onEvent: AppServerWorkerConfig["onEvent"];
    const manager = await AppServerWorkerManager.start(
      { provider: "openai", worker: DUMMY_WORKER_CONFIG },
      dependencies(worker, undefined, undefined, (config) => {
        onEvent = config.onEvent;
      }),
    );

    const error = await Promise.resolve(onEvent?.({ type: "account_updated" })).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "account_snapshot_failed" });
    expect(String(error)).not.toContain("private notification refresh error");
    await expect(manager.closed).resolves.toMatchObject({ reason: "account_snapshot_failed" });
    expect(manager.state).toBe("closed");
    expect(manager.catalog).toBeNull();
    expect(manager.accountStatus).toBeNull();
  });

  it("preserves the configured event handler for non-account events", async () => {
    const forwarded: AppServerWorkerEvent[] = [];
    let onEvent: AppServerWorkerConfig["onEvent"];
    const worker = new FakeWorker([page([model("first")], null)]);
    const manager = await AppServerWorkerManager.start(
      {
        provider: "openai",
        worker: {
          ...DUMMY_WORKER_CONFIG,
          onEvent: (event) => {
            forwarded.push(event);
          },
        },
      },
      dependencies(worker, undefined, undefined, (config) => {
        onEvent = config.onEvent;
      }),
    );
    const event: AppServerWorkerEvent = {
      type: "notification",
      method: "future/event",
      params: { future: true },
    };

    await onEvent?.(event);

    expect(forwarded).toEqual([event]);
    expect(worker.accountRequests).toHaveLength(1);

    await manager.close();
  });

  it("fails closed without publishing a partial ready state when account observation fails", async () => {
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      new Error("private account error"),
    ]);

    const error = await startManager(worker).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "account_snapshot_failed" });
    expect(String(error)).not.toContain("private account error");
    expect(worker.closeCalls).toBe(1);
    expect(worker.accountRequests).toHaveLength(1);
  });

  it("fails closed and withdraws the catalog when account refresh fails", async () => {
    const worker = new FakeWorker([page([model("first")], null)], workerClose(), [
      SIGNED_OUT_ACCOUNT,
      new Error("private refresh error"),
    ]);
    const manager = await startManager(worker);
    expect(manager.catalog).not.toBeNull();

    const error = await manager.refreshAccountStatus().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "account_snapshot_failed" });
    expect(String(error)).not.toContain("private refresh error");
    await expect(manager.closed).resolves.toMatchObject({ reason: "account_snapshot_failed" });
    expect(manager.state).toBe("closed");
    expect(manager.catalog).toBeNull();
    expect(manager.accountStatus).toBeNull();
    expect(worker.closeCalls).toBe(1);
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
    expect(manager.accountStatus).toBeNull();
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
    expect(manager.accountStatus).toBeNull();
    await expect(manager.refreshCatalog()).rejects.toMatchObject({ code: "closed" });
    await expect(manager.refreshAccountStatus()).rejects.toMatchObject({ code: "closed" });
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
      startManager(invalidTime, [WORKER_SESSION_ID, FIRST_CATALOG_ID], [-1]),
    ).rejects.toMatchObject({ code: "catalog_refresh_failed" });
    expect(invalidTime.closeCalls).toBe(1);

    const invalidAccountSnapshotId = new FakeWorker([page([], null)]);
    await expect(
      startManager(
        invalidAccountSnapshotId,
        [WORKER_SESSION_ID, FIRST_CATALOG_ID, "invalid-account-snapshot-id"],
        [1, 2],
      ),
    ).rejects.toMatchObject({ code: "account_snapshot_failed" });
    expect(invalidAccountSnapshotId.closeCalls).toBe(1);

    const invalidAccountTime = new FakeWorker([page([], null)]);
    await expect(
      startManager(
        invalidAccountTime,
        [WORKER_SESSION_ID, FIRST_CATALOG_ID, FIRST_ACCOUNT_ID],
        [1, -1],
      ),
    ).rejects.toMatchObject({ code: "account_snapshot_failed" });
    expect(invalidAccountTime.closeCalls).toBe(1);
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

function capture(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the callback to throw.");
}
