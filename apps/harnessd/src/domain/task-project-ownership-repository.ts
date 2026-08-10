import {
  NamespacedTokenSchema,
  RpcIdSchema,
  validateJsonValue,
  type JsonValue,
} from "@codex-harness/protocol";

import {
  EventStoreError,
  type EventMetadata,
  type HarnessEventStore,
  type ProjectionDefinition,
  type StoredEvent,
} from "../persistence/event-store.js";
import { ProjectRegistryError, ProjectRegistryRepository } from "./project-registry-repository.js";
import {
  TaskPlanError,
  TaskPlanRepository,
  prepareTaskCreatedEvent,
  type CreateTaskInput,
  type TaskPlanRecord,
} from "./task-plan-store.js";

const OWNERSHIP_STREAM_TYPE = "task.project_ownership";
const TASK_ASSIGNED = "task.project_assigned";
const TASK_OWNERSHIP_PROJECTION_NAME = "task.current_project";
const PROJECT_TASK_INDEX_PROJECTION_NAME = "project.current_tasks";
const PROJECTION_PROBE_KEY = "00000000-0000-4000-8000-000000000000";
const PROJECT_TASK_PROBE_KEY = `${PROJECTION_PROBE_KEY}/${PROJECTION_PROBE_KEY}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TaskProjectOwnershipRecord = Readonly<{
  schemaVersion: 1;
  taskId: string;
  ownershipVersion: number;
  projectId: string;
  taskVersionAtAssignment: number;
  projectVersionAtAssignment: number;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type AssignTaskToProjectInput = Readonly<{
  eventId: string;
  taskId: string;
  expectedTaskVersion: number;
  expectedOwnershipVersion: number;
  previousProjectId: string | null;
  projectId: string;
  expectedProjectVersion: number;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type TaskProjectOwnershipCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  ownership: TaskProjectOwnershipRecord;
}>;

export type CreateTaskInProjectInput = Readonly<{
  task: CreateTaskInput;
  ownershipEventId: string;
  projectId: string;
  expectedProjectVersion: number;
}>;

export type CreateTaskInProjectResult = Readonly<{
  duplicate: boolean;
  events: readonly StoredEvent[];
  task: TaskPlanRecord;
  ownership: TaskProjectOwnershipRecord;
}>;

export type TaskProjectOwnershipErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

const ERROR_MESSAGES: Readonly<Record<TaskProjectOwnershipErrorCode, string>> = Object.freeze({
  closed: "The task project ownership repository is closed.",
  conflict: "The task project ownership command conflicts with current state.",
  invalid_input: "The task project ownership input is invalid.",
  not_found: "The task project ownership does not exist.",
  storage_failure: "The task project ownership operation failed.",
});

export class TaskProjectOwnershipError extends Error {
  readonly code: TaskProjectOwnershipErrorCode;

  constructor(code: TaskProjectOwnershipErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TaskProjectOwnershipError";
    this.code = code;
  }
}

class TaskProjectOwnershipStateError extends Error {}

type OwnershipEventData = Readonly<{
  expectedOwnershipVersion: number;
  previousProjectId: string | null;
  ownership: TaskProjectOwnershipRecord;
}>;

export const TASK_PROJECT_OWNERSHIP_PROJECTION: ProjectionDefinition = Object.freeze({
  name: TASK_OWNERSHIP_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) =>
    event.streamType === OWNERSHIP_STREAM_TYPE &&
    event.eventType === TASK_ASSIGNED &&
    UUID_PATTERN.test(event.streamId)
      ? [event.streamId]
      : [],
  reduce: ({ current, event }) => ({
    type: "set",
    state: requireJsonValue(reduceOwnershipEvent(current, event)),
  }),
});

export const PROJECT_TASK_INDEX_PROJECTION: ProjectionDefinition = Object.freeze({
  name: PROJECT_TASK_INDEX_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) => {
    if (
      event.streamType !== OWNERSHIP_STREAM_TYPE ||
      event.eventType !== TASK_ASSIGNED ||
      !UUID_PATTERN.test(event.streamId)
    ) {
      return [];
    }
    const eventData = decodeOwnershipEvent(event);
    const keys = [projectTaskKey(eventData.ownership.projectId, eventData.ownership.taskId)];
    if (eventData.previousProjectId !== null) {
      keys.unshift(projectTaskKey(eventData.previousProjectId, eventData.ownership.taskId));
    }
    return keys;
  },
  reduce: ({ key, current, event }) =>
    reduceProjectTaskIndex(key, current, decodeOwnershipEvent(event)),
});

export class TaskProjectOwnershipRepository {
  readonly #events: HarnessEventStore;
  readonly #tasks: TaskPlanRepository;
  readonly #projects: ProjectRegistryRepository;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(TASK_OWNERSHIP_PROJECTION_NAME, PROJECTION_PROBE_KEY);
      events.readProjectionState(PROJECT_TASK_INDEX_PROJECTION_NAME, PROJECT_TASK_PROBE_KEY);
      this.#tasks = new TaskPlanRepository(events);
      this.#projects = new ProjectRegistryRepository(events);
      this.#events = events;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  createTaskInProject(input: CreateTaskInProjectInput): CreateTaskInProjectResult {
    const normalized = normalizeCreateTaskInProjectInput(input);
    const taskEvent = prepareTaskCreatedEvent(normalized.task);
    const ownership = freezeOwnership({
      schemaVersion: 1,
      taskId: taskEvent.streamId,
      ownershipVersion: 1,
      projectId: normalized.projectId,
      taskVersionAtAssignment: 1,
      projectVersionAtAssignment: normalized.expectedProjectVersion,
      createdAtMs: taskEvent.occurredAtMs,
      updatedAtMs: taskEvent.occurredAtMs,
    });
    const ownershipEvent = eventFromOwnership(
      normalized.ownershipEventId,
      taskEvent.occurredAtMs,
      Object.freeze({
        expectedOwnershipVersion: 0,
        previousProjectId: null,
        ownership,
      }),
      chainedOwnershipMetadata(taskEvent.metadata, taskEvent.eventId),
    );

    try {
      const existingTaskEvent = this.#events.readByEventId(taskEvent.eventId);
      const existingOwnershipEvent = this.#events.readByEventId(ownershipEvent.eventId);
      if ((existingTaskEvent === undefined) !== (existingOwnershipEvent === undefined)) {
        throw new TaskProjectOwnershipError("conflict");
      }
      if (existingTaskEvent === undefined) {
        const project = this.#projects.readProject(normalized.projectId);
        if (
          project.projectVersion !== normalized.expectedProjectVersion ||
          taskEvent.occurredAtMs < project.updatedAtMs
        ) {
          throw new TaskProjectOwnershipError("conflict");
        }
      }

      const appended = this.#events.appendBatch([taskEvent, ownershipEvent]);
      if (existingTaskEvent !== undefined && !appended.duplicate) {
        throw new TaskProjectOwnershipError("conflict");
      }
      return Object.freeze({
        duplicate: appended.duplicate,
        events: appended.events,
        task: this.#tasks.readTask(taskEvent.streamId),
        ownership,
      });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  assignTask(input: AssignTaskToProjectInput): TaskProjectOwnershipCommandResult {
    const normalized = normalizeAssignInput(input);
    try {
      const existingEvent = this.#events.readByEventId(normalized.eventId);
      if (existingEvent !== undefined) {
        return this.#retryExisting(normalized, existingEvent);
      }

      const current = this.#readOptionalOwnership(normalized.taskId);
      if (
        (current === undefined &&
          (normalized.expectedOwnershipVersion !== 0 || normalized.previousProjectId !== null)) ||
        (current !== undefined &&
          (normalized.expectedOwnershipVersion !== current.ownershipVersion ||
            normalized.previousProjectId !== current.projectId ||
            normalized.projectId === current.projectId ||
            normalized.occurredAtMs < current.updatedAtMs))
      ) {
        throw new TaskProjectOwnershipError("conflict");
      }

      const task = this.#tasks.readTask(normalized.taskId);
      const project = this.#projects.readProject(normalized.projectId);
      if (
        task.taskVersion !== normalized.expectedTaskVersion ||
        project.projectVersion !== normalized.expectedProjectVersion ||
        normalized.occurredAtMs < task.updatedAtMs ||
        normalized.occurredAtMs < project.updatedAtMs
      ) {
        throw new TaskProjectOwnershipError("conflict");
      }

      const ownership = freezeOwnership({
        schemaVersion: 1,
        taskId: normalized.taskId,
        ownershipVersion: normalized.expectedOwnershipVersion + 1,
        projectId: normalized.projectId,
        taskVersionAtAssignment: task.taskVersion,
        projectVersionAtAssignment: project.projectVersion,
        createdAtMs: current?.createdAtMs ?? normalized.occurredAtMs,
        updatedAtMs: normalized.occurredAtMs,
      });
      const eventData = Object.freeze({
        expectedOwnershipVersion: normalized.expectedOwnershipVersion,
        previousProjectId: normalized.previousProjectId,
        ownership,
      });
      const appended = this.#events.append(
        eventFromOwnership(
          normalized.eventId,
          normalized.occurredAtMs,
          eventData,
          normalized.metadata,
        ),
      );
      return Object.freeze({ duplicate: appended.duplicate, event: appended.event, ownership });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readOwnership(taskId: string): TaskProjectOwnershipRecord {
    if (!isUuid(taskId)) {
      throw new TaskProjectOwnershipError("invalid_input");
    }
    try {
      const ownership = this.#readOptionalOwnership(taskId);
      if (ownership === undefined) {
        throw new TaskProjectOwnershipError("not_found");
      }
      return ownership;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  listOwnerships(afterTaskId = "", limit = 100): readonly TaskProjectOwnershipRecord[] {
    validateListInput(afterTaskId, limit);
    try {
      return Object.freeze(
        this.#events
          .listProjectionStates(TASK_OWNERSHIP_PROJECTION_NAME, afterTaskId, limit)
          .map((projected) => decodeOwnershipRecord(projected.state)),
      );
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  listTasksForProject(
    projectId: string,
    afterTaskId = "",
    limit = 100,
  ): readonly TaskProjectOwnershipRecord[] {
    if (!isUuid(projectId)) {
      throw new TaskProjectOwnershipError("invalid_input");
    }
    validateListInput(afterTaskId, limit);
    const prefix = `${projectId}/`;
    const afterKey = afterTaskId === "" ? prefix : projectTaskKey(projectId, afterTaskId);
    try {
      const ownerships: TaskProjectOwnershipRecord[] = [];
      for (const projected of this.#events.listProjectionStates(
        PROJECT_TASK_INDEX_PROJECTION_NAME,
        afterKey,
        limit,
      )) {
        if (!projected.key.startsWith(prefix)) {
          break;
        }
        const ownership = decodeOwnershipRecord(projected.state);
        if (projectTaskKey(ownership.projectId, ownership.taskId) !== projected.key) {
          throw new TaskProjectOwnershipStateError();
        }
        ownerships.push(ownership);
      }
      return Object.freeze(ownerships);
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  #readOptionalOwnership(taskId: string): TaskProjectOwnershipRecord | undefined {
    const projected = this.#events.readProjectionState(TASK_OWNERSHIP_PROJECTION_NAME, taskId);
    return projected === undefined ? undefined : decodeOwnershipRecord(projected.state);
  }

  #retryExisting(
    input: AssignTaskToProjectInput,
    event: StoredEvent,
  ): TaskProjectOwnershipCommandResult {
    let eventData: OwnershipEventData;
    try {
      eventData = decodeOwnershipEvent(event);
    } catch {
      throw new TaskProjectOwnershipError("conflict");
    }
    if (!eventDataMatchesInput(eventData, event, input)) {
      throw new TaskProjectOwnershipError("conflict");
    }
    const appended = this.#events.append(
      eventFromOwnership(event.eventId, event.occurredAtMs, eventData, input.metadata),
    );
    if (!appended.duplicate) {
      throw new TaskProjectOwnershipError("conflict");
    }
    return Object.freeze({
      duplicate: true,
      event: appended.event,
      ownership: eventData.ownership,
    });
  }
}

function normalizeCreateTaskInProjectInput(input: unknown): CreateTaskInProjectInput {
  try {
    const record = requireExactDataRecord(input, [
      "expectedProjectVersion",
      "ownershipEventId",
      "projectId",
      "task",
    ]);
    const ownershipEventId = requireUuid(record.ownershipEventId);
    const projectId = requireUuid(record.projectId);
    const expectedProjectVersion = requirePositiveInteger(record.expectedProjectVersion);
    const task = record.task as CreateTaskInput;
    const taskEvent = prepareTaskCreatedEvent(task);
    if (
      taskEvent.eventId === taskEvent.streamId ||
      ownershipEventId === taskEvent.eventId ||
      ownershipEventId === taskEvent.streamId ||
      !validateJsonValue({ ownershipEventId, projectId, expectedProjectVersion }).ok
    ) {
      throw new TaskProjectOwnershipError("invalid_input");
    }
    return Object.freeze({ task, ownershipEventId, projectId, expectedProjectVersion });
  } catch (error: unknown) {
    if (error instanceof TaskProjectOwnershipError) {
      throw error;
    }
    if (error instanceof TaskPlanError) {
      throw new TaskProjectOwnershipError(
        error.code === "invalid_input" ? "invalid_input" : "storage_failure",
      );
    }
    throw new TaskProjectOwnershipError("invalid_input");
  }
}

function chainedOwnershipMetadata(
  metadata: EventMetadata | undefined,
  causationEventId: string,
): EventMetadata {
  return Object.freeze({
    ...(metadata?.actor === undefined ? {} : { actor: metadata.actor }),
    causationEventId,
    ...(metadata?.correlationId === undefined ? {} : { correlationId: metadata.correlationId }),
  });
}

function reduceOwnershipEvent(
  current: JsonValue | undefined,
  event: StoredEvent,
): TaskProjectOwnershipRecord {
  const eventData = decodeOwnershipEvent(event);
  const { ownership, expectedOwnershipVersion, previousProjectId } = eventData;
  if (
    ownership.ownershipVersion !== expectedOwnershipVersion + 1 ||
    ownership.updatedAtMs !== event.occurredAtMs
  ) {
    throw new TaskProjectOwnershipStateError();
  }
  if (current === undefined) {
    if (
      expectedOwnershipVersion !== 0 ||
      previousProjectId !== null ||
      ownership.createdAtMs !== event.occurredAtMs
    ) {
      throw new TaskProjectOwnershipStateError();
    }
    return ownership;
  }

  const previous = decodeOwnershipRecord(current);
  if (
    previous.taskId !== ownership.taskId ||
    expectedOwnershipVersion !== previous.ownershipVersion ||
    previousProjectId !== previous.projectId ||
    ownership.projectId === previous.projectId ||
    ownership.createdAtMs !== previous.createdAtMs ||
    event.occurredAtMs < previous.updatedAtMs
  ) {
    throw new TaskProjectOwnershipStateError();
  }
  return ownership;
}

function reduceProjectTaskIndex(
  key: string,
  current: JsonValue | undefined,
  eventData: OwnershipEventData,
): Readonly<{ type: "set"; state: JsonValue }> | Readonly<{ type: "delete" }> {
  const { ownership, expectedOwnershipVersion, previousProjectId } = eventData;
  const newKey = projectTaskKey(ownership.projectId, ownership.taskId);
  if (key === newKey) {
    if (current !== undefined) {
      throw new TaskProjectOwnershipStateError();
    }
    return { type: "set", state: requireJsonValue(ownership) };
  }
  if (previousProjectId === null || key !== projectTaskKey(previousProjectId, ownership.taskId)) {
    throw new TaskProjectOwnershipStateError();
  }
  if (current === undefined) {
    throw new TaskProjectOwnershipStateError();
  }
  const previous = decodeOwnershipRecord(current);
  if (
    previous.taskId !== ownership.taskId ||
    previous.projectId !== previousProjectId ||
    previous.ownershipVersion !== expectedOwnershipVersion ||
    previous.createdAtMs !== ownership.createdAtMs
  ) {
    throw new TaskProjectOwnershipStateError();
  }
  return { type: "delete" };
}

function normalizeAssignInput(input: unknown): AssignTaskToProjectInput {
  try {
    const record = requireCommandRecord(input, [
      "eventId",
      "expectedOwnershipVersion",
      "expectedProjectVersion",
      "expectedTaskVersion",
      "occurredAtMs",
      "previousProjectId",
      "projectId",
      "taskId",
    ]);
    const expectedOwnershipVersion = requireNonNegativeInteger(record.expectedOwnershipVersion);
    const previousProjectId =
      record.previousProjectId === null ? null : requireUuid(record.previousProjectId);
    if ((expectedOwnershipVersion === 0) !== (previousProjectId === null)) {
      throw new TaskProjectOwnershipError("invalid_input");
    }
    const normalized = Object.freeze({
      eventId: requireUuid(record.eventId),
      taskId: requireUuid(record.taskId),
      expectedTaskVersion: requirePositiveInteger(record.expectedTaskVersion),
      expectedOwnershipVersion,
      previousProjectId,
      projectId: requireUuid(record.projectId),
      expectedProjectVersion: requirePositiveInteger(record.expectedProjectVersion),
      occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
      ...(record.metadata === undefined
        ? {}
        : { metadata: normalizeEventMetadata(record.metadata) }),
    });
    if (!validateJsonValue(normalized).ok) {
      throw new TaskProjectOwnershipError("invalid_input");
    }
    return normalized;
  } catch (error: unknown) {
    if (error instanceof TaskProjectOwnershipError) {
      throw error;
    }
    throw new TaskProjectOwnershipError("invalid_input");
  }
}

function normalizeEventMetadata(input: unknown): EventMetadata {
  const metadata = requireExactDataRecord(
    input,
    [],
    ["actor", "causationEventId", "correlationId"],
  );
  if (
    (metadata.actor !== undefined && !NamespacedTokenSchema.safeParse(metadata.actor).success) ||
    (metadata.causationEventId !== undefined && !isUuid(metadata.causationEventId)) ||
    (metadata.correlationId !== undefined && !RpcIdSchema.safeParse(metadata.correlationId).success)
  ) {
    throw new TaskProjectOwnershipError("invalid_input");
  }
  return Object.freeze({
    ...(typeof metadata.actor === "string" ? { actor: metadata.actor } : {}),
    ...(typeof metadata.causationEventId === "string"
      ? { causationEventId: metadata.causationEventId }
      : {}),
    ...(typeof metadata.correlationId === "string"
      ? { correlationId: metadata.correlationId }
      : {}),
  });
}

function eventFromOwnership(
  eventId: string,
  occurredAtMs: number,
  eventData: OwnershipEventData,
  metadata: EventMetadata | undefined,
): Parameters<HarnessEventStore["append"]>[0] {
  return Object.freeze({
    eventId,
    streamType: OWNERSHIP_STREAM_TYPE,
    streamId: eventData.ownership.taskId,
    eventType: TASK_ASSIGNED,
    eventVersion: 1,
    occurredAtMs,
    payload: requireJsonValue(eventData),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function decodeOwnershipEvent(event: StoredEvent): OwnershipEventData {
  if (
    event.streamType !== OWNERSHIP_STREAM_TYPE ||
    event.eventType !== TASK_ASSIGNED ||
    event.eventVersion !== 1
  ) {
    throw new TaskProjectOwnershipStateError();
  }
  const payload = requireStateRecord(event.payload, [
    "expectedOwnershipVersion",
    "ownership",
    "previousProjectId",
  ]);
  const ownership = decodeOwnershipRecord(payload.ownership);
  const expectedOwnershipVersion = requireStateNonNegativeInteger(payload.expectedOwnershipVersion);
  const previousProjectId = requireStateNullableUuid(payload.previousProjectId);
  if (
    ownership.taskId !== event.streamId ||
    ownership.updatedAtMs !== event.occurredAtMs ||
    ownership.ownershipVersion !== expectedOwnershipVersion + 1 ||
    (expectedOwnershipVersion === 0) !== (previousProjectId === null)
  ) {
    throw new TaskProjectOwnershipStateError();
  }
  return Object.freeze({ expectedOwnershipVersion, previousProjectId, ownership });
}

function decodeOwnershipRecord(input: unknown): TaskProjectOwnershipRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new TaskProjectOwnershipStateError();
    }
    const record = requireStateRecord(input, [
      "createdAtMs",
      "ownershipVersion",
      "projectId",
      "projectVersionAtAssignment",
      "schemaVersion",
      "taskId",
      "taskVersionAtAssignment",
      "updatedAtMs",
    ]);
    const createdAtMs = requireStateNonNegativeInteger(record.createdAtMs);
    const updatedAtMs = requireStateNonNegativeInteger(record.updatedAtMs);
    if (record.schemaVersion !== 1 || createdAtMs > updatedAtMs) {
      throw new TaskProjectOwnershipStateError();
    }
    return freezeOwnership({
      schemaVersion: 1,
      taskId: requireStateUuid(record.taskId),
      ownershipVersion: requireStatePositiveInteger(record.ownershipVersion),
      projectId: requireStateUuid(record.projectId),
      taskVersionAtAssignment: requireStatePositiveInteger(record.taskVersionAtAssignment),
      projectVersionAtAssignment: requireStatePositiveInteger(record.projectVersionAtAssignment),
      createdAtMs,
      updatedAtMs,
    });
  } catch (error: unknown) {
    if (error instanceof TaskProjectOwnershipStateError) {
      throw error;
    }
    throw new TaskProjectOwnershipStateError();
  }
}

function eventDataMatchesInput(
  eventData: OwnershipEventData,
  event: StoredEvent,
  input: AssignTaskToProjectInput,
): boolean {
  return (
    event.eventId === input.eventId &&
    event.occurredAtMs === input.occurredAtMs &&
    eventData.ownership.taskId === input.taskId &&
    eventData.expectedOwnershipVersion === input.expectedOwnershipVersion &&
    eventData.previousProjectId === input.previousProjectId &&
    eventData.ownership.projectId === input.projectId &&
    eventData.ownership.taskVersionAtAssignment === input.expectedTaskVersion &&
    eventData.ownership.projectVersionAtAssignment === input.expectedProjectVersion
  );
}

function validateListInput(afterTaskId: string, limit: number): void {
  if (
    (afterTaskId !== "" && !isUuid(afterTaskId)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1_000
  ) {
    throw new TaskProjectOwnershipError("invalid_input");
  }
}

function projectTaskKey(projectId: string, taskId: string): string {
  return `${projectId}/${taskId}`;
}

function freezeOwnership(input: TaskProjectOwnershipRecord): TaskProjectOwnershipRecord {
  return Object.freeze(input);
}

function requireCommandRecord(
  input: unknown,
  required: readonly string[],
): Record<string, unknown> {
  return requireExactDataRecord(input, required, ["metadata"]);
}

function requireExactDataRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TaskProjectOwnershipError("invalid_input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    keys.some((key) => {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new TaskProjectOwnershipError("invalid_input");
  }
  return input as Record<string, unknown>;
}

function requireStateRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TaskProjectOwnershipStateError();
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TaskProjectOwnershipStateError();
  }
  return input as Record<string, unknown>;
}

function requireJsonValue(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) {
    throw new TaskProjectOwnershipStateError();
  }
  return input as JsonValue;
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new TaskProjectOwnershipError("invalid_input");
  }
  return input;
}

function requireStateUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new TaskProjectOwnershipStateError();
  }
  return input;
}

function requireStateNullableUuid(input: unknown): string | null {
  return input === null ? null : requireStateUuid(input);
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TaskProjectOwnershipError("invalid_input");
  }
  return input as number;
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TaskProjectOwnershipError("invalid_input");
  }
  return input as number;
}

function requireStatePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TaskProjectOwnershipStateError();
  }
  return input as number;
}

function requireStateNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TaskProjectOwnershipStateError();
  }
  return input as number;
}

function mapRepositoryError(error: unknown): TaskProjectOwnershipError {
  if (error instanceof TaskProjectOwnershipError) {
    return error;
  }
  if (error instanceof EventStoreError) {
    if (error.code === "closed") {
      return new TaskProjectOwnershipError("closed");
    }
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new TaskProjectOwnershipError("conflict");
    }
    if (error.code === "invalid_event") {
      return new TaskProjectOwnershipError("invalid_input");
    }
  }
  if (error instanceof TaskPlanError || error instanceof ProjectRegistryError) {
    if (error.code === "closed") {
      return new TaskProjectOwnershipError("closed");
    }
    if (error.code === "not_found" || error.code === "conflict") {
      return new TaskProjectOwnershipError("conflict");
    }
    if (error.code === "invalid_input") {
      return new TaskProjectOwnershipError("invalid_input");
    }
  }
  return new TaskProjectOwnershipError("storage_failure");
}

if (
  !NamespacedTokenSchema.safeParse(OWNERSHIP_STREAM_TYPE).success ||
  !NamespacedTokenSchema.safeParse(TASK_ASSIGNED).success ||
  !NamespacedTokenSchema.safeParse(TASK_OWNERSHIP_PROJECTION_NAME).success ||
  !NamespacedTokenSchema.safeParse(PROJECT_TASK_INDEX_PROJECTION_NAME).success
) {
  throw new Error("The task project ownership event names are invalid.");
}
