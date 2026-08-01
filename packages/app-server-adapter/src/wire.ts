import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import { adapterFailure, adapterSuccess, type AdapterResult } from "./result.js";

export type AppServerRequestId = string | number;
export const MAX_APP_SERVER_FRAME_BYTES = 16 * 1024 * 1024;

export type AppServerRequestMessage = Readonly<{
  kind: "request";
  id: AppServerRequestId;
  method: string;
  params: JsonValue | undefined;
}>;

export type AppServerNotificationMessage = Readonly<{
  kind: "notification";
  method: string;
  params: JsonValue | undefined;
}>;

export type AppServerSuccessMessage = Readonly<{
  kind: "success";
  id: AppServerRequestId;
  result: JsonValue;
}>;

export type AppServerErrorMessage = Readonly<{
  kind: "error";
  id: AppServerRequestId;
  error: Readonly<{
    code: number;
    message: string;
    data: JsonValue | undefined;
  }>;
}>;

export type AppServerMessage =
  | AppServerRequestMessage
  | AppServerNotificationMessage
  | AppServerSuccessMessage
  | AppServerErrorMessage;

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: JsonValue | undefined): value is AppServerRequestId {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isMethod(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function parseAppServerMessage(input: unknown): AdapterResult<AppServerMessage> {
  try {
    if (!validateJsonValue(input).ok) {
      return adapterFailure("invalid_message");
    }

    const value = input as JsonValue;
    if (!isRecord(value) || Object.hasOwn(value, "jsonrpc")) {
      return adapterFailure("invalid_message");
    }

    const id = value.id;
    const method = value.method;
    const hasId = Object.hasOwn(value, "id");
    const hasMethod = Object.hasOwn(value, "method");
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");

    if (hasMethod) {
      if (!isMethod(method) || hasResult || hasError) {
        return adapterFailure("invalid_message");
      }
      if (hasId && !isRequestId(id)) {
        return adapterFailure("invalid_message");
      }
      if (hasId) {
        return adapterSuccess({
          kind: "request",
          id: id as AppServerRequestId,
          method,
          params: value.params,
        });
      }
      return adapterSuccess({ kind: "notification", method, params: value.params });
    }

    if (!hasId || !isRequestId(id) || hasResult === hasError) {
      return adapterFailure("invalid_message");
    }

    if (hasResult) {
      const result = value.result;
      if (result === undefined) {
        return adapterFailure("invalid_message");
      }
      return adapterSuccess({ kind: "success", id: id as AppServerRequestId, result });
    }

    const error = value.error;
    if (!isRecord(error)) {
      return adapterFailure("invalid_message");
    }
    const code = error.code;
    const message = error.message;
    if (
      typeof code !== "number" ||
      !Number.isSafeInteger(code) ||
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > 4096
    ) {
      return adapterFailure("invalid_message");
    }
    return adapterSuccess({
      kind: "error",
      id: id as AppServerRequestId,
      error: { code, message, data: error.data },
    });
  } catch {
    return adapterFailure("invalid_message");
  }
}

export function parseAppServerJson(line: string): AdapterResult<AppServerMessage> {
  try {
    if (typeof line !== "string") {
      return adapterFailure("invalid_json");
    }
    const byteLength = Buffer.byteLength(line, "utf8");
    if (byteLength === 0) {
      return adapterFailure("empty_frame");
    }
    if (byteLength > MAX_APP_SERVER_FRAME_BYTES) {
      return adapterFailure("frame_too_large");
    }
    return parseAppServerMessage(JSON.parse(line) as unknown);
  } catch {
    return adapterFailure("invalid_json");
  }
}
