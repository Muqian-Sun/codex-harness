export type ProtocolFailureCode =
  | "empty_frame"
  | "frame_too_large"
  | "invalid_envelope"
  | "invalid_frame_type"
  | "invalid_json"
  | "invalid_json_value"
  | "invalid_params"
  | "invalid_result"
  | "invalid_utf8"
  | "unknown_method";

export type ProtocolFailure = Readonly<{
  code: ProtocolFailureCode;
  message: string;
}>;

export type ProtocolResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ProtocolFailure }>;

const FAILURE_MESSAGES: Readonly<Record<ProtocolFailureCode, string>> = Object.freeze({
  empty_frame: "Protocol frame is empty.",
  frame_too_large: "Protocol frame exceeds the size limit.",
  invalid_envelope: "Protocol envelope is invalid.",
  invalid_frame_type: "Protocol frame type is invalid.",
  invalid_json: "Protocol frame does not contain valid JSON.",
  invalid_json_value: "Protocol value is not JSON-compatible.",
  invalid_params: "RPC method parameters are invalid.",
  invalid_result: "RPC method result is invalid.",
  invalid_utf8: "Protocol frame is not valid UTF-8.",
  unknown_method: "RPC method is not registered.",
});

export function protocolFailure<T>(code: ProtocolFailureCode): ProtocolResult<T> {
  return {
    ok: false,
    error: Object.freeze({ code, message: FAILURE_MESSAGES[code] }),
  };
}

export function protocolSuccess<T>(value: T): ProtocolResult<T> {
  return { ok: true, value };
}
