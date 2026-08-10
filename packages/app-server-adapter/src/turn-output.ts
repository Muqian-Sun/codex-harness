import { validateJsonValue } from "@codex-harness/protocol";
import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(256);
const MillisecondTimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ItemEnvelopeSchema = z.object({
  id: IdentifierSchema,
  type: IdentifierSchema,
});
const ItemCompletedEnvelopeSchema = z.object({
  completedAtMs: MillisecondTimestampSchema,
  item: ItemEnvelopeSchema,
  threadId: IdentifierSchema,
  turnId: IdentifierSchema,
});
const AgentMessageCompletedSchema = z.object({
  completedAtMs: MillisecondTimestampSchema,
  item: z.object({
    id: IdentifierSchema,
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
    text: z.string().max(1_000_000),
    type: z.literal("agentMessage"),
  }),
  threadId: IdentifierSchema,
  turnId: IdentifierSchema,
});

export type AppServerCompletedAgentMessage = Readonly<{
  threadId: string;
  turnId: string;
  itemId: string;
  phase: "commentary" | "final_answer" | null;
  text: string;
}>;

export type AppServerTurnOutputNotificationParseResult =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "signal"; signal: AppServerCompletedAgentMessage }>
  | Readonly<{ kind: "unrecognized" }>;

const INVALID_RESULT = Object.freeze({ kind: "invalid" as const });
const UNRECOGNIZED_RESULT = Object.freeze({ kind: "unrecognized" as const });

export function parseAppServerTurnOutputNotification(
  method: string,
  params: unknown,
): AppServerTurnOutputNotificationParseResult {
  try {
    if (method !== "item/completed") {
      return UNRECOGNIZED_RESULT;
    }
    if (!validateJsonValue(params).ok) {
      return INVALID_RESULT;
    }
    const envelope = ItemCompletedEnvelopeSchema.safeParse(params);
    if (!envelope.success) {
      return INVALID_RESULT;
    }
    if (envelope.data.item.type !== "agentMessage") {
      return UNRECOGNIZED_RESULT;
    }
    const parsed = AgentMessageCompletedSchema.safeParse(params);
    if (!parsed.success) {
      return INVALID_RESULT;
    }
    return Object.freeze({
      kind: "signal",
      signal: Object.freeze({
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        itemId: parsed.data.item.id,
        phase: parsed.data.item.phase ?? null,
        text: parsed.data.item.text,
      }),
    });
  } catch {
    return INVALID_RESULT;
  }
}
