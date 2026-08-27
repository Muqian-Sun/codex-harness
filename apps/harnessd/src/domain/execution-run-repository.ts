import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";

import {
  TASK_OPERATION_KINDS,
  TASK_EXECUTION_RUN_STATUSES,
  TASK_EXECUTION_TERMINAL_REASONS,
  validateJsonValue,
  type HarnessTaskExecutionGetResult,
  type HarnessTaskExecutionRunStatus,
  type HarnessTaskExecutionTerminalReason,
  type HarnessTaskOperationKind,
  type JsonValue,
} from "@codex-harness/protocol";

import {
  EventStoreError,
  type EventMetadata,
  type HarnessEventStore,
  type ProjectionDefinition,
  type StoredEvent,
} from "../persistence/event-store.js";
import type { VerifiedMacosWorkspaceSnapshotV2 } from "../runtime/macos-workspace-admission-observer.js";
import { TaskPlanRepository } from "./task-plan-store.js";

export const EXECUTION_RUN_STREAM_TYPE = "execution.run";
export const EXECUTION_RUN_STARTED = "execution.run_started";
export const EXECUTION_RUN_BOUND = "execution.run_bound";
export const EXECUTION_RUN_EVIDENCE = "execution.run_evidence_observed";
export const EXECUTION_RUN_INTERRUPT_REQUESTED = "execution.run_interrupt_requested";
export const EXECUTION_RUN_FINISHED = "execution.run_finished";
const PROJECTION_NAME = "execution.runs";
const PROBE_KEY = "id/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000";
const ACTIVE_KEY = "active";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_HEAD_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TERMINAL_STATUSES = new Set<HarnessTaskExecutionRunStatus>([
  "succeeded",
  "failed",
  "blocked",
  "interrupted",
]);

type PublicCommandEvidence = HarnessTaskExecutionGetResult["commands"][number];
type PublicFileEvidence = HarnessTaskExecutionGetResult["files"][number];
export type ExecutionRunFinalResult = Readonly<{
  outcome: "completed" | "blocked";
  summary: string;
  validationCommands: readonly string[];
  changedFiles: readonly Readonly<{
    path: string;
    changeKind: "add" | "delete" | "update";
  }>[];
  acceptanceCriteria: readonly Readonly<{
    criterion: string;
    passed: boolean;
    evidence: string;
  }>[];
}>;
export type ExecutionRunRoute = Readonly<{
  tier: "fast" | "standard" | "deep";
  provider: string;
  model: string;
  reasoningEffort: string;
}>;
export type ExecutionRunPermission = Readonly<{
  workspaceMode: "read_only" | "workspace_write";
  commandExecution: boolean;
  networkAccess: false;
  allowedOperationKinds: readonly HarnessTaskOperationKind[];
}>;

export type ExecutionRunCommandEvidence = PublicCommandEvidence &
  Readonly<{ sourceItemId: string }>;
export type ExecutionRunFileEvidence = PublicFileEvidence & Readonly<{ sourceItemId: string }>;

export type ExecutionRunRecord = Readonly<{
  schemaVersion: 1;
  runId: string;
  taskId: string;
  nodeId: string;
  activationId: string;
  graphRevisionId: string;
  manifestId: string;
  attemptNumber: number;
  runVersion: number;
  taskVersionAtStart: number;
  status: HarnessTaskExecutionRunStatus;
  route: ExecutionRunRoute;
  permission: ExecutionRunPermission;
  workspaceBefore: VerifiedMacosWorkspaceSnapshotV2;
  workspaceAfter: VerifiedMacosWorkspaceSnapshotV2 | null;
  threadId: string | null;
  turnId: string | null;
  commands: readonly ExecutionRunCommandEvidence[];
  files: readonly ExecutionRunFileEvidence[];
  finalResult: ExecutionRunFinalResult | null;
  terminalReason: HarnessTaskExecutionTerminalReason | null;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
}>;

export type StartExecutionRunInput = Readonly<{
  run: ExecutionRunRecord;
  expectedTaskVersion: number;
  metadata?: EventMetadata;
}>;

export type BindExecutionRunInput = Readonly<{
  eventId: string;
  taskId: string;
  runId: string;
  expectedRunVersion: number;
  threadId: string;
  turnId: string;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type AppendExecutionRunEvidenceInput = Readonly<{
  eventId: string;
  taskId: string;
  runId: string;
  expectedRunVersion: number;
  evidence:
    | Readonly<{ kind: "command"; value: ExecutionRunCommandEvidence }>
    | Readonly<{ kind: "file"; value: ExecutionRunFileEvidence }>;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type RequestExecutionRunInterruptInput = Readonly<{
  eventId: string;
  taskId: string;
  runId: string;
  expectedRunVersion: number;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type FinishExecutionRunInput = Readonly<{
  eventId: string;
  taskId: string;
  runId: string;
  expectedRunVersion: number;
  expectedTaskVersion: number;
  status: "succeeded" | "failed" | "blocked" | "interrupted";
  terminalReason: HarnessTaskExecutionTerminalReason;
  finalResult: ExecutionRunFinalResult | null;
  workspaceAfter: VerifiedMacosWorkspaceSnapshotV2 | null;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type ExecutionRunCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  run: ExecutionRunRecord;
}>;

export type ExecutionRunRepositoryErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

export class ExecutionRunRepositoryError extends Error {
  readonly code: ExecutionRunRepositoryErrorCode;

  constructor(code: ExecutionRunRepositoryErrorCode) {
    super(`The execution run repository failed: ${code}.`);
    this.name = "ExecutionRunRepositoryError";
    this.code = code;
  }
}

class ExecutionRunStateError extends Error {}

export const EXECUTION_RUN_PROJECTION: ProjectionDefinition = Object.freeze({
  name: PROJECTION_NAME,
  version: 1,
  selectKeys: (event) => {
    if (
      event.streamType !== EXECUTION_RUN_STREAM_TYPE ||
      !RUN_EVENT_TYPES.has(event.eventType) ||
      !isUuid(event.streamId)
    ) {
      return [];
    }
    const data = decodeEventData(event);
    return event.eventType === EXECUTION_RUN_STARTED || event.eventType === EXECUTION_RUN_FINISHED
      ? [idKey(data.taskId, data.runId), nodeKey(data.taskId, data.nodeId), ACTIVE_KEY]
      : [idKey(data.taskId, data.runId), nodeKey(data.taskId, data.nodeId)];
  },
  reduce: ({ key, current, event }) => {
    const data = decodeEventData(event);
    if (key === ACTIVE_KEY) {
      if (event.eventType === EXECUTION_RUN_STARTED) {
        if (current !== undefined) throw new ExecutionRunStateError();
        return {
          type: "set",
          state: requireJson({ schemaVersion: 1, taskId: data.taskId, runId: data.runId }),
        };
      }
      if (current === undefined) throw new ExecutionRunStateError();
      const active = exactRecord(current, ["runId", "schemaVersion", "taskId"]);
      if (
        active.schemaVersion !== 1 ||
        active.taskId !== data.taskId ||
        active.runId !== data.runId
      ) {
        throw new ExecutionRunStateError();
      }
      return { type: "delete" };
    }
    if (key.startsWith("node/") && event.eventType === EXECUTION_RUN_STARTED) {
      const next = reduceRun(undefined, event, data);
      if (current === undefined) {
        if (next.attemptNumber !== 1) throw new ExecutionRunStateError();
        return { type: "set", state: requireJson(next) };
      }
      const previous = decodeRun(current);
      if (
        !TERMINAL_STATUSES.has(previous.status) ||
        previous.taskId !== next.taskId ||
        previous.nodeId !== next.nodeId ||
        next.attemptNumber !== previous.attemptNumber + 1 ||
        next.startedAtMs < previous.updatedAtMs
      ) {
        throw new ExecutionRunStateError();
      }
      return { type: "set", state: requireJson(next) };
    }
    const next = reduceRun(current, event, data);
    return { type: "set", state: requireJson(next) };
  },
});

const RUN_EVENT_TYPES = new Set([
  EXECUTION_RUN_STARTED,
  EXECUTION_RUN_BOUND,
  EXECUTION_RUN_EVIDENCE,
  EXECUTION_RUN_INTERRUPT_REQUESTED,
  EXECUTION_RUN_FINISHED,
]);

export class ExecutionRunRepository {
  readonly #events: HarnessEventStore;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(PROJECTION_NAME, PROBE_KEY);
      new TaskPlanRepository(events);
      this.#events = events;
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  start(input: StartExecutionRunInput): ExecutionRunCommandResult {
    let run: ExecutionRunRecord;
    try {
      run = decodeRun(input.run);
      if (
        run.status !== "running" ||
        run.runVersion !== 1 ||
        run.threadId !== null ||
        run.turnId !== null ||
        run.commands.length !== 0 ||
        run.files.length !== 0 ||
        run.workspaceAfter !== null ||
        run.finalResult !== null ||
        run.terminalReason !== null ||
        run.completedAtMs !== null ||
        run.workspaceBefore.changedPaths.length !== 0 ||
        run.workspaceBefore.statusDigest !== digest("") ||
        run.workspaceBefore.contentDigest !== digest("\0\0") ||
        positive(input.expectedTaskVersion) !== run.taskVersionAtStart
      ) {
        fail();
      }
      return this.#append(
        run.runId,
        run.taskId,
        EXECUTION_RUN_STARTED,
        run.startedAtMs,
        {
          schemaVersion: 1,
          taskId: run.taskId,
          runId: run.runId,
          nodeId: run.nodeId,
          expectedTaskVersion: input.expectedTaskVersion,
          run: requireJson(run),
        },
        input.metadata,
      );
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  bind(input: BindExecutionRunInput): ExecutionRunCommandResult {
    return this.#transition(EXECUTION_RUN_BOUND, input.eventId, input, {
      schemaVersion: 1,
      taskId: input.taskId,
      runId: input.runId,
      nodeId: this.readRun(input.taskId, input.runId).nodeId,
      expectedRunVersion: input.expectedRunVersion,
      threadId: input.threadId,
      turnId: input.turnId,
    });
  }

  appendEvidence(input: AppendExecutionRunEvidenceInput): ExecutionRunCommandResult {
    return this.#transition(EXECUTION_RUN_EVIDENCE, input.eventId, input, {
      schemaVersion: 1,
      taskId: input.taskId,
      runId: input.runId,
      nodeId: this.readRun(input.taskId, input.runId).nodeId,
      expectedRunVersion: input.expectedRunVersion,
      evidence: requireJson(input.evidence),
    });
  }

  requestInterrupt(input: RequestExecutionRunInterruptInput): ExecutionRunCommandResult {
    return this.#transition(EXECUTION_RUN_INTERRUPT_REQUESTED, input.eventId, input, {
      schemaVersion: 1,
      taskId: input.taskId,
      runId: input.runId,
      nodeId: this.readRun(input.taskId, input.runId).nodeId,
      expectedRunVersion: input.expectedRunVersion,
    });
  }

  finish(input: FinishExecutionRunInput): ExecutionRunCommandResult {
    return this.#transition(EXECUTION_RUN_FINISHED, input.eventId, input, {
      schemaVersion: 1,
      taskId: input.taskId,
      runId: input.runId,
      nodeId: this.readRun(input.taskId, input.runId).nodeId,
      expectedRunVersion: input.expectedRunVersion,
      expectedTaskVersion: input.expectedTaskVersion,
      status: input.status,
      terminalReason: input.terminalReason,
      finalResult: input.finalResult,
      workspaceAfter: input.workspaceAfter,
    });
  }

  readRun(taskId: string, runId: string): ExecutionRunRecord {
    if (!isUuid(taskId) || !isUuid(runId)) throw new ExecutionRunRepositoryError("invalid_input");
    try {
      const state = this.#events.readProjectionState(PROJECTION_NAME, idKey(taskId, runId));
      if (state === undefined) throw new ExecutionRunRepositoryError("not_found");
      return decodeRun(state.state);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  readLatestForNode(taskId: string, nodeId: string): ExecutionRunRecord | null {
    if (!isUuid(taskId) || !isUuid(nodeId)) throw new ExecutionRunRepositoryError("invalid_input");
    try {
      const state = this.#events.readProjectionState(PROJECTION_NAME, nodeKey(taskId, nodeId));
      return state === undefined ? null : decodeRun(state.state);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  readActive(): ExecutionRunRecord | null {
    try {
      const state = this.#events.readProjectionState(PROJECTION_NAME, ACTIVE_KEY);
      if (state === undefined) return null;
      const active = exactRecord(state.state, ["runId", "schemaVersion", "taskId"]);
      if (active.schemaVersion !== 1) fail();
      return this.readRun(uuid(active.taskId), uuid(active.runId));
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  #transition(
    eventType: string,
    eventId: string,
    input: Readonly<{
      taskId: string;
      runId: string;
      occurredAtMs: number;
      metadata?: EventMetadata;
    }>,
    payload: unknown,
  ): ExecutionRunCommandResult {
    try {
      return this.#append(
        eventId,
        input.taskId,
        eventType,
        input.occurredAtMs,
        payload,
        input.metadata,
      );
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  #append(
    eventId: string,
    taskId: string,
    eventType: string,
    occurredAtMs: number,
    payload: unknown,
    metadata: EventMetadata | undefined,
  ): ExecutionRunCommandResult {
    if (!isUuid(eventId) || !isUuid(taskId) || !RUN_EVENT_TYPES.has(eventType)) fail();
    const appended = this.#events.append({
      eventId,
      streamType: EXECUTION_RUN_STREAM_TYPE,
      streamId: taskId,
      eventType,
      eventVersion: 1,
      occurredAtMs: nonNegative(occurredAtMs),
      payload: requireJson(payload),
      ...(metadata === undefined ? {} : { metadata }),
    });
    return Object.freeze({
      duplicate: appended.duplicate,
      event: appended.event,
      run: this.readRun(taskId, decodeEventData(appended.event).runId),
    });
  }
}

type EventData = Readonly<{
  taskId: string;
  runId: string;
  nodeId: string;
  payload: Record<string, unknown>;
}>;

function decodeEventData(event: StoredEvent): EventData {
  if (
    event.streamType !== EXECUTION_RUN_STREAM_TYPE ||
    !RUN_EVENT_TYPES.has(event.eventType) ||
    event.eventVersion !== 1
  )
    fail();
  const payload = record(event.payload);
  const taskId = uuid(payload.taskId);
  const runId = uuid(payload.runId);
  const nodeId = uuid(payload.nodeId);
  if (taskId !== event.streamId) fail();
  return Object.freeze({ taskId, runId, nodeId, payload });
}

function reduceRun(
  current: JsonValue | undefined,
  event: StoredEvent,
  data: EventData,
): ExecutionRunRecord {
  if (event.eventType === EXECUTION_RUN_STARTED) {
    if (current !== undefined || data.payload.schemaVersion !== 1) fail();
    const run = decodeRun(data.payload.run);
    if (
      run.taskId !== data.taskId ||
      run.runId !== data.runId ||
      run.nodeId !== data.nodeId ||
      run.startedAtMs !== event.occurredAtMs ||
      run.taskVersionAtStart !== positive(data.payload.expectedTaskVersion)
    )
      fail();
    return run;
  }
  if (current === undefined) fail();
  const run = decodeRun(current);
  if (run.taskId !== data.taskId || run.runId !== data.runId || run.nodeId !== data.nodeId) fail();
  const expectedRunVersion = positive(data.payload.expectedRunVersion);
  if (
    run.runVersion !== expectedRunVersion ||
    TERMINAL_STATUSES.has(run.status) ||
    event.occurredAtMs < run.updatedAtMs
  )
    fail();
  if (event.eventType === EXECUTION_RUN_BOUND) {
    if (run.threadId !== null || run.turnId !== null || data.payload.schemaVersion !== 1) fail();
    return freezeRun({
      ...run,
      runVersion: run.runVersion + 1,
      threadId: identifier(data.payload.threadId),
      turnId: identifier(data.payload.turnId),
      updatedAtMs: event.occurredAtMs,
    });
  }
  if (event.eventType === EXECUTION_RUN_EVIDENCE) {
    if (run.threadId === null || run.turnId === null || data.payload.schemaVersion !== 1) fail();
    const evidence = decodeEvidence(data.payload.evidence);
    const sourceIds = new Set([...run.commands, ...run.files].map((item) => item.sourceItemId));
    if (sourceIds.has(evidence.value.sourceItemId)) fail();
    if (evidence.kind === "command") {
      if (
        run.commands.length >= 64 ||
        evidence.value.sequence !== run.commands.length + run.files.length + 1
      )
        fail();
      return freezeRun({
        ...run,
        runVersion: run.runVersion + 1,
        commands: Object.freeze([...run.commands, evidence.value]),
        updatedAtMs: event.occurredAtMs,
      });
    }
    if (
      run.files.length >= 128 ||
      evidence.value.sequence !== run.commands.length + run.files.length + 1
    )
      fail();
    return freezeRun({
      ...run,
      runVersion: run.runVersion + 1,
      files: Object.freeze([...run.files, evidence.value]),
      updatedAtMs: event.occurredAtMs,
    });
  }
  if (event.eventType === EXECUTION_RUN_INTERRUPT_REQUESTED) {
    if (run.status === "stopping") fail();
    return freezeRun({
      ...run,
      runVersion: run.runVersion + 1,
      status: "stopping",
      updatedAtMs: event.occurredAtMs,
    });
  }
  if (data.payload.schemaVersion !== 1) fail();
  const status = terminalStatus(data.payload.status);
  const terminalReason = terminalReasonValue(data.payload.terminalReason);
  const finalResult =
    data.payload.finalResult === null ? null : decodeFinalResult(data.payload.finalResult);
  const workspaceAfter =
    data.payload.workspaceAfter === null ? null : decodeWorkspace(data.payload.workspaceAfter);
  if (positive(data.payload.expectedTaskVersion) < run.taskVersionAtStart) fail();
  return freezeRun({
    ...run,
    runVersion: run.runVersion + 1,
    status,
    workspaceAfter,
    finalResult,
    terminalReason,
    updatedAtMs: event.occurredAtMs,
    completedAtMs: event.occurredAtMs,
  });
}

function decodeRun(input: unknown): ExecutionRunRecord {
  const value = exactRecord(input, [
    "activationId",
    "attemptNumber",
    "commands",
    "completedAtMs",
    "files",
    "finalResult",
    "graphRevisionId",
    "manifestId",
    "nodeId",
    "permission",
    "route",
    "runId",
    "runVersion",
    "schemaVersion",
    "startedAtMs",
    "status",
    "taskId",
    "taskVersionAtStart",
    "terminalReason",
    "threadId",
    "turnId",
    "updatedAtMs",
    "workspaceAfter",
    "workspaceBefore",
  ]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.commands) || !Array.isArray(value.files))
    fail();
  const status = runStatus(value.status);
  const terminal = TERMINAL_STATUSES.has(status);
  const commands = Object.freeze(value.commands.map(decodeCommandEvidence));
  const files = Object.freeze(value.files.map(decodeFileEvidence));
  const finalResult = value.finalResult === null ? null : decodeFinalResult(value.finalResult);
  const terminalReason =
    value.terminalReason === null ? null : terminalReasonValue(value.terminalReason);
  const completedAtMs = value.completedAtMs === null ? null : nonNegative(value.completedAtMs);
  const workspaceAfter =
    value.workspaceAfter === null ? null : decodeWorkspace(value.workspaceAfter);
  const threadId = nullableIdentifier(value.threadId);
  const turnId = nullableIdentifier(value.turnId);
  const startedAtMs = nonNegative(value.startedAtMs);
  const updatedAtMs = nonNegative(value.updatedAtMs);
  const evidence = [...commands, ...files].sort((left, right) => left.sequence - right.sequence);
  const sourceItemIds = [...commands, ...files].map((item) => item.sourceItemId);
  if (
    commands.length > 64 ||
    files.length > 128 ||
    evidence.some((item, index) => item.sequence !== index + 1) ||
    new Set(sourceItemIds).size !== sourceItemIds.length ||
    (threadId === null) !== (turnId === null) ||
    startedAtMs > updatedAtMs ||
    terminal !== (terminalReason !== null && completedAtMs !== null) ||
    (!terminal && (finalResult !== null || workspaceAfter !== null)) ||
    (completedAtMs !== null && completedAtMs !== updatedAtMs) ||
    (status === "succeeded" &&
      (terminalReason !== "completed" || finalResult === null || workspaceAfter === null)) ||
    (terminal && terminalReason !== null && !validTerminalReason(status, terminalReason))
  )
    fail();
  return freezeRun({
    schemaVersion: 1,
    runId: uuid(value.runId),
    taskId: uuid(value.taskId),
    nodeId: uuid(value.nodeId),
    activationId: uuid(value.activationId),
    graphRevisionId: uuid(value.graphRevisionId),
    manifestId: uuid(value.manifestId),
    attemptNumber: positive(value.attemptNumber),
    runVersion: positive(value.runVersion),
    taskVersionAtStart: positive(value.taskVersionAtStart),
    status,
    route: decodeRoute(value.route),
    permission: decodePermission(value.permission),
    workspaceBefore: decodeWorkspace(value.workspaceBefore),
    workspaceAfter,
    threadId,
    turnId,
    commands,
    files,
    finalResult,
    terminalReason,
    startedAtMs,
    updatedAtMs,
    completedAtMs,
  });
}

function decodeEvidence(input: unknown): AppendExecutionRunEvidenceInput["evidence"] {
  const value = record(input);
  if (value.kind === "command")
    return Object.freeze({ kind: "command", value: decodeCommandEvidence(value.value) });
  if (value.kind === "file")
    return Object.freeze({ kind: "file", value: decodeFileEvidence(value.value) });
  fail();
}

function decodeCommandEvidence(input: unknown): ExecutionRunCommandEvidence {
  const value = exactRecord(input, [
    "command",
    "durationMs",
    "exitCode",
    "outputBytes",
    "outputDigest",
    "sequence",
    "sourceItemId",
    "status",
  ]);
  return Object.freeze({
    sequence: positive(value.sequence),
    sourceItemId: identifier(value.sourceItemId),
    command: text(value.command, 8_192),
    status: toolStatus(value.status),
    exitCode:
      value.exitCode === null ? null : integer(value.exitCode, -2_147_483_648, 2_147_483_647),
    durationMs: value.durationMs === null ? null : nonNegative(value.durationMs),
    outputBytes: nonNegative(value.outputBytes),
    outputDigest: sha(value.outputDigest),
  });
}

function decodeFileEvidence(input: unknown): ExecutionRunFileEvidence {
  const value = exactRecord(input, [
    "changeKind",
    "diffDigest",
    "path",
    "sequence",
    "sourceItemId",
    "status",
  ]);
  const path = text(value.path, 4_096);
  if (posix.isAbsolute(path) || path.split("/").includes("..") || path.includes("\\")) fail();
  return Object.freeze({
    sequence: positive(value.sequence),
    sourceItemId: identifier(value.sourceItemId),
    path,
    changeKind: changeKind(value.changeKind),
    status: toolStatus(value.status),
    diffDigest: sha(value.diffDigest),
  });
}

function decodeFinalResult(input: unknown): ExecutionRunFinalResult {
  const value = exactRecord(input, [
    "acceptanceCriteria",
    "changedFiles",
    "outcome",
    "summary",
    "validationCommands",
  ]);
  if (
    !Array.isArray(value.validationCommands) ||
    !Array.isArray(value.changedFiles) ||
    !Array.isArray(value.acceptanceCriteria)
  )
    fail();
  if (
    value.validationCommands.length > 64 ||
    value.changedFiles.length > 128 ||
    value.acceptanceCriteria.length > 100
  )
    fail();
  const outcome =
    value.outcome === "completed" || value.outcome === "blocked" ? value.outcome : fail();
  return Object.freeze({
    outcome,
    summary: text(value.summary, 65_536),
    validationCommands: Object.freeze(
      value.validationCommands.map((command) => text(command, 8_192)),
    ),
    changedFiles: Object.freeze(
      value.changedFiles.map((item) => {
        const entry = exactRecord(item, ["changeKind", "path"]);
        const path = text(entry.path, 4_096);
        if (posix.isAbsolute(path) || path.split("/").includes("..") || path.includes("\\")) fail();
        return Object.freeze({ path, changeKind: changeKind(entry.changeKind) });
      }),
    ),
    acceptanceCriteria: Object.freeze(
      value.acceptanceCriteria.map((item) => {
        const entry = exactRecord(item, ["criterion", "evidence", "passed"]);
        if (typeof entry.passed !== "boolean") fail();
        return Object.freeze({
          criterion: text(entry.criterion, 4096),
          passed: entry.passed,
          evidence: text(entry.evidence, 8192),
        });
      }),
    ),
  });
}

function decodeRoute(input: unknown): ExecutionRunRoute {
  const value = exactRecord(input, ["model", "provider", "reasoningEffort", "tier"]);
  if (value.tier !== "fast" && value.tier !== "standard" && value.tier !== "deep") fail();
  return Object.freeze({
    tier: value.tier,
    provider: text(value.provider, 256),
    model: text(value.model, 4096),
    reasoningEffort: text(value.reasoningEffort, 128),
  });
}

function decodePermission(input: unknown): ExecutionRunPermission {
  const value = exactRecord(input, [
    "allowedOperationKinds",
    "commandExecution",
    "networkAccess",
    "workspaceMode",
  ]);
  if (
    (value.workspaceMode !== "read_only" && value.workspaceMode !== "workspace_write") ||
    typeof value.commandExecution !== "boolean" ||
    value.networkAccess !== false ||
    !Array.isArray(value.allowedOperationKinds)
  )
    fail();
  const allowedOperationKinds = value.allowedOperationKinds.map((kind) => {
    const normalized = text(kind, 128);
    if (!TASK_OPERATION_KINDS.includes(normalized as (typeof TASK_OPERATION_KINDS)[number])) fail();
    return normalized as (typeof TASK_OPERATION_KINDS)[number];
  });
  if (
    allowedOperationKinds.length < 1 ||
    allowedOperationKinds.length > 256 ||
    new Set(allowedOperationKinds).size !== allowedOperationKinds.length
  )
    fail();
  return Object.freeze({
    workspaceMode: value.workspaceMode,
    commandExecution: value.commandExecution,
    networkAccess: false,
    allowedOperationKinds: Object.freeze(allowedOperationKinds),
  });
}

function decodeWorkspace(input: unknown): VerifiedMacosWorkspaceSnapshotV2 {
  const value = exactRecord(input, [
    "canonicalPath",
    "changedPaths",
    "contentDigest",
    "deviceId",
    "gitHead",
    "inode",
    "observedAtMs",
    "platform",
    "policyVersion",
    "schemaVersion",
    "statusDigest",
    "workspaceDigest",
  ]);
  if (
    value.schemaVersion !== 2 ||
    value.policyVersion !== "macos-workspace-admission-policy-v2" ||
    value.platform !== "macos" ||
    typeof value.gitHead !== "string" ||
    !GIT_HEAD_PATTERN.test(value.gitHead) ||
    !Array.isArray(value.changedPaths)
  )
    fail();
  const canonicalPath = text(value.canonicalPath, 16_384);
  if (!isAbsolute(canonicalPath) || canonicalPath.includes("\0") || value.changedPaths.length > 512)
    fail();
  const changedPaths = Object.freeze(
    value.changedPaths.map((path) => {
      const normalized = text(path, 16_384);
      if (
        posix.isAbsolute(normalized) ||
        normalized.split("/").includes("..") ||
        normalized.includes("\\")
      )
        fail();
      return normalized;
    }),
  );
  if (
    new Set(changedPaths).size !== changedPaths.length ||
    changedPaths.some((path, index) => index > 0 && changedPaths[index - 1]! > path)
  )
    fail();
  const deviceId = decimal(value.deviceId);
  const inode = decimal(value.inode);
  const statusDigest = sha(value.statusDigest);
  const contentDigest = sha(value.contentDigest);
  const workspaceDigest = sha(value.workspaceDigest);
  if (
    workspaceDigest !==
    digest(
      JSON.stringify({
        canonicalPath,
        changedPaths,
        contentDigest,
        deviceId,
        gitHead: value.gitHead,
        inode,
        statusDigest,
      }),
    )
  )
    fail();
  return Object.freeze({
    schemaVersion: 2,
    policyVersion: "macos-workspace-admission-policy-v2",
    platform: "macos",
    canonicalPath,
    deviceId,
    inode,
    gitHead: value.gitHead,
    statusDigest,
    contentDigest,
    changedPaths,
    workspaceDigest,
    observedAtMs: nonNegative(value.observedAtMs),
  });
}

function freezeRun(run: ExecutionRunRecord): ExecutionRunRecord {
  return Object.freeze(run);
}
function idKey(taskId: string, runId: string): string {
  return `id/${taskId}/${runId}`;
}
function nodeKey(taskId: string, nodeId: string): string {
  return `node/${taskId}/${nodeId}`;
}
function requireJson(input: unknown): JsonValue {
  const result = validateJsonValue(input);
  if (!result.ok) fail();
  return input as JsonValue;
}
function record(input: unknown): Record<string, unknown> {
  if (
    !validateJsonValue(input).ok ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  )
    fail();
  return input as Record<string, unknown>;
}
function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = record(input);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail();
  return value;
}
function uuid(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) fail();
  return input;
}
function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}
function identifier(input: unknown): string {
  return text(input, 256);
}
function nullableIdentifier(input: unknown): string | null {
  return input === null ? null : identifier(input);
}
function text(input: unknown, max: number): string {
  if (typeof input !== "string" || input.length < 1 || input.length > max || input.includes("\0"))
    fail();
  return input;
}
function sha(input: unknown): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) fail();
  return input;
}
function decimal(input: unknown): string {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(input)) fail();
  return input;
}
function integer(input: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max) fail();
  return input as number;
}
function positive(input: unknown): number {
  return integer(input, 1, Number.MAX_SAFE_INTEGER);
}
function nonNegative(input: unknown): number {
  return integer(input, 0, Number.MAX_SAFE_INTEGER);
}
function runStatus(input: unknown): HarnessTaskExecutionRunStatus {
  if (
    typeof input !== "string" ||
    !TASK_EXECUTION_RUN_STATUSES.includes(input as HarnessTaskExecutionRunStatus)
  )
    fail();
  return input as HarnessTaskExecutionRunStatus;
}
function terminalStatus(input: unknown): "succeeded" | "failed" | "blocked" | "interrupted" {
  const status = runStatus(input);
  if (!TERMINAL_STATUSES.has(status)) fail();
  return status as "succeeded" | "failed" | "blocked" | "interrupted";
}
function terminalReasonValue(input: unknown): HarnessTaskExecutionTerminalReason {
  if (
    typeof input !== "string" ||
    !TASK_EXECUTION_TERMINAL_REASONS.includes(input as HarnessTaskExecutionTerminalReason)
  )
    fail();
  return input as HarnessTaskExecutionTerminalReason;
}
function validTerminalReason(
  status: HarnessTaskExecutionRunStatus,
  reason: HarnessTaskExecutionTerminalReason,
): boolean {
  if (status === "succeeded") return reason === "completed";
  if (status === "failed") {
    return ["turn_failed", "tool_failed", "forbidden_tool", "worker_unavailable"].includes(reason);
  }
  if (status === "blocked") {
    return ["evidence_missing", "evidence_mismatch", "workspace_changed"].includes(reason);
  }
  if (status === "interrupted") {
    return reason === "user_interrupted" || reason === "daemon_restarted";
  }
  return false;
}
function toolStatus(input: unknown): "completed" | "failed" | "declined" {
  if (input !== "completed" && input !== "failed" && input !== "declined") fail();
  return input;
}
function changeKind(input: unknown): "add" | "delete" | "update" {
  if (input !== "add" && input !== "delete" && input !== "update") fail();
  return input;
}
function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
function fail(): never {
  throw new ExecutionRunStateError();
}
function mapError(error: unknown): ExecutionRunRepositoryError {
  if (error instanceof ExecutionRunRepositoryError) return error;
  if (error instanceof EventStoreError) {
    if (error.code === "closed") return new ExecutionRunRepositoryError("closed");
    if (error.code === "conflict") return new ExecutionRunRepositoryError("conflict");
    if (error.code === "invalid_event" || error.code === "invalid_query")
      return new ExecutionRunRepositoryError("invalid_input");
    return new ExecutionRunRepositoryError("storage_failure");
  }
  return new ExecutionRunRepositoryError(
    error instanceof ExecutionRunStateError ? "invalid_input" : "storage_failure",
  );
}
