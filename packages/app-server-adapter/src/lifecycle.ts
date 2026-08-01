import { validateJsonValue } from "@codex-harness/protocol";
import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(256);
const MillisecondTimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ItemEnvelopeSchema = z.object({
  id: IdentifierSchema,
  type: IdentifierSchema,
});
const TurnStartedNotificationSchema = z.object({
  threadId: IdentifierSchema,
  turn: z.object({
    id: IdentifierSchema,
    items: z.array(ItemEnvelopeSchema),
    status: z.literal("inProgress"),
  }),
});
const TurnCompletedNotificationSchema = z.object({
  threadId: IdentifierSchema,
  turn: z.object({
    id: IdentifierSchema,
    items: z.array(ItemEnvelopeSchema),
    status: z.enum(["completed", "interrupted", "failed"]),
  }),
});
const ItemStartedNotificationSchema = z.object({
  item: ItemEnvelopeSchema,
  startedAtMs: MillisecondTimestampSchema,
  threadId: IdentifierSchema,
  turnId: IdentifierSchema,
});
const ItemCompletedNotificationSchema = z.object({
  completedAtMs: MillisecondTimestampSchema,
  item: ItemEnvelopeSchema,
  threadId: IdentifierSchema,
  turnId: IdentifierSchema,
});
const LIFECYCLE_NOTIFICATION_METHODS = new Set([
  "item/completed",
  "item/started",
  "turn/completed",
  "turn/started",
]);

export type AppServerTurnTerminalStatus = "completed" | "failed" | "interrupted";

export type AppServerRecoveryLifecycleSignal =
  | Readonly<{
      type: "turn_started";
      threadId: string;
      turnId: string;
    }>
  | Readonly<{
      type: "turn_completed";
      threadId: string;
      turnId: string;
      status: AppServerTurnTerminalStatus;
      contextCompactionItemIds: readonly string[];
    }>
  | Readonly<{
      type: "context_compaction_started" | "context_compaction_completed";
      threadId: string;
      turnId: string;
      itemId: string;
    }>;

export type AppServerLifecycleNotificationParseResult =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "signal"; signal: AppServerRecoveryLifecycleSignal }>
  | Readonly<{ kind: "unrecognized" }>
  | Readonly<{ kind: "validated_non_signal" }>;

const INVALID_RESULT = Object.freeze({ kind: "invalid" as const });
const UNRECOGNIZED_RESULT = Object.freeze({ kind: "unrecognized" as const });
const VALIDATED_NON_SIGNAL_RESULT = Object.freeze({ kind: "validated_non_signal" as const });

export function parseAppServerLifecycleNotification(
  method: string,
  params: unknown,
): AppServerLifecycleNotificationParseResult {
  try {
    if (!LIFECYCLE_NOTIFICATION_METHODS.has(method)) {
      return UNRECOGNIZED_RESULT;
    }
    if (!validateJsonValue(params).ok) {
      return INVALID_RESULT;
    }
    if (method === "turn/started") {
      const parsed = TurnStartedNotificationSchema.safeParse(params);
      if (!parsed.success) {
        return INVALID_RESULT;
      }
      return signal({
        type: "turn_started",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turn.id,
      });
    }
    if (method === "turn/completed") {
      const parsed = TurnCompletedNotificationSchema.safeParse(params);
      if (!parsed.success) {
        return INVALID_RESULT;
      }
      const contextCompactionItemIds = Object.freeze([
        ...new Set(
          parsed.data.turn.items
            .filter((item) => item.type === "contextCompaction")
            .map((item) => item.id),
        ),
      ]);
      return signal({
        type: "turn_completed",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turn.id,
        status: parsed.data.turn.status,
        contextCompactionItemIds,
      });
    }
    if (method === "item/started") {
      const parsed = ItemStartedNotificationSchema.safeParse(params);
      if (!parsed.success) {
        return INVALID_RESULT;
      }
      if (parsed.data.item.type !== "contextCompaction") {
        return VALIDATED_NON_SIGNAL_RESULT;
      }
      return signal({
        type: "context_compaction_started",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        itemId: parsed.data.item.id,
      });
    }
    if (method === "item/completed") {
      const parsed = ItemCompletedNotificationSchema.safeParse(params);
      if (!parsed.success) {
        return INVALID_RESULT;
      }
      if (parsed.data.item.type !== "contextCompaction") {
        return VALIDATED_NON_SIGNAL_RESULT;
      }
      return signal({
        type: "context_compaction_completed",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        itemId: parsed.data.item.id,
      });
    }
    return INVALID_RESULT;
  } catch {
    return INVALID_RESULT;
  }
}

function signal(
  value: AppServerRecoveryLifecycleSignal,
): AppServerLifecycleNotificationParseResult {
  return Object.freeze({ kind: "signal", signal: Object.freeze(value) });
}
