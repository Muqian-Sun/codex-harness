export type AdapterFailureCode =
  | "closed"
  | "duplicate_request_id"
  | "empty_frame"
  | "frame_too_large"
  | "invalid_json"
  | "invalid_message"
  | "invalid_params"
  | "invalid_response"
  | "invalid_version"
  | "not_ready"
  | "request_id_exhausted"
  | "unexpected_response"
  | "unsupported_method";

export type AdapterFailure = Readonly<{
  code: AdapterFailureCode;
  message: string;
}>;

export type AdapterResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: AdapterFailure }>;

const FAILURE_MESSAGES: Readonly<Record<AdapterFailureCode, string>> = Object.freeze({
  closed: "The App Server adapter is closed.",
  duplicate_request_id: "The App Server request identifier is already pending.",
  empty_frame: "The App Server frame is empty.",
  frame_too_large: "The App Server frame exceeds the size limit.",
  invalid_json: "The App Server frame does not contain valid JSON.",
  invalid_message: "The App Server message is invalid.",
  invalid_params: "The App Server request parameters are invalid.",
  invalid_response: "The App Server response is invalid.",
  invalid_version: "The Codex CLI version is incompatible with the pinned schema.",
  not_ready: "The App Server adapter is not ready.",
  request_id_exhausted: "The App Server request identifier space is exhausted.",
  unexpected_response: "The App Server response does not match a pending request.",
  unsupported_method: "The App Server method is not allowed by this adapter.",
});

export function adapterFailure<T>(code: AdapterFailureCode): AdapterResult<T> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message: FAILURE_MESSAGES[code] }),
  });
}

export function adapterSuccess<T>(value: T): AdapterResult<T> {
  return Object.freeze({ ok: true, value });
}
