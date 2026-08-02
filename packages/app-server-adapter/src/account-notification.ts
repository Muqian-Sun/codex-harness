import { validateJsonValue } from "@codex-harness/protocol";
import { z } from "zod";

import { AccountPlanTypeSchema } from "./schemas.js";

const AccountAuthModeSchema = z.enum([
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
  "headers",
  "agentIdentity",
  "personalAccessToken",
  "bedrockApiKey",
]);

const AccountUpdatedNotificationSchema = z
  .object({
    authMode: AccountAuthModeSchema.nullable().optional(),
    planType: AccountPlanTypeSchema.nullable().optional(),
  })
  .passthrough();

export type AppServerAccountNotificationParseResult =
  Readonly<{ kind: "invalid" }> | Readonly<{ kind: "signal" }> | Readonly<{ kind: "unrecognized" }>;

const INVALID_RESULT = Object.freeze({ kind: "invalid" as const });
const SIGNAL_RESULT = Object.freeze({ kind: "signal" as const });
const UNRECOGNIZED_RESULT = Object.freeze({ kind: "unrecognized" as const });

export function parseAppServerAccountNotification(
  method: string,
  params: unknown,
): AppServerAccountNotificationParseResult {
  try {
    if (method !== "account/updated") {
      return UNRECOGNIZED_RESULT;
    }
    if (!validateJsonValue(params).ok) {
      return INVALID_RESULT;
    }
    return AccountUpdatedNotificationSchema.safeParse(params).success
      ? SIGNAL_RESULT
      : INVALID_RESULT;
  } catch {
    return INVALID_RESULT;
  }
}
