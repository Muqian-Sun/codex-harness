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

const CommandExecutionCompletedSchema = z.object({
  completedAtMs: MillisecondTimestampSchema,
  item: z.object({
    aggregatedOutput: z.string().max(1_000_000).nullable(),
    command: z.string().min(1).max(65_536),
    cwd: z.string().min(1).max(16_384),
    durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
    id: IdentifierSchema,
    status: z.enum(["completed", "failed", "declined"]),
    type: z.literal("commandExecution"),
  }),
  threadId: IdentifierSchema,
  turnId: IdentifierSchema,
});

const FileChangeKindSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }),
  z.object({ type: z.literal("delete") }),
  z.object({ move_path: z.string().max(16_384).nullable().optional(), type: z.literal("update") }),
]);
const FileChangeCompletedSchema = z.object({
  completedAtMs: MillisecondTimestampSchema,
  item: z.object({
    changes: z
      .array(
        z.object({
          diff: z.string().max(1_000_000),
          kind: FileChangeKindSchema,
          path: z.string().min(1).max(16_384),
        }),
      )
      .max(512),
    id: IdentifierSchema,
    status: z.enum(["completed", "failed", "declined"]),
    type: z.literal("fileChange"),
  }),
  threadId: IdentifierSchema,
  turnId: IdentifierSchema,
});

const PASSIVE_ITEM_TYPES = new Set([
  "agentMessage",
  "contextCompaction",
  "hookPrompt",
  "plan",
  "reasoning",
  "userMessage",
]);

export type AppServerCompletedAgentMessage = Readonly<{
  type: "agent_message";
  threadId: string;
  turnId: string;
  itemId: string;
  phase: "commentary" | "final_answer" | null;
  text: string;
}>;

export type AppServerCompletedCommandExecution = Readonly<{
  type: "command_execution";
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd: string;
  status: "completed" | "failed" | "declined";
  exitCode: number | null;
  durationMs: number | null;
  aggregatedOutput: string | null;
}>;

export type AppServerCompletedFileChange = Readonly<{
  type: "file_change";
  threadId: string;
  turnId: string;
  itemId: string;
  status: "completed" | "failed" | "declined";
  changes: readonly Readonly<{
    path: string;
    changeKind: "add" | "delete" | "update";
    movePath: string | null;
    diff: string;
  }>[];
}>;

export type AppServerForbiddenTurnItem = Readonly<{
  type: "forbidden_item";
  threadId: string;
  turnId: string;
  itemId: string;
  itemType: string;
}>;

export type AppServerCompletedTurnOutput =
  | AppServerCompletedAgentMessage
  | AppServerCompletedCommandExecution
  | AppServerCompletedFileChange
  | AppServerForbiddenTurnItem;

export type AppServerTurnOutputNotificationParseResult =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "signal"; signal: AppServerCompletedTurnOutput }>
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
    if (envelope.data.item.type === "agentMessage") {
      const parsed = AgentMessageCompletedSchema.safeParse(params);
      if (!parsed.success) return INVALID_RESULT;
      return signal({
        type: "agent_message",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        itemId: parsed.data.item.id,
        phase: parsed.data.item.phase ?? null,
        text: parsed.data.item.text,
      });
    }
    if (envelope.data.item.type === "commandExecution") {
      const parsed = CommandExecutionCompletedSchema.safeParse(params);
      if (!parsed.success) return INVALID_RESULT;
      return signal({
        type: "command_execution",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        itemId: parsed.data.item.id,
        command: parsed.data.item.command,
        cwd: parsed.data.item.cwd,
        status: parsed.data.item.status,
        exitCode: parsed.data.item.exitCode,
        durationMs: parsed.data.item.durationMs,
        aggregatedOutput: parsed.data.item.aggregatedOutput,
      });
    }
    if (envelope.data.item.type === "fileChange") {
      const parsed = FileChangeCompletedSchema.safeParse(params);
      if (!parsed.success) return INVALID_RESULT;
      return signal({
        type: "file_change",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        itemId: parsed.data.item.id,
        status: parsed.data.item.status,
        changes: Object.freeze(
          parsed.data.item.changes.map((change) =>
            Object.freeze({
              path: change.path,
              changeKind: change.kind.type,
              movePath: change.kind.type === "update" ? (change.kind.move_path ?? null) : null,
              diff: change.diff,
            }),
          ),
        ),
      });
    }
    if (PASSIVE_ITEM_TYPES.has(envelope.data.item.type)) return UNRECOGNIZED_RESULT;
    return signal({
      type: "forbidden_item",
      threadId: envelope.data.threadId,
      turnId: envelope.data.turnId,
      itemId: envelope.data.item.id,
      itemType: envelope.data.item.type,
    });
  } catch {
    return INVALID_RESULT;
  }
}

function signal(signal: AppServerCompletedTurnOutput): AppServerTurnOutputNotificationParseResult {
  return Object.freeze({ kind: "signal", signal: Object.freeze(signal) });
}
