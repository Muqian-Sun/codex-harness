import { NamespacedTokenSchema, validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import {
  EventStoreError,
  HarnessEventStore,
  type EventMetadata,
  type EventStoreInspection,
  type ProjectionDefinition,
  type StoredEvent,
} from "../persistence/event-store.js";
import {
  TaskGraphValidationError,
  decodeTaskGraphRevision,
  materializeTaskGraph,
  normalizeTaskGraphDraft,
  type TaskGraphDraft,
  type TaskGraphRevision,
} from "./task-graph.js";

const TASK_STREAM_TYPE = "task.plan";
const TASK_PROJECTION_NAME = "task.current_plan";
const TASK_PROJECTION_PROBE_KEY = "00000000-0000-4000-8000-000000000000";
const TASK_CREATED = "task.created";
const REQUIREMENTS_REVISED = "task.requirements_revised";
const REQUIREMENTS_RECONCILED = "task.requirements_reconciled";
const PLAN_REVISED = "task.plan_revised";
const PLAN_RECONCILED = "task.plan_reconciled";
const GRAPH_COMMITTED = "task.graph_committed";
const GRAPH_RECONCILED = "task.graph_reconciled";
const TASK_EVENT_TYPES = new Set([
  TASK_CREATED,
  REQUIREMENTS_REVISED,
  REQUIREMENTS_RECONCILED,
  PLAN_REVISED,
  PLAN_RECONCILED,
  GRAPH_COMMITTED,
  GRAPH_RECONCILED,
]);
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

export type TaskReconciliationChanges = Readonly<{
  preservedPlanStepIds: readonly string[];
  addedPlanStepIds: readonly string[];
  removedPlanStepIds: readonly string[];
  planOrderChanged: boolean;
  preservedNodeIds: readonly string[];
  addedNodeIds: readonly string[];
  removedNodeIds: readonly string[];
  graphOrderChanged: boolean;
  dependencyChangedNodeIds: readonly string[];
  revalidationNodeIds: readonly string[];
}>;

export type TaskReconciliation = Readonly<{
  reconciliationId: string;
  appliedAtTaskVersion: number;
  previousRequirementRevisionId: string;
  requirementRevisionId: string;
  previousPlanRevisionId: string;
  planRevisionId: string;
  previousGraphRevisionId: string;
  graphRevisionId: string;
  impact: "editorial" | "additive" | "restructuring";
  changes: TaskReconciliationChanges;
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
  activeGraph: TaskGraphRevision | null;
  activeReconciliation: TaskReconciliation | null;
  lastGraphRevisionNumber: number;
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

export type CommitTaskGraphInput = Readonly<{
  eventId: string;
  taskId: string;
  occurredAtMs: number;
  expectedTaskVersion: number;
  previousGraphRevisionId: string | null;
  graph: TaskGraphDraft;
  metadata?: EventMetadata;
}>;

export type ReconcileTaskInput = Readonly<{
  taskId: string;
  occurredAtMs: number;
  expectedTaskVersion: number;
  previousRequirementRevisionId: string;
  previousPlanRevisionId: string;
  previousGraphRevisionId: string;
  requirement: RequirementDraft;
  plan: PlanRevisionDraft;
  graph: TaskGraphDraft;
  metadata?: EventMetadata;
}>;

export type TaskCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  task: TaskPlanRecord;
}>;

export type TaskReconciliationResult = Readonly<{
  duplicate: boolean;
  events: readonly StoredEvent[];
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

export const TASK_PLAN_PROJECTION: ProjectionDefinition = Object.freeze({
  name: TASK_PROJECTION_NAME,
  version: 3,
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

export class TaskPlanRepository {
  readonly #events: HarnessEventStore;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(TASK_PROJECTION_NAME, TASK_PROJECTION_PROBE_KEY);
      this.#events = events;
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  createTask(input: CreateTaskInput): TaskCommandResult {
    this.assertAvailable();
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
    this.assertAvailable();
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
    this.assertAvailable();
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

  commitTaskGraph(input: CommitTaskGraphInput): TaskCommandResult {
    this.assertAvailable();
    const normalized = normalizeCommitTaskGraphInput(input);
    return this.#appendAndRead({
      eventId: normalized.eventId,
      streamType: TASK_STREAM_TYPE,
      streamId: normalized.taskId,
      eventType: GRAPH_COMMITTED,
      eventVersion: 1,
      occurredAtMs: normalized.occurredAtMs,
      payload: {
        taskId: normalized.taskId,
        expectedTaskVersion: normalized.expectedTaskVersion,
        previousGraphRevisionId: normalized.previousGraphRevisionId,
        graph: requireJsonValue(normalized.graph),
      },
      ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
    });
  }

  reconcileRequirements(input: ReconcileTaskInput): TaskReconciliationResult {
    this.assertAvailable();
    const normalized = normalizeReconcileTaskInput(input);
    try {
      const appended = this.#events.appendBatch([
        {
          eventId: normalized.requirement.revisionId,
          streamType: TASK_STREAM_TYPE,
          streamId: normalized.taskId,
          eventType: REQUIREMENTS_RECONCILED,
          eventVersion: 1,
          occurredAtMs: normalized.occurredAtMs,
          payload: {
            taskId: normalized.taskId,
            expectedTaskVersion: normalized.expectedTaskVersion,
            previousRequirementRevisionId: normalized.previousRequirementRevisionId,
            previousPlanRevisionId: normalized.previousPlanRevisionId,
            previousGraphRevisionId: normalized.previousGraphRevisionId,
            requirement: requireJsonValue(normalized.requirement),
            plan: requireJsonValue(normalized.plan),
            graph: requireJsonValue(normalized.graph),
          },
          ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
        },
        {
          eventId: normalized.plan.revisionId,
          streamType: TASK_STREAM_TYPE,
          streamId: normalized.taskId,
          eventType: PLAN_RECONCILED,
          eventVersion: 1,
          occurredAtMs: normalized.occurredAtMs,
          payload: {
            taskId: normalized.taskId,
            reconciliationId: normalized.requirement.revisionId,
            plan: requireJsonValue(normalized.plan),
          },
          metadata: chainedMetadata(normalized.metadata, normalized.requirement.revisionId),
        },
        {
          eventId: normalized.graph.revisionId,
          streamType: TASK_STREAM_TYPE,
          streamId: normalized.taskId,
          eventType: GRAPH_RECONCILED,
          eventVersion: 1,
          occurredAtMs: normalized.occurredAtMs,
          payload: {
            taskId: normalized.taskId,
            reconciliationId: normalized.requirement.revisionId,
            graph: requireJsonValue(normalized.graph),
          },
          metadata: chainedMetadata(normalized.metadata, normalized.plan.revisionId),
        },
      ]);
      return Object.freeze({
        duplicate: appended.duplicate,
        events: appended.events,
        task: this.readTask(normalized.taskId),
      });
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  readTask(taskId: string): TaskPlanRecord {
    this.assertAvailable();
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
    this.assertAvailable();
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
    this.assertAvailable();
    try {
      return this.#events.inspect();
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

  protected assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new TaskPlanError("closed");
    }
  }

  protected isAvailable(): boolean {
    return true;
  }
}

export class TaskPlanStore extends TaskPlanRepository {
  readonly #ownedEvents: HarnessEventStore;
  #closed = false;

  private constructor(events: HarnessEventStore) {
    super(events);
    this.#ownedEvents = events;
  }

  static async open(config: TaskPlanStoreConfig): Promise<TaskPlanStore> {
    try {
      const normalized = normalizeConfig(config);
      const events = await HarnessEventStore.open({
        path: normalized.path,
        projections: [TASK_PLAN_PROJECTION],
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

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#ownedEvents.close();
    } catch (error: unknown) {
      throw mapTaskPlanError(error);
    }
  }

  protected override isAvailable(): boolean {
    return !this.#closed;
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
      activeGraph: null,
      activeReconciliation: null,
      lastGraphRevisionNumber: 0,
    });
  }

  const task = decodeTaskRecord(current);
  if (task.taskId !== event.streamId || event.occurredAtMs < task.updatedAtMs) {
    throw new TaskPlanError("conflict");
  }
  if (event.eventType === REQUIREMENTS_RECONCILED) {
    const payload = requireRecord(event.payload, [
      "expectedTaskVersion",
      "graph",
      "plan",
      "previousGraphRevisionId",
      "previousPlanRevisionId",
      "previousRequirementRevisionId",
      "requirement",
      "taskId",
    ]);
    const previousRequirementRevisionId = requireUuid(payload.previousRequirementRevisionId);
    const previousPlanRevisionId = requireUuid(payload.previousPlanRevisionId);
    const previousGraphRevisionId = requireUuid(payload.previousGraphRevisionId);
    if (
      requireUuid(payload.taskId) !== task.taskId ||
      requirePositiveInteger(payload.expectedTaskVersion) !== task.taskVersion ||
      previousRequirementRevisionId !== task.activeRequirement.revisionId ||
      previousPlanRevisionId !== task.confirmedPlan?.revisionId ||
      previousGraphRevisionId !== task.activeGraph?.revisionId ||
      task.confirmedPlan === null ||
      task.activeGraph === null ||
      task.activeGraph.nodes.some((node) => node.status === "running")
    ) {
      throw new TaskPlanError("conflict");
    }
    const requirement = normalizeRequirementDraft(payload.requirement);
    const plan = normalizePlanDraft(payload.plan);
    if (
      requirement.revisionId !== event.eventId ||
      requirement.revisionId === previousRequirementRevisionId ||
      plan.status !== "confirmed" ||
      plan.basedOnRequirementRevisionId !== requirement.revisionId ||
      plan.revisionId === previousPlanRevisionId
    ) {
      throw new TaskPlanError("conflict");
    }
    const graph = requireTaskGraphDraft(
      payload.graph,
      plan.steps.map((step) => step.stepId),
    );
    if (
      graph.basedOnPlanRevisionId !== plan.revisionId ||
      graph.revisionId === previousGraphRevisionId ||
      new Set([requirement.revisionId, plan.revisionId, graph.revisionId]).size !== 3
    ) {
      throw new TaskPlanError("conflict");
    }
    const changes = deriveReconciliationChanges(task, plan, graph);
    const nextTaskVersion = incrementVersion(task.taskVersion);
    const requirementRevision = Object.freeze({
      ...requirement,
      revisionNumber: incrementVersion(task.activeRequirement.revisionNumber),
    });
    const planRevision = Object.freeze({
      ...plan,
      revisionNumber: incrementVersion(
        Math.max(task.latestPlan?.revisionNumber ?? 0, task.confirmedPlan.revisionNumber),
      ),
    });
    const graphRevision = requireTaskGraphRevision(
      graph,
      incrementVersion(task.lastGraphRevisionNumber),
    );
    return freezeTask({
      ...task,
      taskVersion: nextTaskVersion,
      updatedAtMs: event.occurredAtMs,
      activeRequirement: requirementRevision,
      latestPlan: planRevision,
      confirmedPlan: planRevision,
      activeGraph: graphRevision,
      activeReconciliation: Object.freeze({
        reconciliationId: requirement.revisionId,
        appliedAtTaskVersion: nextTaskVersion,
        previousRequirementRevisionId,
        requirementRevisionId: requirement.revisionId,
        previousPlanRevisionId,
        planRevisionId: plan.revisionId,
        previousGraphRevisionId,
        graphRevisionId: graph.revisionId,
        impact: deriveReconciliationImpact(task.activeRequirement, requirement, changes),
        changes,
      }),
      lastGraphRevisionNumber: graphRevision.revisionNumber,
    });
  }
  if (event.eventType === PLAN_RECONCILED) {
    const payload = requireRecord(event.payload, ["plan", "reconciliationId", "taskId"]);
    const plan = normalizePlanDraft(payload.plan);
    if (
      requireUuid(payload.taskId) !== task.taskId ||
      requireUuid(payload.reconciliationId) !== task.activeReconciliation?.reconciliationId ||
      plan.revisionId !== event.eventId ||
      task.confirmedPlan === null ||
      !planDraftMatchesRevision(plan, task.confirmedPlan)
    ) {
      throw new TaskPlanError("conflict");
    }
    return task;
  }
  if (event.eventType === GRAPH_RECONCILED) {
    const payload = requireRecord(event.payload, ["graph", "reconciliationId", "taskId"]);
    if (task.confirmedPlan === null || task.activeGraph === null) {
      throw new TaskPlanError("conflict");
    }
    const graph = requireTaskGraphDraft(
      payload.graph,
      task.confirmedPlan.steps.map((step) => step.stepId),
    );
    if (
      requireUuid(payload.taskId) !== task.taskId ||
      requireUuid(payload.reconciliationId) !== task.activeReconciliation?.reconciliationId ||
      graph.revisionId !== event.eventId ||
      !graphDraftMatchesRevision(graph, task.activeGraph)
    ) {
      throw new TaskPlanError("conflict");
    }
    return task;
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
      activeGraph: null,
      activeReconciliation: null,
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
      ...(revision.status === "confirmed"
        ? {
            confirmedPlan: revision,
            activeGraph: null,
            activeReconciliation: null,
          }
        : {}),
    });
  }
  if (event.eventType === GRAPH_COMMITTED) {
    const payload = requireRecord(event.payload, [
      "expectedTaskVersion",
      "graph",
      "previousGraphRevisionId",
      "taskId",
    ]);
    const previousGraphRevisionId = requireNullableUuid(payload.previousGraphRevisionId);
    if (
      requireUuid(payload.taskId) !== task.taskId ||
      requirePositiveInteger(payload.expectedTaskVersion) !== task.taskVersion ||
      previousGraphRevisionId !== (task.activeGraph?.revisionId ?? null) ||
      task.confirmedPlan === null ||
      task.confirmedPlan.basedOnRequirementRevisionId !== task.activeRequirement.revisionId
    ) {
      throw new TaskPlanError("conflict");
    }
    const graph = requireTaskGraphDraft(
      payload.graph,
      task.confirmedPlan.steps.map((step) => step.stepId),
    );
    if (
      graph.revisionId !== event.eventId ||
      graph.basedOnPlanRevisionId !== task.confirmedPlan.revisionId ||
      graph.revisionId === previousGraphRevisionId
    ) {
      throw new TaskPlanError("conflict");
    }
    const revisionNumber = incrementVersion(task.lastGraphRevisionNumber);
    return freezeTask({
      ...task,
      taskVersion: incrementVersion(task.taskVersion),
      updatedAtMs: event.occurredAtMs,
      activeGraph: requireTaskGraphRevision(graph, revisionNumber),
      activeReconciliation: null,
      lastGraphRevisionNumber: revisionNumber,
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

function normalizeCommitTaskGraphInput(input: unknown): CommitTaskGraphInput {
  const record = normalizeCommandRecord(input, [
    "eventId",
    "expectedTaskVersion",
    "graph",
    "occurredAtMs",
    "previousGraphRevisionId",
    "taskId",
  ]);
  const eventId = requireUuid(record.eventId);
  const graph = requireTaskGraphDraft(record.graph);
  if (eventId !== graph.revisionId) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze({
    eventId,
    taskId: requireUuid(record.taskId),
    occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
    expectedTaskVersion: requirePositiveInteger(record.expectedTaskVersion),
    previousGraphRevisionId: requireNullableUuid(record.previousGraphRevisionId),
    graph,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata as EventMetadata }),
  });
}

function normalizeReconcileTaskInput(input: unknown): ReconcileTaskInput {
  const record = normalizeCommandRecord(input, [
    "expectedTaskVersion",
    "graph",
    "occurredAtMs",
    "plan",
    "previousGraphRevisionId",
    "previousPlanRevisionId",
    "previousRequirementRevisionId",
    "requirement",
    "taskId",
  ]);
  const requirement = normalizeRequirementDraft(record.requirement);
  const plan = normalizePlanDraft(record.plan);
  const graph = requireTaskGraphDraft(
    record.graph,
    plan.steps.map((step) => step.stepId),
  );
  if (
    plan.status !== "confirmed" ||
    plan.basedOnRequirementRevisionId !== requirement.revisionId ||
    graph.basedOnPlanRevisionId !== plan.revisionId ||
    new Set([requirement.revisionId, plan.revisionId, graph.revisionId]).size !== 3
  ) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze({
    taskId: requireUuid(record.taskId),
    occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
    expectedTaskVersion: requirePositiveInteger(record.expectedTaskVersion),
    previousRequirementRevisionId: requireUuid(record.previousRequirementRevisionId),
    previousPlanRevisionId: requireUuid(record.previousPlanRevisionId),
    previousGraphRevisionId: requireUuid(record.previousGraphRevisionId),
    requirement,
    plan,
    graph,
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
      "activeGraph",
      "activeReconciliation",
      "confirmedPlan",
      "createdAtMs",
      "lastGraphRevisionNumber",
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
    let activeGraph: TaskGraphRevision | null = null;
    if (record.activeGraph !== null) {
      if (confirmedPlan === null) {
        throw new TaskPlanError("storage_failure");
      }
      activeGraph = requireDecodedTaskGraphRevision(
        record.activeGraph,
        confirmedPlan.steps.map((step) => step.stepId),
      );
    }
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
      activeGraph,
      activeReconciliation:
        record.activeReconciliation === null
          ? null
          : decodeTaskReconciliation(record.activeReconciliation),
      lastGraphRevisionNumber: requireNonNegativeInteger(record.lastGraphRevisionNumber),
    });
    if (
      decoded.createdAtMs > decoded.updatedAtMs ||
      decoded.activeRequirement.revisionNumber > decoded.taskVersion ||
      (decoded.latestPlan !== null &&
        decoded.latestPlan.basedOnRequirementRevisionId !== decoded.activeRequirement.revisionId) ||
      (decoded.latestPlan?.status === "confirmed" &&
        decoded.latestPlan.revisionId !== decoded.confirmedPlan?.revisionId) ||
      decoded.lastGraphRevisionNumber > decoded.taskVersion ||
      !taskReconciliationMatchesRecord(decoded) ||
      (decoded.activeGraph !== null &&
        (decoded.activeGraph.revisionNumber !== decoded.lastGraphRevisionNumber ||
          decoded.activeGraph.basedOnPlanRevisionId !== decoded.confirmedPlan?.revisionId ||
          decoded.confirmedPlan?.basedOnRequirementRevisionId !==
            decoded.activeRequirement.revisionId))
    ) {
      throw new TaskPlanError("storage_failure");
    }
    return decoded;
  } catch {
    throw new TaskPlanError("storage_failure");
  }
}

function taskReconciliationMatchesRecord(task: TaskPlanRecord): boolean {
  const reconciliation = task.activeReconciliation;
  if (reconciliation === null) {
    return true;
  }
  if (
    task.activeGraph === null ||
    task.confirmedPlan === null ||
    reconciliation.reconciliationId !== reconciliation.requirementRevisionId ||
    reconciliation.requirementRevisionId !== task.activeRequirement.revisionId ||
    reconciliation.planRevisionId !== task.confirmedPlan.revisionId ||
    reconciliation.graphRevisionId !== task.activeGraph.revisionId ||
    reconciliation.appliedAtTaskVersion > task.taskVersion ||
    new Set([
      reconciliation.previousRequirementRevisionId,
      reconciliation.previousPlanRevisionId,
      reconciliation.previousGraphRevisionId,
      reconciliation.requirementRevisionId,
      reconciliation.planRevisionId,
      reconciliation.graphRevisionId,
    ]).size !== 6 ||
    !sameStringSet(
      [...reconciliation.changes.preservedPlanStepIds, ...reconciliation.changes.addedPlanStepIds],
      task.confirmedPlan.steps.map((step) => step.stepId),
    ) ||
    !sameStringSet(
      [...reconciliation.changes.preservedNodeIds, ...reconciliation.changes.addedNodeIds],
      task.activeGraph.nodes.map((node) => node.nodeId),
    )
  ) {
    return false;
  }
  const changes = reconciliation.changes;
  const hasRestructuringChange =
    changes.removedPlanStepIds.length > 0 ||
    changes.removedNodeIds.length > 0 ||
    changes.planOrderChanged ||
    changes.graphOrderChanged ||
    changes.dependencyChangedNodeIds.length > 0 ||
    changes.revalidationNodeIds.length > 0;
  const hasAdditiveChange = changes.addedPlanStepIds.length > 0 || changes.addedNodeIds.length > 0;
  return !(
    (reconciliation.impact === "editorial" && (hasRestructuringChange || hasAdditiveChange)) ||
    (reconciliation.impact === "additive" && hasRestructuringChange)
  );
}

function decodeTaskReconciliation(input: unknown): TaskReconciliation {
  const record = requireRecord(input, [
    "appliedAtTaskVersion",
    "changes",
    "graphRevisionId",
    "impact",
    "planRevisionId",
    "previousGraphRevisionId",
    "previousPlanRevisionId",
    "previousRequirementRevisionId",
    "reconciliationId",
    "requirementRevisionId",
  ]);
  if (
    record.impact !== "editorial" &&
    record.impact !== "additive" &&
    record.impact !== "restructuring"
  ) {
    throw new TaskPlanError("storage_failure");
  }
  const changes = decodeTaskReconciliationChanges(record.changes);
  return Object.freeze({
    reconciliationId: requireUuid(record.reconciliationId),
    appliedAtTaskVersion: requirePositiveInteger(record.appliedAtTaskVersion),
    previousRequirementRevisionId: requireUuid(record.previousRequirementRevisionId),
    requirementRevisionId: requireUuid(record.requirementRevisionId),
    previousPlanRevisionId: requireUuid(record.previousPlanRevisionId),
    planRevisionId: requireUuid(record.planRevisionId),
    previousGraphRevisionId: requireUuid(record.previousGraphRevisionId),
    graphRevisionId: requireUuid(record.graphRevisionId),
    impact: record.impact,
    changes,
  });
}

function decodeTaskReconciliationChanges(input: unknown): TaskReconciliationChanges {
  const record = requireRecord(input, [
    "addedNodeIds",
    "addedPlanStepIds",
    "dependencyChangedNodeIds",
    "graphOrderChanged",
    "planOrderChanged",
    "preservedNodeIds",
    "preservedPlanStepIds",
    "removedNodeIds",
    "removedPlanStepIds",
    "revalidationNodeIds",
  ]);
  if (
    typeof record.planOrderChanged !== "boolean" ||
    typeof record.graphOrderChanged !== "boolean"
  ) {
    throw new TaskPlanError("storage_failure");
  }
  const changes = Object.freeze({
    preservedPlanStepIds: requireUuidArray(record.preservedPlanStepIds, MAX_PLAN_STEPS),
    addedPlanStepIds: requireUuidArray(record.addedPlanStepIds, MAX_PLAN_STEPS),
    removedPlanStepIds: requireUuidArray(record.removedPlanStepIds, MAX_PLAN_STEPS),
    planOrderChanged: record.planOrderChanged,
    preservedNodeIds: requireUuidArray(record.preservedNodeIds, MAX_PLAN_STEPS),
    addedNodeIds: requireUuidArray(record.addedNodeIds, MAX_PLAN_STEPS),
    removedNodeIds: requireUuidArray(record.removedNodeIds, MAX_PLAN_STEPS),
    graphOrderChanged: record.graphOrderChanged,
    dependencyChangedNodeIds: requireUuidArray(record.dependencyChangedNodeIds, MAX_PLAN_STEPS),
    revalidationNodeIds: requireUuidArray(record.revalidationNodeIds, MAX_PLAN_STEPS),
  });
  assertDisjointChanges(
    changes.preservedPlanStepIds,
    changes.addedPlanStepIds,
    changes.removedPlanStepIds,
  );
  assertDisjointChanges(changes.preservedNodeIds, changes.addedNodeIds, changes.removedNodeIds);
  const preservedNodes = new Set(changes.preservedNodeIds);
  if (
    changes.dependencyChangedNodeIds.some((nodeId) => !preservedNodes.has(nodeId)) ||
    changes.revalidationNodeIds.some((nodeId) => !preservedNodes.has(nodeId))
  ) {
    throw new TaskPlanError("storage_failure");
  }
  return changes;
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

function requireTaskGraphDraft(
  input: unknown,
  allowedPlanStepIds?: readonly string[],
): TaskGraphDraft {
  try {
    return normalizeTaskGraphDraft(input, allowedPlanStepIds);
  } catch (error: unknown) {
    if (error instanceof TaskGraphValidationError) {
      throw new TaskPlanError("invalid_input");
    }
    throw error;
  }
}

function requireTaskGraphRevision(
  draft: TaskGraphDraft,
  revisionNumber: number,
): TaskGraphRevision {
  try {
    return materializeTaskGraph(draft, revisionNumber);
  } catch (error: unknown) {
    if (error instanceof TaskGraphValidationError) {
      throw new TaskPlanError("conflict");
    }
    throw error;
  }
}

function requireDecodedTaskGraphRevision(
  input: unknown,
  allowedPlanStepIds: readonly string[],
): TaskGraphRevision {
  return decodeTaskGraphRevision(input, allowedPlanStepIds);
}

function deriveReconciliationChanges(
  task: TaskPlanRecord,
  plan: PlanRevisionDraft,
  graph: TaskGraphDraft,
): TaskReconciliationChanges {
  if (task.confirmedPlan === null || task.activeGraph === null) {
    throw new TaskPlanError("conflict");
  }
  const previousSteps = new Map(task.confirmedPlan.steps.map((step) => [step.stepId, step]));
  const nextSteps = new Map(plan.steps.map((step) => [step.stepId, step]));
  const preservedPlanStepIds: string[] = [];
  const addedPlanStepIds: string[] = [];
  for (const step of plan.steps) {
    const previous = previousSteps.get(step.stepId);
    if (previous === undefined) {
      addedPlanStepIds.push(step.stepId);
    } else {
      if (!planStepSemanticsEqual(previous, step)) {
        throw new TaskPlanError("conflict");
      }
      preservedPlanStepIds.push(step.stepId);
    }
  }
  const removedPlanStepIds = task.confirmedPlan.steps
    .filter((step) => !nextSteps.has(step.stepId))
    .map((step) => step.stepId);
  const preservedStepSet = new Set(preservedPlanStepIds);
  const previousPreservedOrder = task.confirmedPlan.steps
    .map((step) => step.stepId)
    .filter((stepId) => preservedStepSet.has(stepId));
  const nextPreservedOrder = plan.steps
    .map((step) => step.stepId)
    .filter((stepId) => preservedStepSet.has(stepId));

  const previousNodes = new Map(task.activeGraph.nodes.map((node) => [node.nodeId, node]));
  const nextNodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const preservedNodeIds: string[] = [];
  const addedNodeIds: string[] = [];
  const dependencyChangedNodeIds: string[] = [];
  const revalidationNodeIds: string[] = [];
  for (const node of graph.nodes) {
    const previous = previousNodes.get(node.nodeId);
    if (previous === undefined) {
      addedNodeIds.push(node.nodeId);
    } else {
      if (!nodeSemanticsEqual(previous, node)) {
        throw new TaskPlanError("conflict");
      }
      preservedNodeIds.push(node.nodeId);
      if (!stringArraysEqual(previous.dependsOnNodeIds, node.dependsOnNodeIds)) {
        dependencyChangedNodeIds.push(node.nodeId);
      }
      if (previous.status !== "pending") {
        revalidationNodeIds.push(node.nodeId);
      }
    }
  }
  const removedNodeIds = task.activeGraph.nodes
    .filter((node) => !nextNodes.has(node.nodeId))
    .map((node) => node.nodeId);
  const preservedNodeSet = new Set(preservedNodeIds);
  const previousPreservedNodeOrder = task.activeGraph.nodes
    .map((node) => node.nodeId)
    .filter((nodeId) => preservedNodeSet.has(nodeId));
  const nextPreservedNodeOrder = graph.nodes
    .map((node) => node.nodeId)
    .filter((nodeId) => preservedNodeSet.has(nodeId));

  return Object.freeze({
    preservedPlanStepIds: Object.freeze(preservedPlanStepIds),
    addedPlanStepIds: Object.freeze(addedPlanStepIds),
    removedPlanStepIds: Object.freeze(removedPlanStepIds),
    planOrderChanged: !stringArraysEqual(previousPreservedOrder, nextPreservedOrder),
    preservedNodeIds: Object.freeze(preservedNodeIds),
    addedNodeIds: Object.freeze(addedNodeIds),
    removedNodeIds: Object.freeze(removedNodeIds),
    graphOrderChanged: !stringArraysEqual(previousPreservedNodeOrder, nextPreservedNodeOrder),
    dependencyChangedNodeIds: Object.freeze(dependencyChangedNodeIds),
    revalidationNodeIds: Object.freeze(revalidationNodeIds),
  });
}

function deriveReconciliationImpact(
  previous: RequirementRevision,
  next: RequirementDraft,
  changes: TaskReconciliationChanges,
): TaskReconciliation["impact"] {
  const requirementSemanticsChanged =
    previous.objective !== next.objective ||
    !stringArraysEqual(previous.constraints, next.constraints) ||
    !stringArraysEqual(previous.acceptanceCriteria, next.acceptanceCriteria);
  if (
    requirementSemanticsChanged ||
    changes.removedPlanStepIds.length > 0 ||
    changes.removedNodeIds.length > 0 ||
    changes.planOrderChanged ||
    changes.graphOrderChanged ||
    changes.dependencyChangedNodeIds.length > 0 ||
    changes.revalidationNodeIds.length > 0
  ) {
    return "restructuring";
  }
  return changes.addedPlanStepIds.length > 0 || changes.addedNodeIds.length > 0
    ? "additive"
    : "editorial";
}

function planStepSemanticsEqual(left: PlanStep, right: PlanStep): boolean {
  return (
    left.title === right.title &&
    left.description === right.description &&
    stringArraysEqual(left.acceptanceCriteria, right.acceptanceCriteria)
  );
}

function nodeSemanticsEqual(
  left: TaskGraphRevision["nodes"][number],
  right: TaskGraphDraft["nodes"][number],
): boolean {
  return (
    left.sourcePlanStepId === right.sourcePlanStepId &&
    left.title === right.title &&
    left.description === right.description &&
    stringArraysEqual(left.acceptanceCriteria, right.acceptanceCriteria)
  );
}

function planDraftMatchesRevision(draft: PlanRevisionDraft, revision: PlanRevision): boolean {
  return (
    draft.revisionId === revision.revisionId &&
    draft.status === revision.status &&
    draft.basedOnRequirementRevisionId === revision.basedOnRequirementRevisionId &&
    draft.steps.length === revision.steps.length &&
    draft.steps.every(
      (step, index) =>
        step.stepId === revision.steps[index]?.stepId &&
        planStepSemanticsEqual(step, revision.steps[index]!),
    )
  );
}

function graphDraftMatchesRevision(draft: TaskGraphDraft, revision: TaskGraphRevision): boolean {
  return (
    draft.revisionId === revision.revisionId &&
    draft.basedOnPlanRevisionId === revision.basedOnPlanRevisionId &&
    draft.nodes.length === revision.nodes.length &&
    draft.nodes.every((node, index) => {
      const materialized = revision.nodes[index];
      return (
        materialized !== undefined &&
        node.nodeId === materialized.nodeId &&
        nodeSemanticsEqual(materialized, node) &&
        stringArraysEqual(node.dependsOnNodeIds, materialized.dependsOnNodeIds)
      );
    })
  );
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightValues = new Set(right);
  return rightValues.size === right.length && left.every((value) => rightValues.has(value));
}

function chainedMetadata(
  metadata: EventMetadata | undefined,
  causationEventId: string,
): EventMetadata {
  return Object.freeze({
    ...(metadata?.correlationId === undefined ? {} : { correlationId: metadata.correlationId }),
    ...(metadata?.actor === undefined ? {} : { actor: metadata.actor }),
    causationEventId,
  });
}

function assertDisjointChanges(
  preserved: readonly string[],
  added: readonly string[],
  removed: readonly string[],
): void {
  const all = [...preserved, ...added, ...removed];
  if (new Set(all).size !== all.length) {
    throw new TaskPlanError("storage_failure");
  }
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

function requireUuidArray(input: unknown, maxItems: number): readonly string[] {
  if (!Array.isArray(input) || input.length > maxItems) {
    throw new TaskPlanError("invalid_input");
  }
  const ids = input.map((value) => requireUuid(value));
  if (new Set(ids).size !== ids.length) {
    throw new TaskPlanError("invalid_input");
  }
  return Object.freeze(ids);
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
