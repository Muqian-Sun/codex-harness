import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Socket } from "node:net";
import { TextEncoder } from "node:util";

import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  JsonlFrameDecoder,
  MAX_FRAME_BYTES,
  ProductVersionSchema,
  StartupCapabilitySchema,
  decodeEventParams,
  decodeRequestParams,
  decodeResponseResult,
  decodeServerBootstrapFrame,
  decodeServerRpcFrame,
  validateJsonValue,
  type JsonValue,
  type HarnessAccountStatusResult as ProtocolAccountStatusResult,
  type RpcEvent,
  type RpcMethodName,
} from "@codex-harness/protocol";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

export type HarnessRpcClientState = "connecting" | "handshaking" | "ready" | "closed";

export type HarnessRpcClientErrorCode =
  | "client_closed"
  | "connect_timeout"
  | "connection_closed"
  | "connection_failed"
  | "event_handler_failed"
  | "handshake_rejected"
  | "handshake_timeout"
  | "invalid_configuration"
  | "invalid_request"
  | "protocol_violation"
  | "request_timeout"
  | "resync_required"
  | "rpc_error"
  | "truncated_frame";

const ERROR_MESSAGES: Readonly<Record<HarnessRpcClientErrorCode, string>> = Object.freeze({
  client_closed: "The Harness RPC client is closed.",
  connect_timeout: "The Harness RPC connection timed out.",
  connection_closed: "The Harness RPC connection closed unexpectedly.",
  connection_failed: "The Harness RPC connection failed.",
  event_handler_failed: "The Harness RPC event handler failed.",
  handshake_rejected: "The Harness daemon rejected the bootstrap handshake.",
  handshake_timeout: "The Harness RPC handshake timed out.",
  invalid_configuration: "The Harness RPC client configuration is invalid.",
  invalid_request: "The Harness RPC request is invalid.",
  protocol_violation: "The Harness daemon sent an invalid protocol message.",
  request_timeout: "The Harness RPC request timed out with an unknown outcome.",
  resync_required: "The Harness event stream requires resynchronization.",
  rpc_error: "The Harness daemon rejected the RPC request.",
  truncated_frame: "The Harness RPC stream ended with a truncated frame.",
});

export class HarnessRpcClientError extends Error {
  readonly code: HarnessRpcClientErrorCode;
  readonly remoteCode: string | undefined;

  constructor(code: HarnessRpcClientErrorCode, remoteCode?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessRpcClientError";
    this.code = code;
    this.remoteCode = remoteCode;
  }
}

export type HarnessRpcClientConfig = Readonly<{
  endpoint: string;
  startupCapability: string;
  clientVersion: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  onEvent?: (event: Readonly<RpcEvent>) => void;
}>;

export type HarnessHealthResult = Readonly<{
  status: "ok";
  streamId: string;
  uptimeMs: number;
}>;

export type HarnessShutdownResult = Readonly<{ accepted: true }>;
export type HarnessAccountStatusResult = Readonly<ProtocolAccountStatusResult>;
export type HarnessAccountStatusObservation = Readonly<{
  account: HarnessAccountStatusResult;
  observedThroughSequence: number;
}>;
export type HarnessAccountStatusChangedEvent = Readonly<{
  sequence: number;
  account: HarnessAccountStatusResult;
}>;

type RpcResponseObservation = Readonly<{
  value: JsonValue;
  observedThroughSequence: number;
}>;

type ConnectAttempt = Readonly<{
  resolve: () => void;
  reject: (error: HarnessRpcClientError) => void;
  timer: NodeJS.Timeout;
}>;

type HandshakeAttempt = Readonly<{
  id: string;
  resolve: () => void;
  reject: (error: HarnessRpcClientError) => void;
  timer: NodeJS.Timeout;
}>;

type PendingRequest = Readonly<{
  method: RpcMethodName;
  resolve: (value: RpcResponseObservation) => void;
  reject: (error: HarnessRpcClientError) => void;
  timer: NodeJS.Timeout;
}>;

const encoder = new TextEncoder();

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

function validateConfig(config: HarnessRpcClientConfig): void {
  try {
    if (
      typeof config.endpoint === "string" &&
      isAbsolute(config.endpoint) &&
      !config.endpoint.includes("\0") &&
      StartupCapabilitySchema.safeParse(config.startupCapability).success &&
      ProductVersionSchema.safeParse(config.clientVersion).success &&
      validTimeout(config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) &&
      validTimeout(config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS) &&
      validTimeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) &&
      (config.onEvent === undefined || typeof config.onEvent === "function")
    ) {
      return;
    }
  } catch {
    // Configuration can originate in orchestration code; normalize all access failures below.
  }
  throw new HarnessRpcClientError("invalid_configuration");
}

function encodeFrame(value: JsonValue): Uint8Array {
  if (!validateJsonValue(value).ok) {
    throw new HarnessRpcClientError("invalid_request");
  }
  const frame = encoder.encode(`${JSON.stringify(value)}\n`);
  if (frame.byteLength > MAX_FRAME_BYTES + 1) {
    throw new HarnessRpcClientError("invalid_request");
  }
  return frame;
}

export class HarnessRpcClient {
  readonly #socket: Socket;
  readonly #decoder = new JsonlFrameDecoder();
  #startupCapability: string | undefined;
  readonly #clientVersion: string;
  readonly #handshakeTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #onEvent: ((event: Readonly<RpcEvent>) => void) | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly closed: Promise<HarnessRpcClientError>;
  #resolveClosed!: (error: HarnessRpcClientError) => void;
  #state: HarnessRpcClientState = "connecting";
  #connectAttempt: ConnectAttempt | undefined;
  #handshakeAttempt: HandshakeAttempt | undefined;
  #streamId: string | undefined;
  #nextSequence: number | undefined;

  private constructor(config: HarnessRpcClientConfig) {
    this.#startupCapability = config.startupCapability;
    this.#clientVersion = config.clientVersion;
    this.#handshakeTimeoutMs = config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#onEvent = config.onEvent;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });

    this.#socket = new Socket({ allowHalfOpen: true });
    this.#socket.setNoDelay(true);
    this.#socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#socket.once("end", () => this.#handleEnd());
    this.#socket.on("error", () => this.#fail(new HarnessRpcClientError("connection_failed")));
    this.#socket.once("close", () => {
      if (this.#state !== "closed") {
        this.#fail(new HarnessRpcClientError("connection_closed"));
      }
    });
  }

  static async connect(config: HarnessRpcClientConfig): Promise<HarnessRpcClient> {
    validateConfig(config);
    const client = new HarnessRpcClient(config);
    await client.#connect(config.endpoint, config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    await client.#handshake();
    return client;
  }

  get state(): HarnessRpcClientState {
    return this.#state;
  }

  async request(method: RpcMethodName, params: JsonValue): Promise<JsonValue> {
    return (await this.#requestObservation(method, params)).value;
  }

  async #requestObservation(
    method: RpcMethodName,
    params: JsonValue,
  ): Promise<RpcResponseObservation> {
    if (this.#state !== "ready") {
      throw new HarnessRpcClientError("client_closed");
    }
    if (!decodeRequestParams(method, params).ok) {
      throw new HarnessRpcClientError("invalid_request");
    }

    let id = randomUUID();
    for (let attempt = 0; this.#pending.has(id) && attempt < 8; attempt += 1) {
      id = randomUUID();
    }
    if (this.#pending.has(id)) {
      throw new HarnessRpcClientError("invalid_request");
    }

    const frame = encodeFrame({
      kind: "request",
      wireVersion: BOOTSTRAP_WIRE_VERSION,
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      id,
      method,
      params,
    });

    return await new Promise<RpcResponseObservation>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new HarnessRpcClientError("request_timeout"));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, Object.freeze({ method, resolve, reject, timer }));
      this.#write(frame);
    });
  }

  async health(): Promise<HarnessHealthResult> {
    return (await this.request("system.health", {})) as HarnessHealthResult;
  }

  async accountStatus(): Promise<HarnessAccountStatusResult> {
    return (await this.request("account.status", {})) as HarnessAccountStatusResult;
  }

  async accountStatusObservation(): Promise<HarnessAccountStatusObservation> {
    const observation = await this.#requestObservation("account.status", {});
    return Object.freeze({
      account: observation.value as HarnessAccountStatusResult,
      observedThroughSequence: observation.observedThroughSequence,
    });
  }

  async requestShutdown(reason?: string): Promise<HarnessShutdownResult> {
    const params: JsonValue = reason === undefined ? {} : { reason };
    return (await this.request("system.shutdown", params)) as HarnessShutdownResult;
  }

  close(): void {
    this.#fail(new HarnessRpcClientError("client_closed"));
  }

  async #connect(endpoint: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new HarnessRpcClientError("connect_timeout"));
      }, timeoutMs);
      timer.unref();
      this.#connectAttempt = Object.freeze({ resolve, reject, timer });
      this.#socket.once("connect", () => {
        if (this.#state !== "connecting") {
          return;
        }
        const attempt = this.#connectAttempt;
        this.#connectAttempt = undefined;
        if (attempt === undefined) {
          this.#fail(new HarnessRpcClientError("protocol_violation"));
          return;
        }
        clearTimeout(attempt.timer);
        this.#state = "handshaking";
        attempt.resolve();
      });
      try {
        this.#socket.connect({ path: endpoint });
      } catch {
        this.#fail(new HarnessRpcClientError("connection_failed"));
      }
    });
  }

  async #handshake(): Promise<void> {
    const startupCapability = this.#startupCapability;
    if (this.#state !== "handshaking" || startupCapability === undefined) {
      throw new HarnessRpcClientError("connection_failed");
    }
    const id = randomUUID();
    const frame = encodeFrame({
      kind: "bootstrap-request",
      wireVersion: BOOTSTRAP_WIRE_VERSION,
      id,
      method: "system.hello",
      params: {
        client: { name: "codex-harness-desktop", version: this.#clientVersion },
        supportedProtocolVersions: [APPLICATION_PROTOCOL_VERSION],
        capabilities: { supported: [], required: [] },
        startupCapability,
      },
    });
    this.#startupCapability = undefined;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new HarnessRpcClientError("handshake_timeout"));
      }, this.#handshakeTimeoutMs);
      timer.unref();
      this.#handshakeAttempt = Object.freeze({ id, resolve, reject, timer });
      this.#write(frame);
    });
  }

  #write(frame: Uint8Array): void {
    if (this.#state === "closed" || this.#socket.destroyed || this.#socket.writableEnded) {
      this.#fail(new HarnessRpcClientError("connection_closed"));
      return;
    }
    try {
      this.#socket.write(frame, (error?: Error | null) => {
        if (error != null) {
          this.#fail(new HarnessRpcClientError("connection_failed"));
        }
      });
    } catch {
      this.#fail(new HarnessRpcClientError("connection_failed"));
    }
  }

  #receive(chunk: Buffer): void {
    if (this.#state === "closed") {
      return;
    }
    const decoded = this.#decoder.push(chunk);
    if (!decoded.ok) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }
    for (const frame of decoded.frames) {
      if (this.state === "closed") {
        return;
      }
      if (this.#state === "handshaking") {
        this.#handleBootstrapFrame(frame);
      } else if (this.#state === "ready") {
        this.#handleRpcFrame(frame);
      } else {
        this.#fail(new HarnessRpcClientError("protocol_violation"));
      }
    }
  }

  #handleBootstrapFrame(frame: Uint8Array): void {
    const attempt = this.#handshakeAttempt;
    const parsed = decodeServerBootstrapFrame(frame);
    if (attempt === undefined || !parsed.ok || parsed.value.id !== attempt.id) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }

    if (parsed.value.kind === "bootstrap-error") {
      this.#fail(new HarnessRpcClientError("handshake_rejected", parsed.value.error.code));
      return;
    }

    const result = parsed.value.result;
    if (
      result.selectedProtocolVersion !== APPLICATION_PROTOCOL_VERSION ||
      result.enabledCapabilities.length !== 0
    ) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }
    if (result.stream.resyncRequired) {
      this.#fail(new HarnessRpcClientError("resync_required"));
      return;
    }

    clearTimeout(attempt.timer);
    this.#handshakeAttempt = undefined;
    this.#streamId = result.stream.id;
    this.#nextSequence = result.stream.nextSequence;
    this.#state = "ready";
    attempt.resolve();
  }

  #handleRpcFrame(frame: Uint8Array): void {
    const parsed = decodeServerRpcFrame(frame);
    if (!parsed.ok) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }
    const envelope = parsed.value;
    if (envelope.kind === "event") {
      const params = decodeEventParams(envelope.method, envelope.params);
      if (!params.ok) {
        this.#fail(new HarnessRpcClientError("protocol_violation"));
        return;
      }
      this.#handleEvent(Object.freeze({ ...envelope, params: params.value }));
      return;
    }
    if (envelope.id === null) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }

    const pending = this.#pending.get(envelope.id);
    if (pending === undefined) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }

    if (envelope.kind === "error") {
      this.#pending.delete(envelope.id);
      clearTimeout(pending.timer);
      pending.reject(new HarnessRpcClientError("rpc_error", envelope.error.code));
      return;
    }

    const result = decodeResponseResult(pending.method, envelope.result);
    if (!result.ok) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }
    const nextSequence = this.#nextSequence;
    if (nextSequence === undefined) {
      this.#fail(new HarnessRpcClientError("protocol_violation"));
      return;
    }
    this.#pending.delete(envelope.id);
    clearTimeout(pending.timer);
    pending.resolve(
      Object.freeze({
        value: result.value,
        observedThroughSequence: nextSequence - 1,
      }),
    );
  }

  #handleEvent(event: RpcEvent): void {
    const nextSequence = this.#nextSequence;
    if (this.#streamId !== event.streamId || nextSequence === undefined) {
      this.#fail(new HarnessRpcClientError("resync_required"));
      return;
    }
    if (event.sequence < nextSequence) {
      return;
    }
    if (event.sequence > nextSequence || event.sequence === Number.MAX_SAFE_INTEGER) {
      this.#fail(new HarnessRpcClientError("resync_required"));
      return;
    }

    this.#nextSequence = nextSequence + 1;
    try {
      this.#onEvent?.(event);
    } catch {
      this.#fail(new HarnessRpcClientError("event_handler_failed"));
    }
  }

  #handleEnd(): void {
    if (this.#state === "closed") {
      return;
    }
    const finished = this.#decoder.finish();
    this.#fail(new HarnessRpcClientError(finished.ok ? "connection_closed" : "truncated_frame"));
  }

  #fail(error: HarnessRpcClientError): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#startupCapability = undefined;
    this.#decoder.close();

    const connectAttempt = this.#connectAttempt;
    this.#connectAttempt = undefined;
    if (connectAttempt !== undefined) {
      clearTimeout(connectAttempt.timer);
      connectAttempt.reject(error);
    }

    const handshakeAttempt = this.#handshakeAttempt;
    this.#handshakeAttempt = undefined;
    if (handshakeAttempt !== undefined) {
      clearTimeout(handshakeAttempt.timer);
      handshakeAttempt.reject(error);
    }

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();

    this.#socket.destroy();
    this.#resolveClosed(error);
  }
}
