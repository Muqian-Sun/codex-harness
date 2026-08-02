import { z } from "zod";

import { validateJsonValue, type JsonValue } from "./json-value.js";
import { NamespacedTokenSchema, NonNegativeSafeIntegerSchema, StreamIdSchema } from "./schemas.js";
import { protocolFailure, protocolSuccess, type ProtocolResult } from "./result.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

export const ACCOUNT_PLAN_TYPES = Object.freeze([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
] as const);

export const AccountStatusParamsSchema = z.object({}).strict();
export const AccountStatusResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string().regex(UUID_PATTERN),
    workerSessionId: z.string().regex(UUID_PATTERN),
    observedAtMs: NonNegativeSafeIntegerSchema,
    status: z.enum(["authenticated", "authentication_required", "not_required"]),
    credentialKind: z.enum(["amazon_bedrock", "api_key", "chatgpt"]).nullable(),
    planType: z.enum(ACCOUNT_PLAN_TYPES).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "authenticated" && value.credentialKind === null) ||
      (value.status !== "authenticated" && value.credentialKind !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["credentialKind"],
        message: "Credential kind must match authentication status",
      });
    }
    if (
      (value.credentialKind === "chatgpt" && value.planType === null) ||
      (value.credentialKind !== "chatgpt" && value.planType !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["planType"],
        message: "Plan type is valid only for ChatGPT credentials",
      });
    }
  });

export type HarnessAccountStatusResult = z.infer<typeof AccountStatusResultSchema>;

export const METHOD_CONTRACTS = Object.freeze({
  "account.status": Object.freeze({
    params: AccountStatusParamsSchema,
    result: AccountStatusResultSchema,
  }),
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
