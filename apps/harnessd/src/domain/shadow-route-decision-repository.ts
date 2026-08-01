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
import {
  ModelRouteClassificationError,
  classifyShadowModelRoute,
  decodeShadowModelRouteDecision,
  normalizeModelRouteFeatures,
  type ModelRouteFeatures,
  type ShadowModelRouteDecision,
} from "./model-route-classifier.js";
import {
  ModelRoutingProfileError,
  ModelRoutingProfileRepository,
} from "./model-routing-profile-repository.js";

const DECISION_STREAM_TYPE = "routing.task_decisions";
const DECISION_EVENT_TYPE = "routing.shadow_decision_recorded";
const DECISION_PROJECTION_NAME = "routing.shadow_decisions";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECTION_PROBE_KEY =
  "00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000";

export type ShadowRouteDecisionRecord = Readonly<{
  schemaVersion: 1;
  decisionId: string;
  taskId: string;
  taskVersion: number;
  nodeId: string | null;
  profileId: string;
  occurredAtMs: number;
  decision: ShadowModelRouteDecision;
}>;

export type RecordShadowRouteDecisionInput = Readonly<{
  decisionId: string;
  taskId: string;
  taskVersion: number;
  nodeId: string | null;
  profileId: string;
  expectedConfigurationRevisionId: string;
  occurredAtMs: number;
  features: ModelRouteFeatures;
  metadata?: EventMetadata;
}>;

export type ShadowRouteDecisionCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  record: ShadowRouteDecisionRecord;
}>;

export type ShadowRouteDecisionErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

const ERROR_MESSAGES: Readonly<Record<ShadowRouteDecisionErrorCode, string>> = Object.freeze({
  closed: "The shadow route decision repository is closed.",
  conflict: "The shadow route decision command conflicts with current state.",
  invalid_input: "The shadow route decision input is invalid.",
  not_found: "The shadow route decision does not exist.",
  storage_failure: "The shadow route decision repository operation failed.",
});

export class ShadowRouteDecisionError extends Error {
  readonly code: ShadowRouteDecisionErrorCode;

  constructor(code: ShadowRouteDecisionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ShadowRouteDecisionError";
    this.code = code;
  }
}

class ShadowRouteDecisionStateError extends Error {}

export const SHADOW_ROUTE_DECISION_PROJECTION: ProjectionDefinition = Object.freeze({
  name: DECISION_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) =>
    event.streamType === DECISION_STREAM_TYPE &&
    event.eventType === DECISION_EVENT_TYPE &&
    UUID_PATTERN.test(event.streamId) &&
    UUID_PATTERN.test(event.eventId)
      ? [decisionProjectionKey(event.streamId, event.eventId)]
      : [],
  reduce: ({ current, event }) => {
    if (current !== undefined) {
      throw new ShadowRouteDecisionStateError();
    }
    return { type: "set", state: requireJsonValue(decodeDecisionEvent(event)) };
  },
});

export class ShadowRouteDecisionRepository {
  readonly #events: HarnessEventStore;
  readonly #profiles: ModelRoutingProfileRepository;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(DECISION_PROJECTION_NAME, PROJECTION_PROBE_KEY);
      this.#profiles = new ModelRoutingProfileRepository(events);
      this.#events = events;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  record(input: RecordShadowRouteDecisionInput): ShadowRouteDecisionCommandResult {
    const normalized = normalizeRecordInput(input);
    try {
      const existing = this.#events.readByEventId(normalized.decisionId);
      if (existing !== undefined) {
        return this.#retryExisting(normalized, existing);
      }

      const profile = this.#profiles.readProfile(normalized.profileId);
      if (
        profile.activeConfiguration.revisionId !== normalized.expectedConfigurationRevisionId ||
        normalized.occurredAtMs < profile.updatedAtMs
      ) {
        throw new ShadowRouteDecisionError("conflict");
      }
      const decision = classifyShadowModelRoute(normalized.features, profile.activeConfiguration);
      const record = freezeDecisionRecord({
        schemaVersion: 1,
        decisionId: normalized.decisionId,
        taskId: normalized.taskId,
        taskVersion: normalized.taskVersion,
        nodeId: normalized.nodeId,
        profileId: normalized.profileId,
        occurredAtMs: normalized.occurredAtMs,
        decision,
      });
      const appended = this.#events.append(eventFromRecord(record, normalized.metadata));
      return Object.freeze({ duplicate: appended.duplicate, event: appended.event, record });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readDecision(taskId: string, decisionId: string): ShadowRouteDecisionRecord {
    if (!isUuid(taskId) || !isUuid(decisionId)) {
      throw new ShadowRouteDecisionError("invalid_input");
    }
    try {
      const projected = this.#events.readProjectionState(
        DECISION_PROJECTION_NAME,
        decisionProjectionKey(taskId, decisionId),
      );
      if (projected === undefined) {
        throw new ShadowRouteDecisionError("not_found");
      }
      return decodeDecisionRecord(projected.state);
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  listTaskDecisions(
    taskId: string,
    afterDecisionId = "",
    limit = 100,
  ): readonly ShadowRouteDecisionRecord[] {
    if (
      !isUuid(taskId) ||
      (afterDecisionId !== "" && !isUuid(afterDecisionId)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new ShadowRouteDecisionError("invalid_input");
    }
    const prefix = `${taskId}/`;
    const afterKey =
      afterDecisionId === "" ? prefix : decisionProjectionKey(taskId, afterDecisionId);
    try {
      return Object.freeze(
        this.#events
          .listProjectionStates(DECISION_PROJECTION_NAME, afterKey, limit)
          .filter((projected) => projected.key.startsWith(prefix))
          .map((projected) => decodeDecisionRecord(projected.state)),
      );
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  #retryExisting(
    input: RecordShadowRouteDecisionInput,
    event: StoredEvent,
  ): ShadowRouteDecisionCommandResult {
    let record: ShadowRouteDecisionRecord;
    try {
      record = decodeDecisionEvent(event);
    } catch {
      throw new ShadowRouteDecisionError("conflict");
    }
    if (!recordMatchesInput(record, input)) {
      throw new ShadowRouteDecisionError("conflict");
    }
    const appended = this.#events.append(eventFromRecord(record, input.metadata));
    if (!appended.duplicate) {
      throw new ShadowRouteDecisionError("conflict");
    }
    return Object.freeze({ duplicate: true, event: appended.event, record });
  }
}

function normalizeRecordInput(input: unknown): RecordShadowRouteDecisionInput {
  try {
    const record = requireCommandRecord(input, [
      "decisionId",
      "expectedConfigurationRevisionId",
      "features",
      "nodeId",
      "occurredAtMs",
      "profileId",
      "taskId",
      "taskVersion",
    ]);
    return Object.freeze({
      decisionId: requireUuid(record.decisionId),
      taskId: requireUuid(record.taskId),
      taskVersion: requirePositiveInteger(record.taskVersion),
      nodeId: record.nodeId === null ? null : requireUuid(record.nodeId),
      profileId: requireUuid(record.profileId),
      expectedConfigurationRevisionId: requireUuid(record.expectedConfigurationRevisionId),
      occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
      features: normalizeModelRouteFeatures(record.features),
      ...(record.metadata === undefined
        ? {}
        : { metadata: normalizeEventMetadata(record.metadata) }),
    });
  } catch (error: unknown) {
    if (error instanceof ShadowRouteDecisionError) {
      throw error;
    }
    if (error instanceof ModelRouteClassificationError) {
      throw new ShadowRouteDecisionError("invalid_input");
    }
    throw new ShadowRouteDecisionError("invalid_input");
  }
}

function normalizeEventMetadata(input: unknown): EventMetadata {
  if (
    !validateJsonValue(input).ok ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  const metadata = input as Record<string, unknown>;
  const keys = Object.keys(metadata);
  if (keys.some((key) => !["actor", "causationEventId", "correlationId"].includes(key))) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  if (metadata.actor !== undefined && !NamespacedTokenSchema.safeParse(metadata.actor).success) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  if (metadata.causationEventId !== undefined && !isUuid(metadata.causationEventId)) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  if (
    metadata.correlationId !== undefined &&
    !RpcIdSchema.safeParse(metadata.correlationId).success
  ) {
    throw new ShadowRouteDecisionError("invalid_input");
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

function eventFromRecord(
  record: ShadowRouteDecisionRecord,
  metadata: EventMetadata | undefined,
): Parameters<HarnessEventStore["append"]>[0] {
  return Object.freeze({
    eventId: record.decisionId,
    streamType: DECISION_STREAM_TYPE,
    streamId: record.taskId,
    eventType: DECISION_EVENT_TYPE,
    eventVersion: 1,
    occurredAtMs: record.occurredAtMs,
    payload: requireJsonValue(record),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function decodeDecisionEvent(event: StoredEvent): ShadowRouteDecisionRecord {
  if (
    event.streamType !== DECISION_STREAM_TYPE ||
    event.eventType !== DECISION_EVENT_TYPE ||
    event.eventVersion !== 1
  ) {
    throw new ShadowRouteDecisionStateError();
  }
  const record = decodeDecisionRecord(event.payload);
  if (
    record.decisionId !== event.eventId ||
    record.taskId !== event.streamId ||
    record.occurredAtMs !== event.occurredAtMs
  ) {
    throw new ShadowRouteDecisionStateError();
  }
  return record;
}

function decodeDecisionRecord(input: unknown): ShadowRouteDecisionRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ShadowRouteDecisionStateError();
    }
    const record = requireStateRecord(input, [
      "decision",
      "decisionId",
      "nodeId",
      "occurredAtMs",
      "profileId",
      "schemaVersion",
      "taskId",
      "taskVersion",
    ]);
    if (record.schemaVersion !== 1) {
      throw new ShadowRouteDecisionStateError();
    }
    return freezeDecisionRecord({
      schemaVersion: 1,
      decisionId: requireStateUuid(record.decisionId),
      taskId: requireStateUuid(record.taskId),
      taskVersion: requireStatePositiveInteger(record.taskVersion),
      nodeId: record.nodeId === null ? null : requireStateUuid(record.nodeId),
      profileId: requireStateUuid(record.profileId),
      occurredAtMs: requireStateNonNegativeInteger(record.occurredAtMs),
      decision: decodeShadowModelRouteDecision(record.decision),
    });
  } catch (error: unknown) {
    if (error instanceof ShadowRouteDecisionStateError) {
      throw error;
    }
    throw new ShadowRouteDecisionStateError();
  }
}

function recordMatchesInput(
  record: ShadowRouteDecisionRecord,
  input: RecordShadowRouteDecisionInput,
): boolean {
  return (
    record.decisionId === input.decisionId &&
    record.taskId === input.taskId &&
    record.taskVersion === input.taskVersion &&
    record.nodeId === input.nodeId &&
    record.profileId === input.profileId &&
    record.occurredAtMs === input.occurredAtMs &&
    record.decision.resolvedTarget.configurationRevisionId ===
      input.expectedConfigurationRevisionId &&
    JSON.stringify(record.decision.features) === JSON.stringify(input.features)
  );
}

function freezeDecisionRecord(input: ShadowRouteDecisionRecord): ShadowRouteDecisionRecord {
  return Object.freeze(input);
}

function decisionProjectionKey(taskId: string, decisionId: string): string {
  return `${taskId}/${decisionId}`;
}

function requireCommandRecord(
  input: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  const prototype = Object.getPrototypeOf(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([...required, "metadata"]);
  const keys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    keys.some((key) => {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  return input as Record<string, unknown>;
}

function requireStateRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ShadowRouteDecisionStateError();
  }
  const actual = Object.keys(input).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new ShadowRouteDecisionStateError();
  }
  return input as Record<string, unknown>;
}

function requireJsonValue(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) {
    throw new ShadowRouteDecisionStateError();
  }
  return input as JsonValue;
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  return input;
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  return input as number;
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ShadowRouteDecisionError("invalid_input");
  }
  return input as number;
}

function requireStateUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ShadowRouteDecisionStateError();
  }
  return input;
}

function requireStatePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ShadowRouteDecisionStateError();
  }
  return input as number;
}

function requireStateNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ShadowRouteDecisionStateError();
  }
  return input as number;
}

function mapRepositoryError(error: unknown): ShadowRouteDecisionError {
  if (error instanceof ShadowRouteDecisionError) {
    return error;
  }
  if (error instanceof EventStoreError) {
    if (error.code === "closed") {
      return new ShadowRouteDecisionError("closed");
    }
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new ShadowRouteDecisionError("conflict");
    }
    if (error.code === "invalid_event") {
      return new ShadowRouteDecisionError("invalid_input");
    }
  }
  if (error instanceof ModelRoutingProfileError) {
    if (error.code === "closed") {
      return new ShadowRouteDecisionError("closed");
    }
    if (error.code === "not_found" || error.code === "conflict") {
      return new ShadowRouteDecisionError("conflict");
    }
  }
  return new ShadowRouteDecisionError("storage_failure");
}

if (
  !NamespacedTokenSchema.safeParse(DECISION_STREAM_TYPE).success ||
  !NamespacedTokenSchema.safeParse(DECISION_EVENT_TYPE).success ||
  !NamespacedTokenSchema.safeParse(DECISION_PROJECTION_NAME).success
) {
  throw new Error("The shadow route decision event names are invalid.");
}
