import { describe, expect, it, vi } from "vitest";

import { DaemonProcessSupervisorError } from "../main/daemon-process-supervisor.js";
import type { DaemonProcessSupervisorCloseResult } from "../main/daemon-process-supervisor.js";
import { HarnessRpcClientError } from "../main/harness-rpc-client.js";
import { BootstrapStateStore } from "../shared/bootstrap-state.js";
import {
  DesktopApplicationController,
  mapBootstrapFailure,
  type DesktopApplicationControllerConfig,
  type DesktopSupervisorHandle,
} from "./application-controller.js";
import { DesktopRuntimeResourceError } from "./runtime-resources.js";

const ACCOUNT_STATUS = Object.freeze({
  schemaVersion: 1 as const,
  snapshotId: "00000000-0000-4000-8000-000000000841",
  workerSessionId: "00000000-0000-4000-8000-000000000842",
  observedAtMs: 1_750_000_000_001,
  status: "authenticated" as const,
  credentialKind: "chatgpt" as const,
  planType: "plus" as const,
});

const UPDATED_ACCOUNT_STATUS = Object.freeze({
  ...ACCOUNT_STATUS,
  snapshotId: "00000000-0000-4000-8000-000000000843",
  observedAtMs: 1_750_000_000_002,
  planType: "pro" as const,
});

const MODEL_CATALOG_PAGE = Object.freeze({
  schemaVersion: 1 as const,
  provider: "openai",
  totalVisibleModels: 2,
  models: Object.freeze([
    Object.freeze({
      model: "gpt-standard",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high"]),
      inputModalities: Object.freeze(["text", "image"] as const),
    }),
    Object.freeze({
      model: "gpt-fast",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: Object.freeze(["low"]),
      inputModalities: Object.freeze(["text"] as const),
    }),
  ]),
  nextCursor: null,
});

const CATALOG_SUMMARY = Object.freeze({
  provider: "openai",
  totalVisibleModels: 2,
  models: MODEL_CATALOG_PAGE.models,
  hasMore: false,
});

const ROUTING_CONFIGURATION = Object.freeze({
  schemaVersion: 1 as const,
  configured: false,
  profileVersion: 0,
  configurationRevisionId: null,
  tiers: null,
  availability: null,
});

const ROUTING_SUMMARY = Object.freeze({
  configured: false,
  profileVersion: 0,
  configurationRevisionId: null,
  tiers: null,
  availability: null,
});

const CONFIGURED_ROUTING = Object.freeze({
  schemaVersion: 1 as const,
  configured: true,
  profileVersion: 1,
  configurationRevisionId: "00000000-0000-4000-8000-000000000871",
  tiers: Object.freeze({
    fast: Object.freeze({ provider: "openai", model: "gpt-fast", reasoningEffort: "low" }),
    standard: Object.freeze({
      provider: "openai",
      model: "gpt-standard",
      reasoningEffort: "medium",
    }),
    deep: Object.freeze({ provider: "openai", model: "gpt-standard", reasoningEffort: "high" }),
  }),
  availability: Object.freeze({
    fast: "observed_available" as const,
    standard: "observed_available" as const,
    deep: "observed_available" as const,
  }),
});

function routingMethods(): Pick<
  DesktopSupervisorHandle,
  "readRoutingConfiguration" | "setRoutingConfiguration"
> {
  return {
    readRoutingConfiguration: vi.fn(async () => ROUTING_CONFIGURATION),
    setRoutingConfiguration: vi.fn(async () => ROUTING_CONFIGURATION),
  };
}

function accountObservation(
  account = ACCOUNT_STATUS,
  observedThroughSequence = 0,
): Awaited<ReturnType<DesktopSupervisorHandle["readAccountStatusObservation"]>> {
  return Object.freeze({ account, observedThroughSequence });
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function closeResult(
  containment: DaemonProcessSupervisorCloseResult["containment"],
): DaemonProcessSupervisorCloseResult {
  return Object.freeze({
    expected: true,
    exitCode: 0,
    signal: null,
    containment,
    endpointCleanup: "removed",
    runtimeDirectoryCleanup: "removed",
  });
}

describe("desktop application controller", () => {
  it("starts exactly one supervisor and publishes readiness", async () => {
    const stateStore = new BootstrapStateStore();
    const closed = deferred<ReturnType<typeof closeResult>>();
    const supervisor: DesktopSupervisorHandle = {
      closed: closed.promise,
      readAccountStatusObservation: vi.fn(async () => accountObservation()),
      readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
      ...routingMethods(),
      stop: vi.fn(async () => closeResult("graceful")),
    };
    const createSupervisor = vi.fn(async () => supervisor);
    const controller = new DesktopApplicationController({ stateStore, createSupervisor });

    await Promise.all([controller.start(), controller.start()]);
    expect(createSupervisor).toHaveBeenCalledTimes(1);
    expect(supervisor.readModelCatalogPage).toHaveBeenCalledExactlyOnceWith({
      cursor: null,
      limit: 12,
    });
    expect(supervisor.readRoutingConfiguration).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "plus" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
    });

    closed.resolve(closeResult("graceful"));
    await closed.promise;
    await Promise.resolve();
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_unavailable" });
  });

  it("saves a routing update through a main-owned command identifier", async () => {
    const stateStore = new BootstrapStateStore();
    const setRoutingConfiguration = vi.fn(async () => CONFIGURED_ROUTING);
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readRoutingConfiguration: vi.fn(async () => ROUTING_CONFIGURATION),
        setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    const result = await controller.setRoutingConfiguration({
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: CONFIGURED_ROUTING.tiers,
    });
    expect(result).toMatchObject({ status: "saved", routing: { profileVersion: 1 } });
    expect(setRoutingConfiguration).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: CONFIGURED_ROUTING.tiers,
    });
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      routing: { profileVersion: 1, configured: true },
    });
    expect(JSON.stringify(result)).not.toContain("schemaVersion");
  });

  it("refreshes current routing after an optimistic write conflict", async () => {
    const stateStore = new BootstrapStateStore();
    const readRoutingConfiguration = vi
      .fn()
      .mockResolvedValueOnce(ROUTING_CONFIGURATION)
      .mockResolvedValueOnce(CONFIGURED_ROUTING);
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readRoutingConfiguration,
        setRoutingConfiguration: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "rpc.conflict");
        }),
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    const result = await controller.setRoutingConfiguration({
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: CONFIGURED_ROUTING.tiers,
    });
    expect(result).toMatchObject({ status: "conflict", routing: { profileVersion: 1 } });
    expect(readRoutingConfiguration).toHaveBeenCalledTimes(2);
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      routing: { profileVersion: 1 },
    });
  });

  it("waits for an in-flight start before stopping and never publishes transient readiness", async () => {
    const stateStore = new BootstrapStateStore();
    const supervisorReady = deferred<DesktopSupervisorHandle>();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => await supervisorReady.promise,
    });

    const starting = controller.start();
    const stopping = controller.stop();
    expect(stateStore.current).toEqual({ phase: "stopping" });
    supervisorReady.resolve({
      closed: new Promise(() => undefined),
      readAccountStatusObservation: vi.fn(async () => accountObservation()),
      readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
      ...routingMethods(),
      stop,
    });

    await expect(stopping).resolves.toBe(0);
    await starting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "stopping" });
  });

  it("waits for an in-flight account read without publishing transient readiness", async () => {
    const stateStore = new BootstrapStateStore();
    const accountStatus = deferred<ReturnType<typeof accountObservation>>();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: async () => await accountStatus.promise,
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...routingMethods(),
        stop,
      }),
    });

    const starting = controller.start();
    await Promise.resolve();
    const stopping = controller.stop();
    expect(stateStore.current).toEqual({ phase: "stopping" });
    accountStatus.resolve(accountObservation());

    await starting;
    await expect(stopping).resolves.toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "stopping" });
  });

  it("returns a non-zero exit status when containment cannot be proven", async () => {
    const stateStore = new BootstrapStateStore();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...routingMethods(),
        stop: async () => closeResult("containment_unknown"),
      }),
    });

    await controller.start();
    await expect(controller.stop()).resolves.toBe(1);
  });

  it("stops the supervisor and never publishes ready when account status fails", async () => {
    const stateStore = new BootstrapStateStore();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "service.unavailable");
        }),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...routingMethods(),
        stop,
      }),
    });

    await controller.start();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_startup_failed" });
  });

  it("stops the supervisor and never publishes ready when the model catalog fails", async () => {
    const stateStore = new BootstrapStateStore();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "service.unavailable");
        }),
        ...routingMethods(),
        stop,
      }),
    });

    await controller.start();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_startup_failed" });
  });

  it("uses the RPC snapshot when a cached startup event is already covered by its sequence barrier", async () => {
    const stateStore = new BootstrapStateStore();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async (onAccountStatusChanged) => {
        onAccountStatusChanged(Object.freeze({ sequence: 1, account: UPDATED_ACCOUNT_STATUS }));
        return {
          closed: new Promise(() => undefined),
          readAccountStatusObservation: async () => accountObservation(ACCOUNT_STATUS, 1),
          readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
          ...routingMethods(),
          stop: async () => closeResult("graceful"),
        };
      },
    });

    await controller.start();

    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "plus" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
    });
  });

  it("uses a startup event that follows the RPC response barrier", async () => {
    const stateStore = new BootstrapStateStore();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async (onAccountStatusChanged) => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: async () => {
          onAccountStatusChanged(Object.freeze({ sequence: 2, account: UPDATED_ACCOUNT_STATUS }));
          return accountObservation(ACCOUNT_STATUS, 1);
        },
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...routingMethods(),
        stop: async () => closeResult("graceful"),
      }),
    });

    await controller.start();

    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "pro" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
    });
  });

  it("updates ready account state from later events and ignores updates while stopping", async () => {
    const stateStore = new BootstrapStateStore();
    let observeAccountStatusChanged:
      Parameters<DesktopApplicationControllerConfig["createSupervisor"]>[0] | undefined;
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async (listener) => {
        observeAccountStatusChanged = listener;
        return {
          closed: new Promise(() => undefined),
          readAccountStatusObservation: async () => accountObservation(),
          readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
          ...routingMethods(),
          stop: async () => closeResult("graceful"),
        };
      },
    });
    await controller.start();

    observeAccountStatusChanged?.(Object.freeze({ sequence: 1, account: UPDATED_ACCOUNT_STATUS }));
    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "pro" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
    });

    await controller.stop();
    observeAccountStatusChanged?.(Object.freeze({ sequence: 2, account: ACCOUNT_STATUS }));
    expect(stateStore.current).toEqual({ phase: "stopping" });
  });

  it("maps only stable failure codes", async () => {
    expect(
      mapBootstrapFailure(new DesktopRuntimeResourceError("resource_configuration_missing")),
    ).toBe("resource_configuration_missing");
    expect(mapBootstrapFailure(new DaemonProcessSupervisorError("unsupported_platform"))).toBe(
      "unsupported_platform",
    );
    expect(mapBootstrapFailure(new DaemonProcessSupervisorError("spawn_failed"))).toBe(
      "daemon_startup_failed",
    );
    expect(mapBootstrapFailure(new HarnessRpcClientError("rpc_error"))).toBe(
      "daemon_startup_failed",
    );
    expect(mapBootstrapFailure(new Error("/private/sensitive/path"))).toBe("internal_error");
  });
});
