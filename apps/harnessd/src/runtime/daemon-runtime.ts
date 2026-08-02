import { createServer, type Server, type Socket } from "node:net";

import { ProductVersionSchema, StartupCapabilitySchema } from "@codex-harness/protocol";

import {
  ConnectionSession,
  type ConnectionSessionAction,
} from "../connection/connection-session.js";
import {
  AppServerWorkerManager,
  type AppServerWorkerManagerCloseResult,
} from "./app-server-worker-manager.js";
import {
  LocalEndpointError,
  prepareUnixEndpointForClose,
  removeCreatedUnixEndpoint,
  secureCreatedUnixEndpoint,
  validateLocalEndpoint,
  type LocalEndpoint,
  type RuntimePlatform,
  type UnixEndpointClosePreparation,
  type UnixEndpointIdentity,
} from "./local-endpoint.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const MAX_LIFECYCLE_TIMEOUT_MS = 60_000;

export type DaemonRuntimeState = "starting" | "listening" | "quiescing" | "closed";

export type DaemonQuiesceReason =
  | "parent_eof"
  | "parent_watchdog_error"
  | "requested"
  | "rpc_shutdown"
  | "signal"
  | "worker_failure";

export type DaemonRuntimeCloseResult = Readonly<{
  reason: DaemonQuiesceReason | "server_error";
  endpointCleanup:
    "missing" | "not_applicable" | "removed" | "replacement_preserved" | "unsafe_to_remove";
  errorCode?:
    "endpoint_cleanup_failed" | "server_error" | "worker_failure" | "worker_shutdown_failed";
}>;

export type DaemonRuntimeConfig = Readonly<{
  endpoint: string;
  startupCapability: string;
  serverVersion: string;
  platform?: RuntimePlatform;
  handshakeTimeoutMs?: number;
  drainTimeoutMs?: number;
  workerManager?: AppServerWorkerManager;
}>;

export class DaemonRuntimeStartError extends Error {
  readonly code: "invalid_configuration" | "listen_failed" | "worker_unavailable";

  constructor(code: "invalid_configuration" | "listen_failed" | "worker_unavailable") {
    super(
      code === "listen_failed"
        ? "The daemon listener failed to start."
        : code === "worker_unavailable"
          ? "The daemon worker manager became unavailable during startup."
          : "The daemon runtime configuration is invalid.",
    );
    this.name = "DaemonRuntimeStartError";
    this.code = code;
  }
}

export class DaemonRuntime {
  readonly #server: Server;
  readonly #endpoint: LocalEndpoint;
  readonly #startupCapability: string;
  readonly #serverVersion: string;
  readonly #handshakeTimeoutMs: number;
  readonly #drainTimeoutMs: number;
  readonly #workerManager: AppServerWorkerManager | undefined;
  readonly closed: Promise<DaemonRuntimeCloseResult>;
  #resolveClosed!: (result: DaemonRuntimeCloseResult) => void;
  #state: DaemonRuntimeState = "starting";
  #activeSocket: Socket | undefined;
  #activeSession: ConnectionSession | undefined;
  #unsubscribeAccountStatus: (() => void) | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #socketCloseTimer: NodeJS.Timeout | undefined;
  #endpointIdentity: UnixEndpointIdentity | undefined;
  #endpointClosePreparation: UnixEndpointClosePreparation | undefined;
  #endpointPreparationFailed = false;
  #quiesceReason: DaemonQuiesceReason | "server_error" | undefined;
  #listenerCreated = false;
  #serverFailed = false;
  #workerFailed = false;
  #workerClosePromise: Promise<AppServerWorkerManagerCloseResult | null> | undefined;
  #finalized = false;

  private constructor(
    endpoint: LocalEndpoint,
    config: Required<
      Pick<
        DaemonRuntimeConfig,
        "startupCapability" | "serverVersion" | "handshakeTimeoutMs" | "drainTimeoutMs"
      >
    > &
      Readonly<{ workerManager?: AppServerWorkerManager }>,
  ) {
    this.#endpoint = endpoint;
    this.#startupCapability = config.startupCapability;
    this.#serverVersion = config.serverVersion;
    this.#handshakeTimeoutMs = config.handshakeTimeoutMs;
    this.#drainTimeoutMs = config.drainTimeoutMs;
    this.#workerManager = config.workerManager;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => this.#accept(socket));
    this.#server.on("error", () => this.#handleServerFailure());
    this.#server.once("close", () => void this.#finalize());
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    const workerManager = this.#workerManager;
    if (workerManager !== undefined) {
      void workerManager.closed.then(
        () => this.#handleWorkerFailure(),
        () => this.#handleWorkerFailure(),
      );
    }
  }

  static async start(config: DaemonRuntimeConfig): Promise<DaemonRuntime> {
    if (
      !StartupCapabilitySchema.safeParse(config.startupCapability).success ||
      !ProductVersionSchema.safeParse(config.serverVersion).success ||
      !validTimeout(config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS) ||
      !validTimeout(config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS) ||
      !validReadyWorkerManager(config.workerManager)
    ) {
      await closeProvidedWorkerManager(config.workerManager);
      throw new DaemonRuntimeStartError("invalid_configuration");
    }

    let endpoint: LocalEndpoint;
    try {
      endpoint = await validateLocalEndpoint(config.endpoint, config.platform);
    } catch (error: unknown) {
      await closeProvidedWorkerManager(config.workerManager);
      if (error instanceof LocalEndpointError) {
        throw error;
      }
      throw new DaemonRuntimeStartError("invalid_configuration");
    }

    const runtime = new DaemonRuntime(endpoint, {
      startupCapability: config.startupCapability,
      serverVersion: config.serverVersion,
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      drainTimeoutMs: config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      ...(config.workerManager === undefined ? {} : { workerManager: config.workerManager }),
    });
    await runtime.#listen();
    return runtime;
  }

  get state(): DaemonRuntimeState {
    return this.#state;
  }

  get endpoint(): LocalEndpoint {
    return this.#endpoint;
  }

  requestQuiesce(reason: DaemonQuiesceReason = "requested"): boolean {
    if (this.#state !== "listening") {
      return false;
    }

    this.#state = "quiescing";
    this.#quiesceReason = reason;
    this.#stopAccountStatusSubscription();
    this.#beginWorkerClose();
    void this.#closeListenerSafely();

    const socket = this.#activeSocket;
    if (socket !== undefined) {
      this.#finishSocket(socket);
    }
    return true;
  }

  async #listen(): Promise<void> {
    try {
      const workerManager = this.#workerManager;
      if (workerManager !== undefined) {
        try {
          this.#unsubscribeAccountStatus = workerManager.subscribeAccountStatusChanges((snapshot) =>
            this.#publishAccountStatusChanged(snapshot),
          );
        } catch {
          this.#workerFailed = true;
          this.#quiesceReason = "worker_failure";
          throw new DaemonRuntimeStartError("worker_unavailable");
        }
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (): void => {
          this.#server.off("listening", onListening);
          reject(new DaemonRuntimeStartError("listen_failed"));
        };
        const onListening = (): void => {
          this.#server.off("error", onError);
          this.#listenerCreated = true;
          resolve();
        };
        this.#server.once("error", onError);
        this.#server.once("listening", onListening);
        this.#server.listen(this.#endpoint.path);
      });
      this.#endpointIdentity = await secureCreatedUnixEndpoint(this.#endpoint);
      if (this.#workerManager !== undefined && this.#workerManager.state !== "ready") {
        this.#workerFailed = true;
        this.#quiesceReason = "worker_failure";
        throw new DaemonRuntimeStartError("worker_unavailable");
      }
      if (this.#serverFailed || !this.#server.listening) {
        throw new DaemonRuntimeStartError("listen_failed");
      }
    } catch (error: unknown) {
      this.#stopAccountStatusSubscription();
      if (this.#listenerCreated && !this.#finalized) {
        this.#quiesceReason ??= "server_error";
        this.#beginWorkerClose();
        await this.#closeListenerSafely();
        await this.closed;
      } else {
        await this.#closeWorkerManager();
      }
      if (error instanceof DaemonRuntimeStartError || error instanceof LocalEndpointError) {
        throw error;
      }
      throw new DaemonRuntimeStartError("listen_failed");
    }
    this.#state = "listening";
  }

  #accept(socket: Socket): void {
    if (this.#state !== "listening" || this.#activeSocket !== undefined) {
      socket.destroy();
      return;
    }

    const session = new ConnectionSession({
      startupCapability: this.#startupCapability,
      serverVersion: this.#serverVersion,
      readAccountStatus: () => this.#readCurrentAccountStatus(),
    });
    this.#activeSocket = socket;
    this.#activeSession = session;
    socket.setNoDelay(true);
    this.#handshakeTimer = setTimeout(() => {
      if (session.state === "awaiting_hello") {
        socket.destroy();
      }
    }, this.#handshakeTimeoutMs);
    this.#handshakeTimer.unref();

    socket.on("data", (chunk: Buffer) => {
      if (socket !== this.#activeSocket) {
        return;
      }
      this.#applyActions(socket, session.receive(chunk));
      if (session.state !== "awaiting_hello") {
        this.#clearHandshakeTimer();
      }
    });
    socket.once("end", () => {
      if (socket === this.#activeSocket) {
        this.#applyActions(socket, session.end());
      }
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.#release(socket));
  }

  #applyActions(socket: Socket, actions: readonly ConnectionSessionAction[]): void {
    for (const action of actions) {
      if (action.type === "send") {
        if (!socket.destroyed && !socket.writableEnded) {
          try {
            socket.write(action.frame);
          } catch {
            socket.destroy();
          }
        }
        continue;
      }
      if (action.type === "shutdown_requested") {
        this.requestQuiesce("rpc_shutdown");
        continue;
      }
      this.#finishSocket(socket);
    }
  }

  #finishSocket(socket: Socket): void {
    if (!socket.destroyed && !socket.writableEnded) {
      socket.end();
    }
    if (this.#socketCloseTimer === undefined) {
      this.#socketCloseTimer = setTimeout(() => socket.destroy(), this.#drainTimeoutMs);
      this.#socketCloseTimer.unref();
    }
  }

  #release(socket: Socket): void {
    if (socket !== this.#activeSocket) {
      return;
    }
    this.#clearHandshakeTimer();
    if (this.#socketCloseTimer !== undefined) {
      clearTimeout(this.#socketCloseTimer);
      this.#socketCloseTimer = undefined;
    }
    this.#activeSocket = undefined;
    this.#activeSession = undefined;
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== undefined) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
    }
  }

  #readCurrentAccountStatus(): unknown {
    const manager = this.#workerManager;
    if (manager === undefined || manager.state !== "ready") {
      return null;
    }
    const accountStatus = manager.accountStatus;
    return accountStatus !== null && manager.isAccountStatusCurrent(accountStatus)
      ? accountStatus
      : null;
  }

  #publishAccountStatusChanged(snapshot: unknown): void {
    if (this.#state !== "listening") {
      return;
    }
    const socket = this.#activeSocket;
    const session = this.#activeSession;
    if (socket === undefined || session === undefined || session.state !== "authenticated") {
      return;
    }
    this.#applyActions(socket, session.publishEvent("account.status_changed", snapshot));
  }

  #stopAccountStatusSubscription(): void {
    const unsubscribe = this.#unsubscribeAccountStatus;
    this.#unsubscribeAccountStatus = undefined;
    unsubscribe?.();
  }

  #handleServerFailure(): void {
    this.#serverFailed = true;
    if (this.#state === "listening") {
      this.requestQuiesce("requested");
    }
    this.#quiesceReason = "server_error";
  }

  #handleWorkerFailure(): void {
    if (this.#state === "quiescing" || this.#state === "closed") {
      return;
    }
    this.#workerFailed = true;
    if (this.#state === "listening") {
      this.requestQuiesce("worker_failure");
    }
  }

  #beginWorkerClose(): void {
    if (this.#workerClosePromise === undefined) {
      this.#workerClosePromise = this.#closeWorkerManager();
    }
  }

  async #closeWorkerManager(): Promise<AppServerWorkerManagerCloseResult | null> {
    const workerManager = this.#workerManager;
    if (workerManager === undefined) {
      return null;
    }
    try {
      return await workerManager.close();
    } catch {
      return null;
    }
  }

  async #closeListenerSafely(): Promise<void> {
    try {
      this.#endpointClosePreparation = await prepareUnixEndpointForClose(
        this.#endpoint,
        this.#endpointIdentity,
      );
    } catch {
      this.#endpointClosePreparation = undefined;
      this.#endpointPreparationFailed = true;
    }

    try {
      this.#server.close();
    } catch {
      this.#serverFailed = true;
      this.#quiesceReason = "server_error";
      await this.#finalize();
    }
  }

  async #finalize(): Promise<void> {
    if (this.#finalized) {
      return;
    }
    this.#finalized = true;
    this.#stopAccountStatusSubscription();
    this.#clearHandshakeTimer();
    if (this.#socketCloseTimer !== undefined) {
      clearTimeout(this.#socketCloseTimer);
      this.#socketCloseTimer = undefined;
    }
    const postCloseCleanup = this.#listenerCreated
      ? await removeCreatedUnixEndpoint(this.#endpoint)
      : "missing";
    const endpointCleanup = mapEndpointCleanup(this.#endpointClosePreparation, postCloseCleanup);
    const cleanupFailed =
      this.#endpointPreparationFailed ||
      endpointCleanup === "unsafe_to_remove" ||
      endpointCleanup === "replacement_preserved";
    this.#beginWorkerClose();
    const workerClose = await (this.#workerClosePromise ?? Promise.resolve(null));
    const workerShutdownFailed =
      this.#workerManager !== undefined &&
      (workerClose === null || workerClose.containment === "containment_unknown");
    this.#state = "closed";
    this.#resolveClosed(
      Object.freeze({
        reason: this.#quiesceReason ?? "server_error",
        endpointCleanup,
        ...(this.#serverFailed
          ? { errorCode: "server_error" as const }
          : cleanupFailed
            ? { errorCode: "endpoint_cleanup_failed" as const }
            : this.#workerFailed
              ? { errorCode: "worker_failure" as const }
              : workerShutdownFailed
                ? { errorCode: "worker_shutdown_failed" as const }
                : {}),
      }),
    );
  }
}

async function closeProvidedWorkerManager(
  manager: AppServerWorkerManager | undefined,
): Promise<void> {
  if (!(manager instanceof AppServerWorkerManager)) {
    return;
  }
  try {
    await manager.close();
  } catch {
    // Invalid daemon startup cannot retain ownership of a live worker manager.
  }
}

function validReadyWorkerManager(manager: AppServerWorkerManager | undefined): boolean {
  if (manager === undefined) {
    return true;
  }
  try {
    if (!(manager instanceof AppServerWorkerManager)) {
      return false;
    }
    const catalog = manager.catalog;
    const accountStatus = manager.accountStatus;
    return (
      manager.state === "ready" &&
      catalog !== null &&
      manager.isCatalogCurrent(catalog) &&
      accountStatus !== null &&
      manager.isAccountStatusCurrent(accountStatus)
    );
  } catch {
    return false;
  }
}

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_LIFECYCLE_TIMEOUT_MS;
}

function mapEndpointCleanup(
  preparation: UnixEndpointClosePreparation | undefined,
  postCloseCleanup: "missing" | "not_applicable" | "removed" | "unsafe_to_remove",
): DaemonRuntimeCloseResult["endpointCleanup"] {
  if (preparation === "replacement_preserved") {
    return "replacement_preserved";
  }
  if (preparation === "original" && postCloseCleanup === "missing") {
    return "removed";
  }
  if (preparation === "missing") {
    return "missing";
  }
  return postCloseCleanup;
}
