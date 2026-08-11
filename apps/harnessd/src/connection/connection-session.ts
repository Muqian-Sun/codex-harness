import { TextEncoder } from "node:util";

import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  JsonlFrameDecoder,
  MAX_FRAME_BYTES,
  ProductVersionSchema,
  RPC_ERROR_CODES,
  StartupCapabilitySchema,
  StreamIdSchema,
  decodeClientBootstrapFrame,
  decodeClientRpcFrame,
  decodeEventParams,
  negotiateHello,
  validateJsonValue,
  type JsonValue,
} from "@codex-harness/protocol";

import { generateStreamId, startupCapabilitiesEqual } from "./identifiers.js";
import { dispatchRpcRequestAsync } from "./rpc-dispatcher.js";

export type ConnectionSessionState = "awaiting_hello" | "authenticated" | "closing" | "closed";

export type ConnectionCloseReason =
  | "authentication_failed"
  | "internal_error"
  | "invalid_frame"
  | "peer_ended"
  | "protocol_violation"
  | "truncated_frame";

export type ConnectionSessionAction =
  | Readonly<{ type: "send"; frame: Uint8Array }>
  | Readonly<{ type: "shutdown_requested"; reason: string | undefined }>
  | Readonly<{ type: "close"; reason: ConnectionCloseReason }>;

export type ConnectionSessionConfig = Readonly<{
  startupCapability: string;
  serverVersion: string;
  streamIdFactory?: () => string;
  uptimeMs?: () => number;
  readAccountStatus?: () => unknown;
  readModelCatalogPage?: (params: JsonValue) => unknown;
  readProjectCatalogPage?: (params: JsonValue) => unknown;
  registerProject?: (params: JsonValue) => unknown;
  readProjectRoutingBindingStatuses?: (params: JsonValue) => unknown;
  bindProjectDefaultRouting?: (params: JsonValue) => unknown;
  readProjectTaskCatalogPage?: (params: JsonValue) => unknown;
  createProjectTask?: (params: JsonValue) => unknown;
  readProjectTaskDetail?: (params: JsonValue) => unknown;
  reviseProjectTaskRequirement?: (params: JsonValue) => unknown;
  confirmProjectTaskCandidatePlan?: (params: JsonValue) => unknown;
  generateProjectTaskCandidatePlan?: (params: JsonValue) => unknown | Promise<unknown>;
  readRoutingConfiguration?: () => unknown;
  setRoutingConfiguration?: (params: JsonValue) => unknown;
}>;

const encoder = new TextEncoder();

function encodeFrame(value: JsonValue): Uint8Array {
  if (!validateJsonValue(value).ok) {
    throw new Error("Cannot encode a non-JSON daemon envelope.");
  }
  const frame = encoder.encode(`${JSON.stringify(value)}\n`);
  if (frame.byteLength > MAX_FRAME_BYTES + 1) {
    throw new Error("Cannot encode an oversized daemon envelope.");
  }
  return frame;
}

function send(value: JsonValue): ConnectionSessionAction {
  return Object.freeze({ type: "send", frame: encodeFrame(value) });
}

function bootstrapError(id: string | null, code: string, message: string): JsonValue {
  return {
    kind: "bootstrap-error",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    id,
    error: { code, message },
  };
}

function rpcProtocolError(): JsonValue {
  return {
    kind: "error",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id: null,
    error: {
      code: RPC_ERROR_CODES.invalidMessage,
      message: "The RPC message is invalid.",
    },
  };
}

function rpcInternalError(): JsonValue {
  return {
    kind: "error",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id: null,
    error: {
      code: RPC_ERROR_CODES.internalError,
      message: INTERNAL_ERROR_PUBLIC_MESSAGE,
    },
  };
}

function safeUptime(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

export class ConnectionSession {
  readonly #decoder = new JsonlFrameDecoder();
  readonly #serverVersion: string;
  readonly #startupCapability: string;
  readonly #streamIdFactory: () => string;
  readonly #uptimeMs: () => number;
  readonly #readAccountStatus: () => unknown;
  readonly #readModelCatalogPage: (params: JsonValue) => unknown;
  readonly #readProjectCatalogPage: (params: JsonValue) => unknown;
  readonly #registerProject: (params: JsonValue) => unknown;
  readonly #readProjectRoutingBindingStatuses: (params: JsonValue) => unknown;
  readonly #bindProjectDefaultRouting: (params: JsonValue) => unknown;
  readonly #readProjectTaskCatalogPage: (params: JsonValue) => unknown;
  readonly #createProjectTask: (params: JsonValue) => unknown;
  readonly #readProjectTaskDetail: (params: JsonValue) => unknown;
  readonly #reviseProjectTaskRequirement: (params: JsonValue) => unknown;
  readonly #confirmProjectTaskCandidatePlan: (params: JsonValue) => unknown;
  readonly #generateProjectTaskCandidatePlan: (params: JsonValue) => unknown | Promise<unknown>;
  readonly #readRoutingConfiguration: () => unknown;
  readonly #setRoutingConfiguration: (params: JsonValue) => unknown;
  #state: ConnectionSessionState = "awaiting_hello";
  #streamId: string | undefined;
  #nextEventSequence: number | undefined;

  constructor(config: ConnectionSessionConfig) {
    if (!StartupCapabilitySchema.safeParse(config.startupCapability).success) {
      throw new Error("Invalid connection session configuration.");
    }
    if (!ProductVersionSchema.safeParse(config.serverVersion).success) {
      throw new Error("Invalid connection session configuration.");
    }
    if (config.readAccountStatus !== undefined && typeof config.readAccountStatus !== "function") {
      throw new Error("Invalid connection session configuration.");
    }
    if (
      config.readModelCatalogPage !== undefined &&
      typeof config.readModelCatalogPage !== "function"
    ) {
      throw new Error("Invalid connection session configuration.");
    }
    if (
      (config.readProjectCatalogPage !== undefined &&
        typeof config.readProjectCatalogPage !== "function") ||
      (config.registerProject !== undefined && typeof config.registerProject !== "function") ||
      (config.readProjectRoutingBindingStatuses !== undefined &&
        typeof config.readProjectRoutingBindingStatuses !== "function") ||
      (config.bindProjectDefaultRouting !== undefined &&
        typeof config.bindProjectDefaultRouting !== "function") ||
      (config.readProjectTaskCatalogPage !== undefined &&
        typeof config.readProjectTaskCatalogPage !== "function") ||
      (config.createProjectTask !== undefined && typeof config.createProjectTask !== "function") ||
      (config.readProjectTaskDetail !== undefined &&
        typeof config.readProjectTaskDetail !== "function") ||
      (config.reviseProjectTaskRequirement !== undefined &&
        typeof config.reviseProjectTaskRequirement !== "function") ||
      (config.confirmProjectTaskCandidatePlan !== undefined &&
        typeof config.confirmProjectTaskCandidatePlan !== "function") ||
      (config.generateProjectTaskCandidatePlan !== undefined &&
        typeof config.generateProjectTaskCandidatePlan !== "function")
    ) {
      throw new Error("Invalid connection session configuration.");
    }
    if (
      (config.readRoutingConfiguration !== undefined &&
        typeof config.readRoutingConfiguration !== "function") ||
      (config.setRoutingConfiguration !== undefined &&
        typeof config.setRoutingConfiguration !== "function")
    ) {
      throw new Error("Invalid connection session configuration.");
    }
    this.#startupCapability = config.startupCapability;
    this.#serverVersion = config.serverVersion;
    this.#streamIdFactory = config.streamIdFactory ?? generateStreamId;
    this.#uptimeMs = config.uptimeMs ?? (() => process.uptime() * 1_000);
    this.#readAccountStatus = config.readAccountStatus ?? (() => null);
    this.#readModelCatalogPage = config.readModelCatalogPage ?? (() => null);
    this.#readProjectCatalogPage = config.readProjectCatalogPage ?? (() => null);
    this.#registerProject = config.registerProject ?? (() => null);
    this.#readProjectRoutingBindingStatuses =
      config.readProjectRoutingBindingStatuses ?? (() => null);
    this.#bindProjectDefaultRouting = config.bindProjectDefaultRouting ?? (() => null);
    this.#readProjectTaskCatalogPage = config.readProjectTaskCatalogPage ?? (() => null);
    this.#createProjectTask = config.createProjectTask ?? (() => null);
    this.#readProjectTaskDetail = config.readProjectTaskDetail ?? (() => null);
    this.#reviseProjectTaskRequirement = config.reviseProjectTaskRequirement ?? (() => null);
    this.#confirmProjectTaskCandidatePlan = config.confirmProjectTaskCandidatePlan ?? (() => null);
    this.#generateProjectTaskCandidatePlan =
      config.generateProjectTaskCandidatePlan ?? (() => null);
    this.#readRoutingConfiguration = config.readRoutingConfiguration ?? (() => null);
    this.#setRoutingConfiguration = config.setRoutingConfiguration ?? (() => null);
  }

  get state(): ConnectionSessionState {
    return this.#state;
  }

  get streamId(): string | undefined {
    return this.#streamId;
  }

  async receive(input: unknown): Promise<readonly ConnectionSessionAction[]> {
    if (this.#state === "closed") {
      return Object.freeze([]);
    }

    try {
      const decoded = this.#decoder.push(input);
      if (!decoded.ok) {
        return this.#failConnection("invalid_frame");
      }

      const actions: ConnectionSessionAction[] = [];
      for (const frame of decoded.frames) {
        const frameActions =
          this.#state === "awaiting_hello"
            ? this.#handleHello(frame)
            : await this.#handleRpc(frame);
        actions.push(...frameActions);
        if (frameActions.some((action) => action.type === "close")) {
          break;
        }
      }
      return Object.freeze(actions);
    } catch {
      return this.#failInternal();
    }
  }

  end(): readonly ConnectionSessionAction[] {
    if (this.#state === "closed") {
      return Object.freeze([]);
    }
    const finished = this.#decoder.finish();
    this.#state = "closed";
    return Object.freeze([
      Object.freeze({
        type: "close" as const,
        reason: finished.ok ? ("peer_ended" as const) : ("truncated_frame" as const),
      }),
    ]);
  }

  close(): void {
    this.#decoder.close();
    this.#state = "closed";
  }

  publishEvent(method: string, params: unknown): readonly ConnectionSessionAction[] {
    if (this.#state !== "authenticated") {
      return Object.freeze([]);
    }
    try {
      const streamId = this.#streamId;
      const sequence = this.#nextEventSequence;
      const decoded = decodeEventParams(method, params);
      if (
        streamId === undefined ||
        sequence === undefined ||
        sequence >= Number.MAX_SAFE_INTEGER ||
        !decoded.ok
      ) {
        return this.#failInternal();
      }
      const action = send({
        kind: "event",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        streamId,
        sequence,
        method,
        params: decoded.value,
      });
      this.#nextEventSequence = sequence + 1;
      return Object.freeze([action]);
    } catch {
      return this.#failInternal();
    }
  }

  #handleHello(frame: Uint8Array): readonly ConnectionSessionAction[] {
    const parsed = decodeClientBootstrapFrame(frame);
    if (!parsed.ok) {
      return this.#failConnection("protocol_violation");
    }

    const request = parsed.value;
    if (!startupCapabilitiesEqual(this.#startupCapability, request.params.startupCapability)) {
      const error = send(
        bootstrapError(
          request.id,
          RPC_ERROR_CODES.authenticationFailed,
          "Startup authentication failed.",
        ),
      );
      this.#decoder.close();
      this.#state = "closed";
      return Object.freeze([
        error,
        Object.freeze({ type: "close", reason: "authentication_failed" }),
      ]);
    }

    const negotiation = negotiateHello(request.params, {
      supportedProtocolVersions: [APPLICATION_PROTOCOL_VERSION],
      capabilities: [],
    });
    if (!negotiation.ok) {
      const error = send(
        bootstrapError(request.id, negotiation.error.code, negotiation.error.message),
      );
      this.#decoder.close();
      this.#state = "closed";
      return Object.freeze([error, Object.freeze({ type: "close", reason: "protocol_violation" })]);
    }

    const streamId = this.#streamIdFactory();
    if (!StreamIdSchema.safeParse(streamId).success) {
      return this.#failInternal();
    }
    this.#streamId = streamId;
    this.#nextEventSequence = 1;
    this.#state = "authenticated";
    return Object.freeze([
      send({
        kind: "bootstrap-response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        id: request.id,
        result: {
          selectedProtocolVersion: negotiation.value.selectedProtocolVersion,
          server: { name: "harnessd", version: this.#serverVersion },
          enabledCapabilities: [...negotiation.value.enabledCapabilities],
          stream: {
            id: streamId,
            nextSequence: 1,
            replayWindowStart: 1,
            resyncRequired: request.params.resume !== undefined,
          },
        },
      }),
    ]);
  }

  async #handleRpc(frame: Uint8Array): Promise<readonly ConnectionSessionAction[]> {
    const parsed = decodeClientRpcFrame(frame);
    if (!parsed.ok) {
      const error = send(rpcProtocolError());
      this.#decoder.close();
      this.#state = "closed";
      return Object.freeze([error, Object.freeze({ type: "close", reason: "protocol_violation" })]);
    }

    const streamId = this.#streamId;
    if (streamId === undefined) {
      return this.#failConnection("protocol_violation");
    }
    const dispatched = await dispatchRpcRequestAsync(parsed.value, {
      streamId,
      uptimeMs: safeUptime(this.#uptimeMs()),
      closing: this.#state === "closing",
      readAccountStatus: this.#readAccountStatus,
      readModelCatalogPage: this.#readModelCatalogPage,
      readProjectCatalogPage: this.#readProjectCatalogPage,
      registerProject: this.#registerProject,
      readProjectRoutingBindingStatuses: this.#readProjectRoutingBindingStatuses,
      bindProjectDefaultRouting: this.#bindProjectDefaultRouting,
      readProjectTaskCatalogPage: this.#readProjectTaskCatalogPage,
      createProjectTask: this.#createProjectTask,
      readProjectTaskDetail: this.#readProjectTaskDetail,
      reviseProjectTaskRequirement: this.#reviseProjectTaskRequirement,
      confirmProjectTaskCandidatePlan: this.#confirmProjectTaskCandidatePlan,
      generateProjectTaskCandidatePlan: this.#generateProjectTaskCandidatePlan,
      readRoutingConfiguration: this.#readRoutingConfiguration,
      setRoutingConfiguration: this.#setRoutingConfiguration,
    });
    const actions: ConnectionSessionAction[] = [send(dispatched.envelope)];
    if (dispatched.shutdownRequested && this.#state !== "closing") {
      this.#state = "closing";
      actions.push(
        Object.freeze({ type: "shutdown_requested", reason: dispatched.shutdownReason }),
      );
    }
    return Object.freeze(actions);
  }

  #failConnection(reason: ConnectionCloseReason): readonly ConnectionSessionAction[] {
    const wasAwaitingHello = this.#state === "awaiting_hello";
    this.#decoder.close();
    this.#state = "closed";
    return Object.freeze([
      send(
        wasAwaitingHello
          ? bootstrapError(
              null,
              RPC_ERROR_CODES.invalidMessage,
              "The bootstrap message is invalid.",
            )
          : rpcProtocolError(),
      ),
      Object.freeze({ type: "close", reason }),
    ]);
  }

  #failInternal(): readonly ConnectionSessionAction[] {
    const wasAwaitingHello = this.#state === "awaiting_hello";
    this.#decoder.close();
    this.#state = "closed";
    return Object.freeze([
      send(
        wasAwaitingHello
          ? bootstrapError(null, RPC_ERROR_CODES.internalError, INTERNAL_ERROR_PUBLIC_MESSAGE)
          : rpcInternalError(),
      ),
      Object.freeze({ type: "close", reason: "internal_error" }),
    ]);
  }
}
