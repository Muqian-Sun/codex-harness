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
  readyBootstrapState,
  type BootstrapStateStore,
  type DesktopBootstrapFailureCode,
} from "../shared/bootstrap-state.js";
import { DesktopRuntimeResourceError, DesktopRuntimeRootError } from "./runtime-resources.js";

export type DesktopSupervisorHandle = Pick<
  DaemonProcessSupervisor,
  "closed" | "readAccountStatusObservation" | "stop"
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
      const observation = await supervisor.readAccountStatusObservation();
      if (this.#isStopping()) {
        return;
      }
      const pending = this.#pendingAccountStatusEvent;
      this.#pendingAccountStatusEvent = undefined;
      const accountStatus =
        pending !== undefined && pending.sequence > observation.observedThroughSequence
          ? pending.account
          : observation.account;
      this.#stateStore.transition(readyBootstrapState(accountStatus));
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
    const phase = this.#stateStore.current.phase;
    if (phase === "starting") {
      const pending = this.#pendingAccountStatusEvent;
      if (pending === undefined || event.sequence > pending.sequence) {
        this.#pendingAccountStatusEvent = event;
      }
      return;
    }
    if (phase === "ready") {
      this.#stateStore.transition(readyBootstrapState(event.account));
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
