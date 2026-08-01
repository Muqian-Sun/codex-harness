import { NamespacedTokenSchema, validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import {
  EventStoreError,
  HarnessEventStore,
  type EventMetadata,
  type EventStoreInspection,
  type ProjectionDefinition,
  type StoredEvent,
} from "../persistence/event-store.js";

const TASK_STREAM_TYPE = "task.plan";
const TASK_PROJECTION_NAME = "task.current_plan";
const TASK_CREATED = "task.created";
const REQUIREMENTS_REVISED = "task.requirements_revised";
const PLAN_REVISED = "task.plan_revised";
const TASK_EVENT_TYPES = new Set([TASK_CREATED, REQUIREMENTS_REVISED, PLAN_REVISED]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TITLE_BYTES = 256;
const MAX_SOURCE_TEXT_BYTES = 64 * 1024;
const MAX_OBJECTIVE_BYTES = 16 * 1024;
const MAX_ITEM_BYTES = 4 * 1024;
const MAX_STEP_TITLE_BYTES = 512;
const MAX_STEP_DESCRIPTION_BYTES = 8 * 1024;
const MAX_REQUIREMENT_ITEMS = 100;
const MAX_PLAN_STEPS = 200;
const MAX_REQUIREMENT_TOTAL_BYTES = 256 * 1024;
const MAX_PLAN_TOTAL_BYTES = 256 * 1024;

export type RequirementRevision = Readonly<{
  revisionId: string;
  revisionNumber: number;
  sourceText: string;
  objective: string;
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}>;

export type PlanStep = Readonly<{
  stepId: string;
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
}>;

export type PlanRevision = Readonly<{
  revisionId: string;
  revisionNumber: number;
  status: "candidate" | "confirmed";
  basedOnRequirementRevisionId: string;
  steps: readonly PlanStep[];
}>;

export type TaskPlanRecord = Readonly<{
  taskId: string;
  title: string;
  taskVersion: number;
  createdAtMs: number;
  updatedAtMs: number;
  activeRequirement: RequirementRevision;
  latestPlan: PlanRevision | null;
  confirmedPlan: PlanRevision | null;
}>;

export type RequirementDraft = Readonly<{
  revisionId: string;
  sourceText: string;
  objective: string;
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}>;

export type PlanRevisionDraft = Readonly<{
  revisionId: string;
  status: "candidate" | "confirmed";
  basedOnRequirementRevisionId: string;
  steps: readonly PlanStep[];
}>;

export type CreateTaskInput = Readonly<{
  eventId: string;
  taskId: string;
  title: string;
  occurredAtMs: number;
  requirement: RequirementDraft;
  metadata?: EventMetadata;
}>;

export type ReviseRequirementsInput = Readonly<{
  eventId: string;
  taskId: string;
  occurredAtMs: number;
  expectedTaskVersion: number;
  previousRequirementRevisionId: string;
  requirement: RequirementDraft;
  metadata?: EventMetadata;
}>;

export type RevisePlanInput = Readonly<{
  eventId: string;
  taskId: string;
  occurredAtMs: number;
  expectedTaskVersion: number;
  previousPlanRevisionId: string | null;
  plan: PlanRevisionDraft;
  metadata?: EventMetadata;
}>;

export type TaskCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  task: TaskPlanRecord;
}>;

export type TaskPlanStoreConfig = Readonly<{
  path: string;
  busyTimeoutMs?: number;
  now?: () => number;
}>;

export type TaskPlanErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

const ERROR_MESSAGES: Readonly<Record<TaskPlanErrorCode, string>> = Object.freeze({
  closed: "The Harness task plan store is closed.",
  conflict: "The Harness task plan command conflicts with current state.",
  invalid_input: "The Harness task plan input is invalid.",
  not_found: "The Harness task does not exist.",
  storage_failure: "The Harness task plan operation failed.",
});

export class TaskPlanError extends Error {
  readonly code: TaskPlanErrorCode;

  constructor(code: TaskPlanErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TaskPlanError";
    this.code = code;
  }
}

const TASK_PROJECTION: ProjectionDefinition = Object.freeze({
  name: TASK_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) =>
    event.streamType === TASK_STREAM_TYPE &&
    TASK_EVENT_TYPES.has(event.eventType) &&
    UUID_PATTERN.test(event.streamId)
      ? [event.streamId]
      : [],
  reduce: ({ current, event }) => ({
    type: "set",
    state: requireJsonValue(reduceTaskEvent(current, event)),
  }),
});

export class TaskPlanStore {
  readonly #events: HarnessEventStore;
  #closed = false;

  private constructor(events: HarnessEventStore) {
    this.#events = events;
  }

  static async open(config: TaskPlanStoreConfig): Promise<TaskPlanStore> {
    try {
      const normalized = normalizeConfig(config);
      const events = await HarnessEventStore.open({
        path: normalized.path,
        projections: [TASK_PROJECTION],
        ...(normalized.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: normalized.busyTimeoutMs }),
        ...(normalized.now === undefined ? {} : { now: normalized.now }),
      });
      return new TaskPlanStore(events);
    } catch (error: unknown) {
      throw mapTaskPlanOpenError(error);
    }
  }

  createTask(input: CreateTaskInput): TaskCommandResult {
    this.#assertOpen();
    const normalized = normalizeCreateTaskInput(input);
    return this.#appendAndRead({
      eventId: normalized.eventId,
      streamType: TASK_STREAM_TYPE,
      streamId: normalized.taskId,
      eventType: TASK_CREATED,
      eventVersion: 1,
      occurredAtMs: normalized.occurredAtMs,
      payload: {
        taskId: normalized.taskId,
        title: normalized.title,
        requirement: requireJsonValue(normalized.requirement),
      },
      ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
    });
  }

  reviseRequirements(input: ReviseRequirementsInput): TaskCommandResult {
    this.#assertOpen();
    const normalized = normalizeReviseRequirementsInput(input);
    return this.#appendAndRead({
      eventId: normalized.eventId,
      streamType: TASK_STREAM_TYPE,
      streamId: normalized.taskId,
      eventType: REQUIREMENTS_REVISED,
      eventVersion: 1,
      occurredAtMs: normalized.occurredAtMs,
      payload: {
        taskId: normalized.taskId,
        expectedTaskVersion: normalized.expectedTaskVersion,
        previousRequirementRevisionId: normalized.previousRequirementRevisionId,
        requirement: requireJsonValue(normalized.requirement),
      },
      ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
    });
  }

  revisePlan(input: RevisePlanInput): TaskCommandResult {
    this.#assertOpen();
    const normalized = normalizeRevisePlanInput(input);
    return this.#appendAndRead({
      eventId: normalized.eventId,
      streamType: TASK_STREAM_TYPE,
      streamId: normalized.taskId,
      eventType: PLAN_REVISED,
      eventVersion: 1,
      occurredAtMs: normalized.occurredAtMs,
      payload: {
        taskId: normalized.taskId,
        expectedTaskVersion: normalized.expectedTaskVersion,
        previousPlanRevisionId: normalized.previousPlanRevisionId,
        plan: requireJsonValue(normalized.plan),
      },
      ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
    });
  }

  readTask(taskId: string): TaskPlanRecord {
    this.#assertOpen();
    if (!isUuid(taskId)) {
      throw new TaskPlanError("invalid_input");
    }
    try {
      const projected = this.#events.readProjectionState(TASK_PROJECTION_NAME, taskId);
      if (projected === undefined) {
        throw new TaskPlanError("not_found");
      }
      return decodeTaskRecord(projected.state);
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  listTasks(afterTaskId = "", limit = 100): readonly TaskPlanRecord[] {
    this.#assertOpen();
    if (
      (afterTaskId !== "" && !isUuid(afterTaskId)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new TaskPlanError("invalid_input");
    }
    try {
      return Object.freeze(
        this.#events
          .listProjectionStates(TASK_PROJECTION_NAME, afterTaskId, limit)
          .map((projected) => decodeTaskRecord(projected.state)),
      );
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  inspect(): EventStoreInspection {
    this.#assertOpen();
    try {
      return this.#events.inspect();
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#events.close();
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  #appendAndRead(event: Parameters<HarnessEventStore["append"]>[0]): TaskCommandResult {
    try {
      const appended = this.#events.append(event);
      const task = this.readTask(event.streamId);
      return Object.freeze({ duplicate: appended.duplicate, event: appended.event, task });
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TaskPlanError("closed");
    }
  }
}

function reduceTaskEvent(current: JsonValue | undefined, event: StoredEvent): TaskPlanRecord {
  if (event.eventVersion !== 1 || event.streamType !== TASK_STREAM_TYPE) {
    throw new TaskPlanError("conflict");
  }
  if (event.eventType === TASK_CREATED) {
    if (current !== undefined) {
      throw new TaskPlanError("conflict");
    }
    const payload = requireRecord(event.payload, ["requirement", "taskId", "title"]);
    const taskId = requireUuid(payload.taskId);
    if (taskId !== event.streamId) {
      throw new TaskPlanError("conflict");
    }
    const requirement = normalizeRequirementDraft(payload.requirement);
    if (requirement.revisionId !== event.eventId) {
      throw new TaskPlanError("conflict");
    }
    return freezeTask({
      taskId,
      title: requireText(payload.title, MAX_TITLE_BYTES),
      taskVersion: 1,
      createdAtMs: event.occurredAtMs,
      updatedAtMs: event.occurredAtMs,
      activeRequirement: Object.freeze({ ...requirement, revisionNumber: 1 }),
      latestPlan: null,
      confirmedPlan: null,
    });
  }

  const task = decodeTaskRecord(current);
  if (task.taskId !== event.streamId || event.occurredAtMs < task.updatedAtMs) {
    throw new TaskPlanError("conflict");
  }
  if (event.eventType === REQUIREMENTS_REVISED) {
    const payload = requireRecord(event.payload, [
      "expectedTaskVersion",
      "previousRequirementRevisionId",
      "requirement",
      "taskId",
    ]);
    if (
      requireUuid(payload.taskId) !== task.taskId ||
      requirePositiveInteger(payload.expectedTaskVersion) !== task.taskVersion ||
      requireUuid(payload.previousRequirementRevisionId) !== task.activeRequirement.revisionId
    ) {
      throw new TaskPlanError("conflict");
    }
    const requirement = normalizeRequirementDraft(payload.requirement);
    if (
      requirement.revisionId !== event.eventId ||
      requirement.revisionId === task.activeRequirement.revisionId
    ) {
      throw new TaskPlanError("conflict");
    }
    return freezeTask({
      ...task,
      taskVersion: incrementVersion(task.taskVersion),
      updatedAtMs: event.occurredAtMs,
      activeRequirement: Object.freeze({
        ...requirement,
        revisionNumber: incrementVersion(task.activeRequirement.revisionNumber),
      }),
      latestPlan: null,
    });
  }
  if (event.eventType === PLAN_REVISED) {
    const payload = requireRecord(event.payload, [
      "expectedTaskVersion",
      "plan",
      "previousPlanRevisionId",
      "taskId",
    ]);
    const previousPlanRevisionId = requireNullableUuid(payload.previousPlanRevisionId);
    if (
      requireUuid(payload.taskId) !== task.taskId ||
      requirePositiveInteger(payload.expectedTaskVersion) !== task.taskVersion ||
      previousPlanRevisionId !== (task.latestPlan?.revisionId ?? null)
    ) {
      throw new TaskPlanError("conflict");
    }
    const plan = normalizePlanDraft(payload.plan);
    if (
      plan.revisionId !== event.eventId ||
      plan.basedOnRequirementRevisionId !== task.activeRequirement.revisionId ||
      plan.revisionId === previousPlanRevisionId
    ) {
      throw new TaskPlanError("conflict");
    }
    const revisionNumber = incrementVersion(
      Math.max(task.latestPlan?.revisionNumber ?? 0, task.confirmedPlan?.revisionNumber ?? 0),
    );
    const revision = Object.freeze({ ...plan, revisionNumber });
    return freezeTask({
      ...task,
      taskVersion: incrementVersion(task.taskVersion),
      updatedAtMs: event.occurredAtMs,
      latestPlan: revision,
      ...(revision.status === "confirmed" ? { confirmedPlan: revision } : {}),
    });
  }
  throw new TaskPlanError("conflict");
}

function normalizeConfig(config: TaskPlanStoreConfig): TaskPlanStoreConfig {
  const record = requireRecord(config, ["path"], ["busyTimeoutMs", "now"]);
  if (
    typeof record.path !== "string" ||
    (record.now !== undefined && typeof record.now !== "function")
  ) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze({
    path: record.path,
    ...(record.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: requirePositiveInteger(record.busyTimeoutMs) }),
    ...(record.now === undefined ? {} : { now: record.now as () => number }),
  });
}

function normalizeCreateTaskInput(input: unknown): CreateTaskInput {
  const record = normalizeCommandRecord(input, [
    "eventId",
    "occurredAtMs",
    "requirement",
    "taskId",
    "title",
  ]);
  const eventId = requireUuid(record.eventId);
  const requirement = normalizeRequirementDraft(record.requirement);
  if (eventId !== requirement.revisionId) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze({
    eventId,
    taskId: requireUuid(record.taskId),
    title: requireText(record.title, MAX_TITLE_BYTES),
    occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
    requirement,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata as EventMetadata }),
  });
}

function normalizeReviseRequirementsInput(input: unknown): ReviseRequirementsInput {
  const record = normalizeCommandRecord(input, [
    "eventId",
    "expectedTaskVersion",
    "occurredAtMs",
    "previousRequirementRevisionId",
    "requirement",
    "taskId",
  ]);
  const eventId = requireUuid(record.eventId);
  const requirement = normalizeRequirementDraft(record.requirement);
  if (eventId !== requirement.revisionId) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze({
    eventId,
    taskId: requireUuid(record.taskId),
    occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
    expectedTaskVersion: requirePositiveInteger(record.expectedTaskVersion),
    previousRequirementRevisionId: requireUuid(record.previousRequirementRevisionId),
    requirement,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata as EventMetadata }),
  });
}

function normalizeRevisePlanInput(input: unknown): RevisePlanInput {
  const record = normalizeCommandRecord(input, [
    "eventId",
    "expectedTaskVersion",
    "occurredAtMs",
    "plan",
    "previousPlanRevisionId",
    "taskId",
  ]);
  const eventId = requireUuid(record.eventId);
  const plan = normalizePlanDraft(record.plan);
  if (eventId !== plan.revisionId) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze({
    eventId,
    taskId: requireUuid(record.taskId),
    occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
    expectedTaskVersion: requirePositiveInteger(record.expectedTaskVersion),
    previousPlanRevisionId: requireNullableUuid(record.previousPlanRevisionId),
    plan,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata as EventMetadata }),
  });
}

function normalizeCommandRecord(
  input: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (!validateJsonValue(input).ok) {
    throw new TaskPlanError("invalid_input");
  }
  return requireRecord(input, required, ["metadata"]);
}

function normalizeRequirementDraft(input: unknown): RequirementDraft {
  const record = requireRecord(input, [
    "acceptanceCriteria",
    "constraints",
    "objective",
    "revisionId",
    "sourceText",
  ]);
  const normalized = Object.freeze({
    revisionId: requireUuid(record.revisionId),
    sourceText: requireText(record.sourceText, MAX_SOURCE_TEXT_BYTES),
    objective: requireText(record.objective, MAX_OBJECTIVE_BYTES),
    constraints: requireTextArray(record.constraints, MAX_REQUIREMENT_ITEMS, MAX_ITEM_BYTES),
    acceptanceCriteria: requireTextArray(
      record.acceptanceCriteria,
      MAX_REQUIREMENT_ITEMS,
      MAX_ITEM_BYTES,
    ),
  });
  if (
    textBytes([
      normalized.sourceText,
      normalized.objective,
      ...normalized.constraints,
      ...normalized.acceptanceCriteria,
    ]) > MAX_REQUIREMENT_TOTAL_BYTES
  ) {
    throw new TaskPlanError("invalid_input");
  }
  return normalized;
}

function normalizePlanDraft(input: unknown): PlanRevisionDraft {
  const record = requireRecord(input, [
    "basedOnRequirementRevisionId",
    "revisionId",
    "status",
    "steps",
  ]);
  if (record.status !== "candidate" && record.status !== "confirmed") {
    throw new TaskPlanError("invalid_input");
  }
  if (
    !Array.isArray(record.steps) ||
    record.steps.length < 1 ||
    record.steps.length > MAX_PLAN_STEPS
  ) {
    throw new TaskPlanError("invalid_input");
  }
  const stepIds = new Set<string>();
  let totalTextBytes = 0;
  const steps = record.steps.map((step) => {
    const candidate = requireRecord(step, ["acceptanceCriteria", "description", "stepId", "title"]);
    const stepId = requireUuid(candidate.stepId);
    if (stepIds.has(stepId)) {
      throw new TaskPlanError("invalid_input");
    }
    stepIds.add(stepId);
    const normalized = Object.freeze({
      stepId,
      title: requireText(candidate.title, MAX_STEP_TITLE_BYTES),
      description: requireText(candidate.description, MAX_STEP_DESCRIPTION_BYTES),
      acceptanceCriteria: requireTextArray(
        candidate.acceptanceCriteria,
        MAX_REQUIREMENT_ITEMS,
        MAX_ITEM_BYTES,
      ),
    });
    totalTextBytes += textBytes([
      normalized.title,
      normalized.description,
      ...normalized.acceptanceCriteria,
    ]);
    if (totalTextBytes > MAX_PLAN_TOTAL_BYTES) {
      throw new TaskPlanError("invalid_input");
    }
    return normalized;
  });
  return Object.freeze({
    revisionId: requireUuid(record.revisionId),
    status: record.status,
    basedOnRequirementRevisionId: requireUuid(record.basedOnRequirementRevisionId),
    steps: Object.freeze(steps),
  });
}

function decodeTaskRecord(input: unknown): TaskPlanRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new TaskPlanError("storage_failure");
    }
    const record = requireRecord(input, [
      "activeRequirement",
      "confirmedPlan",
      "createdAtMs",
      "latestPlan",
      "taskId",
      "taskVersion",
      "title",
      "updatedAtMs",
    ]);
    const activeRequirement = decodeRequirementRevision(record.activeRequirement);
    const latestPlan = record.latestPlan === null ? null : decodePlanRevision(record.latestPlan);
    const confirmedPlan =
      record.confirmedPlan === null ? null : decodePlanRevision(record.confirmedPlan);
    if (confirmedPlan !== null && confirmedPlan.status !== "confirmed") {
      throw new TaskPlanError("storage_failure");
    }
    const decoded = freezeTask({
      taskId: requireUuid(record.taskId),
      title: requireText(record.title, MAX_TITLE_BYTES),
      taskVersion: requirePositiveInteger(record.taskVersion),
      createdAtMs: requireNonNegativeInteger(record.createdAtMs),
      updatedAtMs: requireNonNegativeInteger(record.updatedAtMs),
      activeRequirement,
      latestPlan,
      confirmedPlan,
    });
    if (
      decoded.createdAtMs > decoded.updatedAtMs ||
      decoded.activeRequirement.revisionNumber > decoded.taskVersion ||
      (decoded.latestPlan !== null &&
        decoded.latestPlan.basedOnRequirementRevisionId !== decoded.activeRequirement.revisionId) ||
      (decoded.latestPlan?.status === "confirmed" &&
        decoded.latestPlan.revisionId !== decoded.confirmedPlan?.revisionId)
    ) {
      throw new TaskPlanError("storage_failure");
    }
    return decoded;
  } catch {
    throw new TaskPlanError("storage_failure");
  }
}

function decodeRequirementRevision(input: unknown): RequirementRevision {
  const record = requireRecord(input, [
    "acceptanceCriteria",
    "constraints",
    "objective",
    "revisionId",
    "revisionNumber",
    "sourceText",
  ]);
  return Object.freeze({
    ...normalizeRequirementDraft({
      revisionId: record.revisionId,
      sourceText: record.sourceText,
      objective: record.objective,
      constraints: record.constraints,
      acceptanceCriteria: record.acceptanceCriteria,
    }),
    revisionNumber: requirePositiveInteger(record.revisionNumber),
  });
}

function decodePlanRevision(input: unknown): PlanRevision {
  const record = requireRecord(input, [
    "basedOnRequirementRevisionId",
    "revisionId",
    "revisionNumber",
    "status",
    "steps",
  ]);
  return Object.freeze({
    ...normalizePlanDraft({
      revisionId: record.revisionId,
      status: record.status,
      basedOnRequirementRevisionId: record.basedOnRequirementRevisionId,
      steps: record.steps,
    }),
    revisionNumber: requirePositiveInteger(record.revisionNumber),
  });
}

function freezeTask(input: TaskPlanRecord): TaskPlanRecord {
  return Object.freeze(input);
}

function requireRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TaskPlanError("invalid_input");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TaskPlanError("invalid_input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    keys.some((key) => {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new TaskPlanError("invalid_input");
  }
  return input as Record<string, unknown>;
}

function requireText(input: unknown, maxBytes: number): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    Buffer.byteLength(input, "utf8") > maxBytes
  ) {
    throw new TaskPlanError("invalid_input");
  }
  return input;
}

function requireTextArray(input: unknown, maxItems: number, maxBytes: number): readonly string[] {
  if (!Array.isArray(input) || input.length > maxItems) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze(input.map((item) => requireText(item, maxBytes)));
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new TaskPlanError("invalid_input");
  }
  return input;
}

function requireNullableUuid(input: unknown): string | null {
  return input === null ? null : requireUuid(input);
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TaskPlanError("invalid_input");
  }
  return input as number;
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TaskPlanError("invalid_input");
  }
  return input as number;
}

function requireJsonValue(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) {
    throw new TaskPlanError("invalid_input");
  }
  return input as JsonValue;
}

function incrementVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TaskPlanError("conflict");
  }
  return value + 1;
}

function textBytes(values: readonly string[]): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
}

function mapTaskPlanError(error: unknown): TaskPlanError {
  if (error instanceof TaskPlanError) {
    return error;
  }
  if (error instanceof EventStoreError) {
    if (error.code === "closed") {
      return new TaskPlanError("closed");
    }
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new TaskPlanError("conflict");
    }
    if (error.code === "invalid_event" || error.code === "invalid_configuration") {
      return new TaskPlanError("invalid_input");
    }
  }
  return new TaskPlanError("storage_failure");
}

function mapTaskPlanOpenError(error: unknown): TaskPlanError {
  if (error instanceof TaskPlanError) {
    return error;
  }
  if (
    error instanceof EventStoreError &&
    (error.code === "invalid_configuration" || error.code === "invalid_event")
  ) {
    return new TaskPlanError("invalid_input");
  }
  return new TaskPlanError("storage_failure");
}

if (!NamespacedTokenSchema.safeParse(TASK_PROJECTION_NAME).success) {
  throw new Error("The task projection name is invalid.");
}
