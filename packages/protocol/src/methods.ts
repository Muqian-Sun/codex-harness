import { z } from "zod";

import { validateJsonValue, type JsonValue } from "./json-value.js";
import { NamespacedTokenSchema, NonNegativeSafeIntegerSchema, StreamIdSchema } from "./schemas.js";
import { protocolFailure, protocolSuccess, type ProtocolResult } from "./result.js";

export const SystemHealthParamsSchema = z.object({}).strict();
export const SystemHealthResultSchema = z
  .object({
    status: z.literal("ok"),
    streamId: StreamIdSchema,
    uptimeMs: NonNegativeSafeIntegerSchema,
  })
  .passthrough();

export const SystemShutdownParamsSchema = z
  .object({
    reason: NamespacedTokenSchema.optional(),
  })
  .strict();
export const SystemShutdownResultSchema = z.object({ accepted: z.literal(true) }).passthrough();

export const METHOD_CONTRACTS = Object.freeze({
  "system.health": Object.freeze({
    params: SystemHealthParamsSchema,
    result: SystemHealthResultSchema,
  }),
  "system.shutdown": Object.freeze({
    params: SystemShutdownParamsSchema,
    result: SystemShutdownResultSchema,
  }),
});

export type RpcMethodName = keyof typeof METHOD_CONTRACTS;

function hasMethod(method: string): method is RpcMethodName {
  return Object.prototype.hasOwnProperty.call(METHOD_CONTRACTS, method);
}

function decodeMethodValue(
  method: string,
  input: unknown,
  side: "params" | "result",
): ProtocolResult<JsonValue> {
  if (!hasMethod(method)) {
    return protocolFailure("unknown_method");
  }
  if (!validateJsonValue(input).ok) {
    return protocolFailure(side === "params" ? "invalid_params" : "invalid_result");
  }

  const parsed = METHOD_CONTRACTS[method][side].safeParse(input);
  if (!parsed.success) {
    return protocolFailure(side === "params" ? "invalid_params" : "invalid_result");
  }

  return protocolSuccess(parsed.data as JsonValue);
}

export function decodeRequestParams(method: string, params: unknown): ProtocolResult<JsonValue> {
  return decodeMethodValue(method, params, "params");
}

export function decodeResponseResult(method: string, result: unknown): ProtocolResult<JsonValue> {
  return decodeMethodValue(method, result, "result");
}
