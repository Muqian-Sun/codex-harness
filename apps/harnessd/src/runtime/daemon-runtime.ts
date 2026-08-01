import { createServer, type Server, type Socket } from "node:net";

import { ProductVersionSchema, StartupCapabilitySchema } from "@codex-harness/protocol";

import {
  ConnectionSession,
  type ConnectionSessionAction,
} from "../connection/connection-session.js";
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
  "parent_eof" | "parent_watchdog_error" | "requested" | "rpc_shutdown" | "signal";

export type DaemonRuntimeCloseResult = Readonly<{
  reason: DaemonQuiesceReason | "server_error";
  endpointCleanup:
    "missing" | "not_applicable" | "removed" | "replacement_preserved" | "unsafe_to_remove";
  errorCode?: "endpoint_cleanup_failed" | "server_error";
}>;

export type DaemonRuntimeConfig = Readonly<{
  endpoint: string;
  startupCapability: string;
  serverVersion: string;
  platform?: RuntimePlatform;
  handshakeTimeoutMs?: number;
  drainTimeoutMs?: number;
}>;

export class DaemonRuntimeStartError extends Error {
  readonly code: "invalid_configuration" | "listen_failed";

  constructor(code: "invalid_configuration" | "listen_failed") {
    super(
      code === "listen_failed"
        ? "The daemon listener failed to start."
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
  readonly closed: Promise<DaemonRuntimeCloseResult>;
  #resolveClosed!: (result: DaemonRuntimeCloseResult) => void;
  #state: DaemonRuntimeState = "starting";
  #activeSocket: Socket | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #socketCloseTimer: NodeJS.Timeout | undefined;
  #endpointIdentity: UnixEndpointIdentity | undefined;
  #endpointClosePreparation: UnixEndpointClosePreparation | undefined;
  #endpointPreparationFailed = false;
  #quiesceReason: DaemonQuiesceReason | "server_error" | undefined;
  #listenerCreated = false;
  #serverFailed = false;
  #finalized = false;

  private constructor(
    endpoint: LocalEndpoint,
    config: Required<
      Pick<
        DaemonRuntimeConfig,
        "startupCapability" | "serverVersion" | "handshakeTimeoutMs" | "drainTimeoutMs"
      >
    >,
  ) {
    this.#endpoint = endpoint;
    this.#startupCapability = config.startupCapability;
    this.#serverVersion = config.serverVersion;
    this.#handshakeTimeoutMs = config.handshakeTimeoutMs;
    this.#drainTimeoutMs = config.drainTimeoutMs;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => this.#accept(socket));
    this.#server.on("error", () => this.#handleServerFailure());
    this.#server.once("close", () => void this.#finalize());
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  static async start(config: DaemonRuntimeConfig): Promise<DaemonRuntime> {
    if (
      !StartupCapabilitySchema.safeParse(config.startupCapability).success ||
      !ProductVersionSchema.safeParse(config.serverVersion).success ||
      !validTimeout(config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS) ||
      !validTimeout(config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS)
    ) {
      throw new DaemonRuntimeStartError("invalid_configuration");
    }

    let endpoint: LocalEndpoint;
    try {
      endpoint = await validateLocalEndpoint(config.endpoint, config.platform);
    } catch (error: unknown) {
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
    void this.#closeListenerSafely();

    const socket = this.#activeSocket;
    if (socket !== undefined) {
      this.#finishSocket(socket);
    }
    return true;
  }

  async #listen(): Promise<void> {
    try {
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
      if (this.#serverFailed || !this.#server.listening) {
        throw new DaemonRuntimeStartError("listen_failed");
      }
    } catch (error: unknown) {
      if (this.#listenerCreated && !this.#finalized) {
        this.#quiesceReason = "server_error";
        await this.#closeListenerSafely();
        await this.closed;
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
    });
    this.#activeSocket = socket;
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
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== undefined) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
    }
  }

  #handleServerFailure(): void {
    this.#serverFailed = true;
    if (this.#state === "listening") {
      this.requestQuiesce("requested");
    }
    this.#quiesceReason = "server_error";
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
    this.#state = "closed";
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
    this.#resolveClosed(
      Object.freeze({
        reason: this.#quiesceReason ?? "server_error",
        endpointCleanup,
        ...(this.#serverFailed
          ? { errorCode: "server_error" as const }
          : cleanupFailed
            ? { errorCode: "endpoint_cleanup_failed" as const }
            : {}),
      }),
    );
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
