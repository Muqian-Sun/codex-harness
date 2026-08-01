import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";
import type { z } from "zod";

import { deepFreezeJsonValue } from "./json.js";
import { adapterFailure, adapterSuccess, type AdapterResult } from "./result.js";
import {
  EmptyResponseSchema,
  ModelListParamsSchema,
  ModelListResponseSchema,
  ThreadCompactStartParamsSchema,
  ThreadForkParamsSchema,
  ThreadListParamsSchema,
  ThreadListResponseSchema,
  ThreadReadParamsSchema,
  ThreadResponseSchema,
  ThreadResumeParamsSchema,
  ThreadStartParamsSchema,
  TurnInterruptParamsSchema,
  TurnStartParamsSchema,
  TurnStartResponseSchema,
  TurnSteerParamsSchema,
  TurnSteerResponseSchema,
} from "./schemas.js";

interface RuntimeSchema {
  safeParse(input: unknown): { success: true; data: unknown } | { success: false };
}

const METHOD_REGISTRY = {
  "model/list": [ModelListParamsSchema, ModelListResponseSchema],
  "thread/start": [ThreadStartParamsSchema, ThreadResponseSchema],
  "thread/resume": [ThreadResumeParamsSchema, ThreadResponseSchema],
  "thread/fork": [ThreadForkParamsSchema, ThreadResponseSchema],
  "thread/read": [ThreadReadParamsSchema, ThreadResponseSchema],
  "thread/list": [ThreadListParamsSchema, ThreadListResponseSchema],
  "thread/compact/start": [ThreadCompactStartParamsSchema, EmptyResponseSchema],
  "turn/start": [TurnStartParamsSchema, TurnStartResponseSchema],
  "turn/steer": [TurnSteerParamsSchema, TurnSteerResponseSchema],
  "turn/interrupt": [TurnInterruptParamsSchema, EmptyResponseSchema],
} as const satisfies Record<string, readonly [z.ZodType, z.ZodType]>;

export type AllowedAppServerMethod = keyof typeof METHOD_REGISTRY;

export const ALLOWED_APP_SERVER_METHODS = Object.freeze(
  Object.keys(METHOD_REGISTRY) as AllowedAppServerMethod[],
);

export const EXPLICITLY_SENSITIVE_APP_SERVER_METHODS = Object.freeze([
  "thread/shellCommand",
  "command/exec",
  "fs/readFile",
  "fs/writeFile",
  "config/value/write",
  "account/login/start",
]);

export type ServerRequestDisposition =
  | "attestation"
  | "command_approval"
  | "credential_refresh"
  | "dynamic_tool"
  | "file_approval"
  | "legacy_approval"
  | "mcp_elicitation"
  | "permission_approval"
  | "user_input"
  | "unsupported";

const SERVER_REQUEST_DISPOSITIONS: Readonly<Record<string, ServerRequestDisposition>> =
  Object.freeze({
    "item/commandExecution/requestApproval": "command_approval",
    "item/fileChange/requestApproval": "file_approval",
    "item/permissions/requestApproval": "permission_approval",
    "item/tool/requestUserInput": "user_input",
    "mcpServer/elicitation/request": "mcp_elicitation",
    "item/tool/call": "dynamic_tool",
    "account/chatgptAuthTokens/refresh": "credential_refresh",
    "attestation/generate": "attestation",
    applyPatchApproval: "legacy_approval",
    execCommandApproval: "legacy_approval",
  });

export const KNOWN_APP_SERVER_REQUEST_METHODS = Object.freeze(
  Object.keys(SERVER_REQUEST_DISPOSITIONS),
);

export function isAllowedAppServerMethod(method: string): method is AllowedAppServerMethod {
  return Object.hasOwn(METHOD_REGISTRY, method);
}

export function validateMethodParams(method: string, params: unknown): AdapterResult<JsonValue> {
  if (!isAllowedAppServerMethod(method)) {
    return adapterFailure("unsupported_method");
  }
  const candidate = params === undefined ? {} : params;
  if (!validateJsonValue(candidate).ok) {
    return adapterFailure("invalid_params");
  }
  try {
    const parsed = (METHOD_REGISTRY[method][0] as RuntimeSchema).safeParse(candidate);
    if (!parsed.success) {
      return adapterFailure("invalid_params");
    }
    return adapterSuccess(deepFreezeJsonValue(parsed.data as JsonValue));
  } catch {
    return adapterFailure("invalid_params");
  }
}

export function validateMethodResult(
  method: AllowedAppServerMethod,
  result: unknown,
): AdapterResult<JsonValue> {
  if (!validateJsonValue(result).ok) {
    return adapterFailure("invalid_response");
  }
  try {
    const parsed = (METHOD_REGISTRY[method][1] as RuntimeSchema).safeParse(result);
    if (!parsed.success) {
      return adapterFailure("invalid_response");
    }
    return adapterSuccess(deepFreezeJsonValue(parsed.data as JsonValue));
  } catch {
    return adapterFailure("invalid_response");
  }
}

export function classifyServerRequest(method: string): ServerRequestDisposition {
  return Object.hasOwn(SERVER_REQUEST_DISPOSITIONS, method)
    ? (SERVER_REQUEST_DISPOSITIONS[method] ?? "unsupported")
    : "unsupported";
}
