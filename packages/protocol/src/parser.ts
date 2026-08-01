import { TextDecoder } from "node:util";

import { MAX_FRAME_BYTES } from "./constants.js";
import { validateJsonValue } from "./json-value.js";
import {
  ClientBootstrapEnvelopeSchema,
  ClientRpcEnvelopeSchema,
  ServerBootstrapEnvelopeSchema,
  ServerRpcEnvelopeSchema,
  type ClientBootstrapEnvelope,
  type ClientRpcEnvelope,
  type ServerBootstrapEnvelope,
  type ServerRpcEnvelope,
} from "./schemas.js";
import { protocolFailure, protocolSuccess, type ProtocolResult } from "./result.js";

interface SafeParseSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}

type EnvelopeParser<T> = (input: unknown) => ProtocolResult<T>;

function parseWithSchema<T>(input: unknown, schema: SafeParseSchema<T>): ProtocolResult<T> {
  try {
    if (!validateJsonValue(input).ok) {
      return protocolFailure("invalid_json_value");
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return protocolFailure("invalid_envelope");
    }

    return protocolSuccess(parsed.data);
  } catch {
    return protocolFailure("invalid_envelope");
  }
}

export function parseClientBootstrapEnvelope(
  input: unknown,
): ProtocolResult<ClientBootstrapEnvelope> {
  return parseWithSchema(input, ClientBootstrapEnvelopeSchema);
}

export function parseServerBootstrapEnvelope(
  input: unknown,
): ProtocolResult<ServerBootstrapEnvelope> {
  return parseWithSchema(input, ServerBootstrapEnvelopeSchema);
}

export function parseClientRpcEnvelope(input: unknown): ProtocolResult<ClientRpcEnvelope> {
  return parseWithSchema(input, ClientRpcEnvelopeSchema);
}

export function parseServerRpcEnvelope(input: unknown): ProtocolResult<ServerRpcEnvelope> {
  return parseWithSchema(input, ServerRpcEnvelopeSchema);
}

function decodeFrame<T>(input: Uint8Array, parser: EnvelopeParser<T>): ProtocolResult<T> {
  try {
    if (!(input instanceof Uint8Array)) {
      return protocolFailure("invalid_frame_type");
    }

    const frame =
      input.length > 0 && input[input.length - 1] === 0x0d
        ? input.subarray(0, input.length - 1)
        : input;

    if (frame.byteLength === 0) {
      return protocolFailure("empty_frame");
    }
    if (frame.byteLength > MAX_FRAME_BYTES) {
      return protocolFailure("frame_too_large");
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      return protocolFailure("invalid_utf8");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text) as unknown;
    } catch {
      return protocolFailure("invalid_json");
    }

    return parser(parsedJson);
  } catch {
    return protocolFailure("invalid_envelope");
  }
}

export function decodeClientBootstrapFrame(
  frame: Uint8Array,
): ProtocolResult<ClientBootstrapEnvelope> {
  return decodeFrame(frame, parseClientBootstrapEnvelope);
}

export function decodeServerBootstrapFrame(
  frame: Uint8Array,
): ProtocolResult<ServerBootstrapEnvelope> {
  return decodeFrame(frame, parseServerBootstrapEnvelope);
}

export function decodeClientRpcFrame(frame: Uint8Array): ProtocolResult<ClientRpcEnvelope> {
  return decodeFrame(frame, parseClientRpcEnvelope);
}

export function decodeServerRpcFrame(frame: Uint8Array): ProtocolResult<ServerRpcEnvelope> {
  return decodeFrame(frame, parseServerRpcEnvelope);
}
