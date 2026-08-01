import { validateJsonValue } from "@codex-harness/protocol";

import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  buildTaskRecoveryCapsule,
  isTaskRecoveryCapsuleCurrent,
  type TaskRecoveryCapsule,
  type TaskRecoveryFence,
  type TaskRecoveryTextInput,
} from "./task-recovery-context.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_APP_SERVER_IDENTIFIER_CHARACTERS = 256;
const MAX_COMPACTION_OBSERVATIONS = 1024;

export type TaskRecoveryTurnTerminalStatus = "completed" | "failed" | "interrupted";

export type TaskRecoveryLifecycleSignal =
  | Readonly<{
      type: "turn_started";
      threadId: string;
      turnId: string;
    }>
  | Readonly<{
      type: "turn_completed";
      threadId: string;
      turnId: string;
      status: TaskRecoveryTurnTerminalStatus;
      contextCompactionItemIds: readonly string[];
    }>
  | Readonly<{
      type: "context_compaction_started" | "context_compaction_completed";
      threadId: string;
      turnId: string;
      itemId: string;
    }>;

export type TaskRecoveryCompactionObservation = Readonly<{
  itemId: string;
  startedObserved: boolean;
  completedObserved: boolean;
  turnSummaryObserved: boolean;
}>;

export type TaskRecoveryBoundaryState = Readonly<{
  schemaVersion: 1;
  taskId: string;
  threadId: string;
  turnId: string;
  turnStartedObserved: boolean;
  terminalStatus: TaskRecoveryTurnTerminalStatus | null;
  compactions: readonly TaskRecoveryCompactionObservation[];
  phase: "active" | "terminal";
  resultTrust: "normal" | "revalidation_required";
  nextTurnRecovery: "blocked" | "required";
}>;

export type TaskRecoveryBoundaryConfig = Readonly<{
  taskId: string;
  threadId: string;
  turnId: string;
}>;

export type TaskRecoveryPreparation =
  | Readonly<{
      kind: "blocked";
      reason: "stale_context" | "task_mismatch" | "turn_active";
    }>
  | Readonly<{
      kind: "ready";
      taskId: string;
      threadId: string;
      previousTurnId: string;
      terminalStatus: TaskRecoveryTurnTerminalStatus;
      resultTrust: "normal" | "revalidation_required";
      fence: TaskRecoveryFence;
      input: TaskRecoveryTextInput;
    }>;

export type TaskRecoveryBoundaryErrorCode =
  | "binding_mismatch"
  | "capacity_exceeded"
  | "conflict"
  | "invalid_input"
  | "invalid_signal"
  | "invalid_state";

const ERROR_MESSAGES: Readonly<Record<TaskRecoveryBoundaryErrorCode, string>> = Object.freeze({
  binding_mismatch: "The recovery lifecycle signal does not match this turn binding.",
  capacity_exceeded: "The recovery boundary observation capacity is exceeded.",
  conflict: "The recovery lifecycle signal conflicts with observed turn state.",
  invalid_input: "The recovery boundary input is invalid.",
  invalid_signal: "The recovery lifecycle signal is invalid.",
  invalid_state: "The recovery boundary state is invalid.",
});

const BLOCKED_ACTIVE = Object.freeze({ kind: "blocked" as const, reason: "turn_active" as const });
const BLOCKED_TASK_MISMATCH = Object.freeze({
  kind: "blocked" as const,
  reason: "task_mismatch" as const,
});
const BLOCKED_STALE_CONTEXT = Object.freeze({
  kind: "blocked" as const,
  reason: "stale_context" as const,
});

export class TaskRecoveryBoundaryError extends Error {
  readonly code: TaskRecoveryBoundaryErrorCode;

  constructor(code: TaskRecoveryBoundaryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TaskRecoveryBoundaryError";
    this.code = code;
  }
}

export function createTaskRecoveryBoundary(
  input: TaskRecoveryBoundaryConfig,
): TaskRecoveryBoundaryState {
  try {
    const record = requireExactRecord(input, ["taskId", "threadId", "turnId"], "invalid_input");
    return materializeState({
      taskId: requireUuid(record.taskId, "invalid_input"),
      threadId: requireAppServerIdentifier(record.threadId, "invalid_input"),
      turnId: requireAppServerIdentifier(record.turnId, "invalid_input"),
      turnStartedObserved: false,
      terminalStatus: null,
      compactions: [],
    });
  } catch (error: unknown) {
    throw mapBoundaryError(error, "invalid_input");
  }
}

export function applyTaskRecoveryLifecycleSignal(
  input: TaskRecoveryBoundaryState,
  rawSignal: TaskRecoveryLifecycleSignal,
): TaskRecoveryBoundaryState {
  try {
    const state = decodeState(input);
    const signal = decodeSignal(rawSignal);
    if (signal.threadId !== state.threadId || signal.turnId !== state.turnId) {
      throw new TaskRecoveryBoundaryError("binding_mismatch");
    }

    let turnStartedObserved = state.turnStartedObserved;
    let terminalStatus = state.terminalStatus;
    const compactions = new Map(state.compactions.map((item) => [item.itemId, { ...item }]));
    let changed = false;

    if (signal.type === "turn_started") {
      if (!turnStartedObserved) {
        turnStartedObserved = true;
        changed = true;
      }
    } else if (signal.type === "turn_completed") {
      if (terminalStatus !== null && terminalStatus !== signal.status) {
        throw new TaskRecoveryBoundaryError("conflict");
      }
      if (terminalStatus === null) {
        terminalStatus = signal.status;
        changed = true;
      }
      for (const itemId of signal.contextCompactionItemIds) {
        changed = mergeCompactionObservation(compactions, itemId, "turn_summary") || changed;
      }
    } else {
      changed =
        mergeCompactionObservation(
          compactions,
          signal.itemId,
          signal.type === "context_compaction_started" ? "started" : "completed",
        ) || changed;
    }

    if (!changed) {
      return state;
    }
    return materializeState({
      taskId: state.taskId,
      threadId: state.threadId,
      turnId: state.turnId,
      turnStartedObserved,
      terminalStatus,
      compactions: [...compactions.values()],
    });
  } catch (error: unknown) {
    if (error instanceof TaskRecoveryBoundaryError) {
      throw error;
    }
    throw new TaskRecoveryBoundaryError("invalid_signal");
  }
}

export function prepareNextTurnRecovery(
  rawState: TaskRecoveryBoundaryState,
  task: TaskPlanRecord,
  candidate: unknown,
): TaskRecoveryPreparation {
  const state = decodeState(rawState);
  if (state.terminalStatus === null) {
    return BLOCKED_ACTIVE;
  }
  if (task.taskId !== state.taskId) {
    return BLOCKED_TASK_MISMATCH;
  }
  if (!isTaskRecoveryCapsuleCurrent(task, candidate)) {
    return BLOCKED_STALE_CONTEXT;
  }
  const current: TaskRecoveryCapsule = buildTaskRecoveryCapsule(task);
  return Object.freeze({
    kind: "ready",
    taskId: state.taskId,
    threadId: state.threadId,
    previousTurnId: state.turnId,
    terminalStatus: state.terminalStatus,
    resultTrust: state.resultTrust,
    fence: current.fence,
    input: current.input,
  });
}

type MutableStateFields = {
  taskId: string;
  threadId: string;
  turnId: string;
  turnStartedObserved: boolean;
  terminalStatus: TaskRecoveryTurnTerminalStatus | null;
  compactions: readonly TaskRecoveryCompactionObservation[];
};

function materializeState(input: MutableStateFields): TaskRecoveryBoundaryState {
  const compactions = Object.freeze(
    input.compactions.map((item) => Object.freeze({ ...item })).sort(compareCompactionObservations),
  );
  const terminal = input.terminalStatus !== null;
  return Object.freeze({
    schemaVersion: 1 as const,
    taskId: input.taskId,
    threadId: input.threadId,
    turnId: input.turnId,
    turnStartedObserved: input.turnStartedObserved,
    terminalStatus: input.terminalStatus,
    compactions,
    phase: terminal ? ("terminal" as const) : ("active" as const),
    resultTrust: compactions.length > 0 ? ("revalidation_required" as const) : ("normal" as const),
    nextTurnRecovery: terminal ? ("required" as const) : ("blocked" as const),
  });
}

function decodeState(input: unknown): TaskRecoveryBoundaryState {
  try {
    const record = requireExactRecord(
      input,
      [
        "compactions",
        "nextTurnRecovery",
        "phase",
        "resultTrust",
        "schemaVersion",
        "taskId",
        "terminalStatus",
        "threadId",
        "turnId",
        "turnStartedObserved",
      ],
      "invalid_state",
    );
    if (record.schemaVersion !== 1 || typeof record.turnStartedObserved !== "boolean") {
      throw new TaskRecoveryBoundaryError("invalid_state");
    }
    const terminalStatus = requireTerminalStatus(record.terminalStatus, true, "invalid_state");
    if (
      !Array.isArray(record.compactions) ||
      record.compactions.length > MAX_COMPACTION_OBSERVATIONS
    ) {
      throw new TaskRecoveryBoundaryError("invalid_state");
    }
    const compactions = record.compactions.map((item) => decodeCompactionObservation(item));
    for (let index = 1; index < compactions.length; index += 1) {
      if (compareCompactionObservations(compactions[index - 1]!, compactions[index]!) >= 0) {
        throw new TaskRecoveryBoundaryError("invalid_state");
      }
    }
    const decoded = materializeState({
      taskId: requireUuid(record.taskId, "invalid_state"),
      threadId: requireAppServerIdentifier(record.threadId, "invalid_state"),
      turnId: requireAppServerIdentifier(record.turnId, "invalid_state"),
      turnStartedObserved: record.turnStartedObserved,
      terminalStatus,
      compactions,
    });
    if (
      record.phase !== decoded.phase ||
      record.resultTrust !== decoded.resultTrust ||
      record.nextTurnRecovery !== decoded.nextTurnRecovery
    ) {
      throw new TaskRecoveryBoundaryError("invalid_state");
    }
    return decoded;
  } catch (error: unknown) {
    throw mapBoundaryError(error, "invalid_state");
  }
}

function decodeCompactionObservation(input: unknown): TaskRecoveryCompactionObservation {
  const record = requireExactRecord(
    input,
    ["completedObserved", "itemId", "startedObserved", "turnSummaryObserved"],
    "invalid_state",
  );
  if (
    typeof record.startedObserved !== "boolean" ||
    typeof record.completedObserved !== "boolean" ||
    typeof record.turnSummaryObserved !== "boolean" ||
    (!record.startedObserved && !record.completedObserved && !record.turnSummaryObserved)
  ) {
    throw new TaskRecoveryBoundaryError("invalid_state");
  }
  return Object.freeze({
    itemId: requireAppServerIdentifier(record.itemId, "invalid_state"),
    startedObserved: record.startedObserved,
    completedObserved: record.completedObserved,
    turnSummaryObserved: record.turnSummaryObserved,
  });
}

function decodeSignal(input: unknown): TaskRecoveryLifecycleSignal {
  const record = requireRecord(input, "invalid_signal");
  if (record.type === "turn_started") {
    requireExactKeys(record, ["threadId", "turnId", "type"], "invalid_signal");
    return Object.freeze({
      type: "turn_started",
      threadId: requireAppServerIdentifier(record.threadId, "invalid_signal"),
      turnId: requireAppServerIdentifier(record.turnId, "invalid_signal"),
    });
  }
  if (record.type === "turn_completed") {
    requireExactKeys(
      record,
      ["contextCompactionItemIds", "status", "threadId", "turnId", "type"],
      "invalid_signal",
    );
    return Object.freeze({
      type: "turn_completed",
      threadId: requireAppServerIdentifier(record.threadId, "invalid_signal"),
      turnId: requireAppServerIdentifier(record.turnId, "invalid_signal"),
      status: requireTerminalStatus(record.status, false, "invalid_signal"),
      contextCompactionItemIds: requireIdentifierArray(
        record.contextCompactionItemIds,
        "invalid_signal",
      ),
    });
  }
  if (
    record.type === "context_compaction_started" ||
    record.type === "context_compaction_completed"
  ) {
    requireExactKeys(record, ["itemId", "threadId", "turnId", "type"], "invalid_signal");
    return Object.freeze({
      type: record.type,
      threadId: requireAppServerIdentifier(record.threadId, "invalid_signal"),
      turnId: requireAppServerIdentifier(record.turnId, "invalid_signal"),
      itemId: requireAppServerIdentifier(record.itemId, "invalid_signal"),
    });
  }
  throw new TaskRecoveryBoundaryError("invalid_signal");
}

function mergeCompactionObservation(
  items: Map<string, TaskRecoveryCompactionObservation>,
  itemId: string,
  observation: "completed" | "started" | "turn_summary",
): boolean {
  const existing = items.get(itemId);
  if (existing === undefined && items.size >= MAX_COMPACTION_OBSERVATIONS) {
    throw new TaskRecoveryBoundaryError("capacity_exceeded");
  }
  const current = existing ?? {
    itemId,
    startedObserved: false,
    completedObserved: false,
    turnSummaryObserved: false,
  };
  const field =
    observation === "started"
      ? "startedObserved"
      : observation === "completed"
        ? "completedObserved"
        : "turnSummaryObserved";
  if (current[field]) {
    return false;
  }
  items.set(itemId, Object.freeze({ ...current, [field]: true }));
  return true;
}

function compareCompactionObservations(
  left: TaskRecoveryCompactionObservation,
  right: TaskRecoveryCompactionObservation,
): number {
  return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
}

function requireExactRecord(
  input: unknown,
  keys: readonly string[],
  code: TaskRecoveryBoundaryErrorCode,
): Record<string, unknown> {
  const record = requireRecord(input, code);
  requireExactKeys(record, keys, code);
  return record;
}

function requireRecord(
  input: unknown,
  code: TaskRecoveryBoundaryErrorCode,
): Record<string, unknown> {
  if (
    !validateJsonValue(input).ok ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new TaskRecoveryBoundaryError(code);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  code: TaskRecoveryBoundaryErrorCode,
): void {
  const actual = Object.keys(input).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TaskRecoveryBoundaryError(code);
  }
}

function requireUuid(input: unknown, code: TaskRecoveryBoundaryErrorCode): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new TaskRecoveryBoundaryError(code);
  }
  return input;
}

function requireAppServerIdentifier(input: unknown, code: TaskRecoveryBoundaryErrorCode): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > MAX_APP_SERVER_IDENTIFIER_CHARACTERS
  ) {
    throw new TaskRecoveryBoundaryError(code);
  }
  return input;
}

function requireTerminalStatus(
  input: unknown,
  nullable: false,
  code: TaskRecoveryBoundaryErrorCode,
): TaskRecoveryTurnTerminalStatus;
function requireTerminalStatus(
  input: unknown,
  nullable: true,
  code: TaskRecoveryBoundaryErrorCode,
): TaskRecoveryTurnTerminalStatus | null;
function requireTerminalStatus(
  input: unknown,
  nullable: boolean,
  code: TaskRecoveryBoundaryErrorCode,
): TaskRecoveryTurnTerminalStatus | null {
  if (nullable && input === null) {
    return null;
  }
  if (input !== "completed" && input !== "failed" && input !== "interrupted") {
    throw new TaskRecoveryBoundaryError(code);
  }
  return input;
}

function requireIdentifierArray(
  input: unknown,
  code: TaskRecoveryBoundaryErrorCode,
): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TaskRecoveryBoundaryError(code);
  }
  if (input.length > MAX_COMPACTION_OBSERVATIONS) {
    throw new TaskRecoveryBoundaryError("capacity_exceeded");
  }
  const values = input.map((value) => requireAppServerIdentifier(value, code));
  if (new Set(values).size !== values.length) {
    throw new TaskRecoveryBoundaryError(code);
  }
  return Object.freeze(values);
}

function mapBoundaryError(
  error: unknown,
  fallback: TaskRecoveryBoundaryErrorCode,
): TaskRecoveryBoundaryError {
  return error instanceof TaskRecoveryBoundaryError
    ? error
    : new TaskRecoveryBoundaryError(fallback);
}
