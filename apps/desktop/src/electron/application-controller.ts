import { randomUUID } from "node:crypto";

import {
  DaemonProcessSupervisorError,
  type DaemonProcessSupervisor,
} from "../main/daemon-process-supervisor.js";
import {
  HarnessRpcClientError,
  type HarnessAccountStatusChangedEvent,
} from "../main/harness-rpc-client.js";
import {
  failedBootstrapState,
  decodeDesktopRoutingConfigurationUpdate,
  projectDesktopModelCatalogSummary,
  projectDesktopRoutingConfiguration,
  readyBootstrapState,
  type BootstrapStateStore,
  type DesktopBootstrapFailureCode,
  type DesktopRoutingConfigurationMutationResult,
} from "../shared/bootstrap-state.js";
import { DesktopRuntimeResourceError, DesktopRuntimeRootError } from "./runtime-resources.js";

export type DesktopSupervisorHandle = Pick<
  DaemonProcessSupervisor,
  | "closed"
  | "readAccountStatusObservation"
  | "readModelCatalogPage"
  | "readRoutingConfiguration"
  | "setRoutingConfiguration"
  | "stop"
>;

export type DesktopApplicationControllerConfig = Readonly<{
  stateStore: BootstrapStateStore;
  createSupervisor: (
    onAccountStatusChanged: (event: HarnessAccountStatusChangedEvent) => void,
  ) => Promise<DesktopSupervisorHandle>;
}>;

export class DesktopApplicationController {
  readonly #stateStore: BootstrapStateStore;
  readonly #createSupervisor: DesktopApplicationControllerConfig["createSupervisor"];
  #pendingAccountStatusEvent: HarnessAccountStatusChangedEvent | undefined;
  #supervisor: DesktopSupervisorHandle | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<number> | undefined;

  constructor(config: DesktopApplicationControllerConfig) {
    this.#stateStore = config.stateStore;
    this.#createSupervisor = config.createSupervisor;
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  stop(): Promise<number> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async setRoutingConfiguration(
    input: unknown,
  ): Promise<DesktopRoutingConfigurationMutationResult> {
    const update = decodeDesktopRoutingConfigurationUpdate(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (update === undefined || state.phase !== "ready" || supervisor === undefined) {
      return Object.freeze({ status: "unavailable" });
    }
    try {
      const routing = projectDesktopRoutingConfiguration(
        await supervisor.setRoutingConfiguration({ commandId: randomUUID(), ...update }),
      );
      const current = this.#stateStore.current;
      if (current.phase !== "ready") {
        return Object.freeze({ status: "unavailable" });
      }
      this.#stateStore.transition(readyBootstrapState(current.account, current.catalog, routing));
      return Object.freeze({ status: "saved", routing });
    } catch (error: unknown) {
      if (!(error instanceof HarnessRpcClientError) || error.remoteCode !== "rpc.conflict") {
        return Object.freeze({ status: "unavailable" });
      }
      try {
        const routing = projectDesktopRoutingConfiguration(
          await supervisor.readRoutingConfiguration(),
        );
        const current = this.#stateStore.current;
        if (current.phase !== "ready") {
          return Object.freeze({ status: "unavailable" });
        }
        this.#stateStore.transition(readyBootstrapState(current.account, current.catalog, routing));
        return Object.freeze({ status: "conflict", routing });
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    }
  }

  async #start(): Promise<void> {
    try {
      const supervisor = await this.#createSupervisor((event) =>
        this.#observeAccountStatusChanged(event),
      );
      this.#supervisor = supervisor;
      void supervisor.closed.then(() => {
        if (this.#stateStore.current.phase === "ready") {
          this.#stateStore.transition(failedBootstrapState("daemon_unavailable"));
        }
      });
      if (this.#isStopping()) {
        return;
      }
      const [observation, catalogPage, routingConfiguration] = await Promise.all([
        supervisor.readAccountStatusObservation(),
        supervisor.readModelCatalogPage({ cursor: null, limit: 12 }),
        supervisor.readRoutingConfiguration(),
      ]);
      if (this.#isStopping()) {
        return;
      }
      const pending = this.#pendingAccountStatusEvent;
      this.#pendingAccountStatusEvent = undefined;
      const accountStatus =
        pending !== undefined && pending.sequence > observation.observedThroughSequence
          ? pending.account
          : observation.account;
      this.#stateStore.transition(
        readyBootstrapState(
          accountStatus,
          projectDesktopModelCatalogSummary(catalogPage),
          projectDesktopRoutingConfiguration(routingConfiguration),
        ),
      );
    } catch (error: unknown) {
      if (this.#stateStore.current.phase !== "stopping") {
        try {
          await this.#supervisor?.stop();
        } catch {
          // Startup already failed; shutdown errors must not replace the stable startup code.
        }
        this.#stateStore.transition(failedBootstrapState(mapBootstrapFailure(error)));
      }
    }
  }

  async #stop(): Promise<number> {
    if (this.#stateStore.current.phase !== "stopping") {
      this.#stateStore.transition(Object.freeze({ phase: "stopping" }));
    }
    await (this.#startPromise ?? Promise.resolve());
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      return 0;
    }
    try {
      const result = await supervisor.stop();
      return result.containment === "containment_unknown" ? 1 : 0;
    } catch {
      return 1;
    }
  }

  #isStopping(): boolean {
    return this.#stateStore.current.phase === "stopping";
  }

  #observeAccountStatusChanged(event: HarnessAccountStatusChangedEvent): void {
    const state = this.#stateStore.current;
    if (state.phase === "starting") {
      const pending = this.#pendingAccountStatusEvent;
      if (pending === undefined || event.sequence > pending.sequence) {
        this.#pendingAccountStatusEvent = event;
      }
      return;
    }
    if (state.phase === "ready") {
      this.#stateStore.transition(readyBootstrapState(event.account, state.catalog, state.routing));
    }
  }
}

export function mapBootstrapFailure(error: unknown): DesktopBootstrapFailureCode {
  if (error instanceof DesktopRuntimeResourceError || error instanceof DesktopRuntimeRootError) {
    return error.code;
  }
  if (error instanceof DaemonProcessSupervisorError) {
    if (error.code === "unsupported_platform") {
      return "unsupported_platform";
    }
    if (error.code === "runtime_root_insecure") {
      return "runtime_root_insecure";
    }
    return "daemon_startup_failed";
  }
  if (error instanceof HarnessRpcClientError) {
    return "daemon_startup_failed";
  }
  return "internal_error";
}
