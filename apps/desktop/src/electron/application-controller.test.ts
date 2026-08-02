import { describe, expect, it, vi } from "vitest";

import { DaemonProcessSupervisorError } from "../main/daemon-process-supervisor.js";
import type { DaemonProcessSupervisorCloseResult } from "../main/daemon-process-supervisor.js";
import { HarnessRpcClientError } from "../main/harness-rpc-client.js";
import { BootstrapStateStore } from "../shared/bootstrap-state.js";
import {
  DesktopApplicationController,
  mapBootstrapFailure,
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
      readAccountStatus: vi.fn(async () => ACCOUNT_STATUS),
      stop: vi.fn(async () => closeResult("graceful")),
    };
    const createSupervisor = vi.fn(async () => supervisor);
    const controller = new DesktopApplicationController({ stateStore, createSupervisor });

    await Promise.all([controller.start(), controller.start()]);
    expect(createSupervisor).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "plus" },
    });

    closed.resolve(closeResult("graceful"));
    await closed.promise;
    await Promise.resolve();
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_unavailable" });
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
      readAccountStatus: vi.fn(async () => ACCOUNT_STATUS),
      stop,
    });

    await expect(stopping).resolves.toBe(0);
    await starting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "stopping" });
  });

  it("waits for an in-flight account read without publishing transient readiness", async () => {
    const stateStore = new BootstrapStateStore();
    const accountStatus = deferred<typeof ACCOUNT_STATUS>();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatus: async () => await accountStatus.promise,
        stop,
      }),
    });

    const starting = controller.start();
    await Promise.resolve();
    const stopping = controller.stop();
    expect(stateStore.current).toEqual({ phase: "stopping" });
    accountStatus.resolve(ACCOUNT_STATUS);

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
        readAccountStatus: vi.fn(async () => ACCOUNT_STATUS),
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
        readAccountStatus: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "service.unavailable");
        }),
        stop,
      }),
    });

    await controller.start();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_startup_failed" });
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
