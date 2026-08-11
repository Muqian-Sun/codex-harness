import { createHash } from "node:crypto";

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
  HarnessRouteOperationValidationError,
  normalizeHarnessRouteOperations,
  type HarnessRouteOperation,
} from "./harness-route-operation.js";
import { TaskPlanError, TaskPlanRepository, type TaskPlanRecord } from "./task-plan-store.js";
import type { TaskNode } from "./task-graph.js";

const MANIFEST_STREAM_TYPE = "task.node_operation_manifest";
const MANIFEST_PROPOSED = "task.node_operation_manifest_proposed";
const MANIFEST_CONFIRMED = "task.node_operation_manifest_confirmed";
const MANIFEST_PROJECTION_NAME = "task.current_node_operation_manifest";
const PROJECTION_PROBE_KEY =
  "00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type NodeOperationManifestPlanningFence = Readonly<{
  schemaVersion: 1;
  taskId: string;
  requirementRevisionId: string;
  planRevisionId: string;
  graphRevisionId: string;
  nodeId: string;
  nodeDigest: string;
  digest: string;
}>;

export type NodeOperationManifestRecord = Readonly<{
  schemaVersion: 1;
  taskId: string;
  nodeId: string;
  manifestId: string;
  stateVersion: number;
  status: "candidate" | "confirmed";
  planningFence: NodeOperationManifestPlanningFence;
  operations: readonly HarnessRouteOperation[];
  proposedAtTaskVersion: number;
  confirmedAtTaskVersion: number | null;
  proposedAtMs: number;
  confirmedAtMs: number | null;
  updatedAtMs: number;
}>;

export type ProposeNodeOperationManifestInput = Readonly<{
  manifestId: string;
  taskId: string;
  nodeId: string;
  expectedTaskVersion: number;
  expectedGraphRevisionId: string;
  expectedManifestStateVersion: number;
  previousManifestId: string | null;
  occurredAtMs: number;
  operations: readonly HarnessRouteOperation[];
  metadata?: EventMetadata;
}>;

export type ConfirmNodeOperationManifestInput = Readonly<{
  eventId: string;
  taskId: string;
  nodeId: string;
  manifestId: string;
  expectedTaskVersion: number;
  expectedGraphRevisionId: string;
  expectedManifestStateVersion: number;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type NodeOperationManifestCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  manifest: NodeOperationManifestRecord;
}>;

export type NodeOperationManifestErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "stale" | "storage_failure";

const ERROR_MESSAGES: Readonly<Record<NodeOperationManifestErrorCode, string>> = Object.freeze({
  closed: "The node operation manifest repository is closed.",
  conflict: "The node operation manifest command conflicts with current state.",
  invalid_input: "The node operation manifest input is invalid.",
  not_found: "The node operation manifest does not exist.",
  stale: "The node operation manifest does not match the active Task graph.",
  storage_failure: "The node operation manifest repository operation failed.",
});

export class NodeOperationManifestError extends Error {
  readonly code: NodeOperationManifestErrorCode;

  constructor(code: NodeOperationManifestErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "NodeOperationManifestError";
    this.code = code;
  }
}

class NodeOperationManifestStateError extends Error {}

type ProposedEventData = Readonly<{
  type: "proposed";
  expectedStateVersion: number;
  previousManifestId: string | null;
  manifest: NodeOperationManifestRecord & Readonly<{ status: "candidate" }>;
}>;

type ConfirmedEventData = Readonly<{
  type: "confirmed";
  expectedStateVersion: number;
  manifest: NodeOperationManifestRecord & Readonly<{ status: "confirmed" }>;
}>;

type ManifestEventData = ProposedEventData | ConfirmedEventData;

export const NODE_OPERATION_MANIFEST_PROJECTION: ProjectionDefinition = Object.freeze({
  name: MANIFEST_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) => {
    if (
      event.streamType !== MANIFEST_STREAM_TYPE ||
      (event.eventType !== MANIFEST_PROPOSED && event.eventType !== MANIFEST_CONFIRMED) ||
      !isUuid(event.streamId)
    ) {
      return [];
    }
    const eventData = decodeManifestEvent(event);
    return [manifestProjectionKey(event.streamId, eventData.manifest.nodeId)];
  },
  reduce: ({ current, event }) => ({
    type: "set",
    state: requireJsonValue(reduceManifestEvent(current, event)),
  }),
});

export class NodeOperationManifestRepository {
  readonly #events: HarnessEventStore;
  readonly #tasks: TaskPlanRepository;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(MANIFEST_PROJECTION_NAME, PROJECTION_PROBE_KEY);
      this.#tasks = new TaskPlanRepository(events);
      this.#events = events;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  propose(input: ProposeNodeOperationManifestInput): NodeOperationManifestCommandResult {
    const normalized = normalizeProposeInput(input);
    try {
      const existingEvent = this.#events.readByEventId(normalized.manifestId);
      if (existingEvent !== undefined) {
        return this.#retryProposed(normalized, existingEvent);
      }

      const task = this.#tasks.readTask(normalized.taskId);
      const node = requireWritableSubject(task, normalized, normalized.occurredAtMs);
      const current = this.#readOptionalManifest(normalized.taskId, normalized.nodeId);
      if (!matchesExpectedCurrent(current, normalized)) {
        throw new NodeOperationManifestError("conflict");
      }
      const planningFence = buildPlanningFence(task, node);
      const manifest = freezeManifest({
        schemaVersion: 1,
        taskId: normalized.taskId,
        nodeId: normalized.nodeId,
        manifestId: normalized.manifestId,
        stateVersion: normalized.expectedManifestStateVersion + 1,
        status: "candidate",
        planningFence,
        operations: normalized.operations,
        proposedAtTaskVersion: normalized.expectedTaskVersion,
        confirmedAtTaskVersion: null,
        proposedAtMs: normalized.occurredAtMs,
        confirmedAtMs: null,
        updatedAtMs: normalized.occurredAtMs,
      });
      const eventData = Object.freeze({
        type: "proposed" as const,
        expectedStateVersion: normalized.expectedManifestStateVersion,
        previousManifestId: normalized.previousManifestId,
        manifest: manifest as NodeOperationManifestRecord & Readonly<{ status: "candidate" }>,
      });
      const appended = this.#events.append(
        eventFromManifest(
          normalized.manifestId,
          normalized.occurredAtMs,
          eventData,
          normalized.metadata,
        ),
      );
      return Object.freeze({ duplicate: appended.duplicate, event: appended.event, manifest });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  confirm(input: ConfirmNodeOperationManifestInput): NodeOperationManifestCommandResult {
    const normalized = normalizeConfirmInput(input);
    try {
      const existingEvent = this.#events.readByEventId(normalized.eventId);
      if (existingEvent !== undefined) {
        return this.#retryConfirmed(normalized, existingEvent);
      }

      const task = this.#tasks.readTask(normalized.taskId);
      const node = requireWritableSubject(task, normalized, normalized.occurredAtMs);
      const current = this.#readOptionalManifest(normalized.taskId, normalized.nodeId);
      if (
        current === undefined ||
        current.status !== "candidate" ||
        current.manifestId !== normalized.manifestId ||
        current.stateVersion !== normalized.expectedManifestStateVersion ||
        normalized.occurredAtMs < current.updatedAtMs ||
        !planningFenceEquals(current.planningFence, buildPlanningFence(task, node))
      ) {
        throw new NodeOperationManifestError("conflict");
      }
      const manifest = freezeManifest({
        ...current,
        stateVersion: current.stateVersion + 1,
        status: "confirmed",
        confirmedAtTaskVersion: normalized.expectedTaskVersion,
        confirmedAtMs: normalized.occurredAtMs,
        updatedAtMs: normalized.occurredAtMs,
      });
      const eventData = Object.freeze({
        type: "confirmed" as const,
        expectedStateVersion: normalized.expectedManifestStateVersion,
        manifest: manifest as NodeOperationManifestRecord & Readonly<{ status: "confirmed" }>,
      });
      const appended = this.#events.append(
        eventFromManifest(
          normalized.eventId,
          normalized.occurredAtMs,
          eventData,
          normalized.metadata,
        ),
      );
      return Object.freeze({ duplicate: appended.duplicate, event: appended.event, manifest });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readLatestManifest(taskId: string, nodeId: string): NodeOperationManifestRecord {
    if (!isUuid(taskId) || !isUuid(nodeId)) {
      throw new NodeOperationManifestError("invalid_input");
    }
    try {
      const manifest = this.#readOptionalManifest(taskId, nodeId);
      if (manifest === undefined) {
        throw new NodeOperationManifestError("not_found");
      }
      return manifest;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readCurrentManifest(taskId: string, nodeId: string): NodeOperationManifestRecord {
    const manifest = this.readLatestManifest(taskId, nodeId);
    try {
      const task = this.#tasks.readTask(taskId);
      const node = task.activeGraph?.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (
        node === undefined ||
        !planningFenceEquals(manifest.planningFence, buildPlanningFence(task, node))
      ) {
        throw new NodeOperationManifestError("stale");
      }
      return manifest;
    } catch (error: unknown) {
      if (error instanceof TaskPlanError && error.code === "not_found") {
        throw new NodeOperationManifestError("stale");
      }
      throw mapRepositoryError(error);
    }
  }

  listTaskManifests(
    taskId: string,
    afterNodeId = "",
    limit = 100,
  ): readonly NodeOperationManifestRecord[] {
    if (
      !isUuid(taskId) ||
      (afterNodeId !== "" && !isUuid(afterNodeId)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new NodeOperationManifestError("invalid_input");
    }
    const prefix = `${taskId}/`;
    const afterKey = afterNodeId === "" ? prefix : manifestProjectionKey(taskId, afterNodeId);
    try {
      return Object.freeze(
        this.#events
          .listProjectionStates(MANIFEST_PROJECTION_NAME, afterKey, limit)
          .filter((projected) => projected.key.startsWith(prefix))
          .map((projected) => decodeManifestRecord(projected.state)),
      );
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  #readOptionalManifest(taskId: string, nodeId: string): NodeOperationManifestRecord | undefined {
    const projected = this.#events.readProjectionState(
      MANIFEST_PROJECTION_NAME,
      manifestProjectionKey(taskId, nodeId),
    );
    return projected === undefined ? undefined : decodeManifestRecord(projected.state);
  }

  #retryProposed(
    input: ProposeNodeOperationManifestInput,
    event: StoredEvent,
  ): NodeOperationManifestCommandResult {
    const eventData = requireEventType(decodeManifestEventForRetry(event), "proposed");
    if (!proposedEventMatchesInput(eventData, event, input)) {
      throw new NodeOperationManifestError("conflict");
    }
    const appended = this.#events.append(
      eventFromManifest(event.eventId, event.occurredAtMs, eventData, input.metadata),
    );
    if (!appended.duplicate) {
      throw new NodeOperationManifestError("conflict");
    }
    return Object.freeze({ duplicate: true, event: appended.event, manifest: eventData.manifest });
  }

  #retryConfirmed(
    input: ConfirmNodeOperationManifestInput,
    event: StoredEvent,
  ): NodeOperationManifestCommandResult {
    const eventData = requireEventType(decodeManifestEventForRetry(event), "confirmed");
    if (!confirmedEventMatchesInput(eventData, event, input)) {
      throw new NodeOperationManifestError("conflict");
    }
    const appended = this.#events.append(
      eventFromManifest(event.eventId, event.occurredAtMs, eventData, input.metadata),
    );
    if (!appended.duplicate) {
      throw new NodeOperationManifestError("conflict");
    }
    return Object.freeze({ duplicate: true, event: appended.event, manifest: eventData.manifest });
  }
}

function reduceManifestEvent(
  current: JsonValue | undefined,
  event: StoredEvent,
): NodeOperationManifestRecord {
  const eventData = decodeManifestEvent(event);
  const manifest = eventData.manifest;
  if (eventData.type === "proposed") {
    if (
      manifest.status !== "candidate" ||
      manifest.stateVersion !== eventData.expectedStateVersion + 1 ||
      manifest.proposedAtMs !== event.occurredAtMs ||
      manifest.updatedAtMs !== event.occurredAtMs ||
      manifest.confirmedAtMs !== null ||
      manifest.confirmedAtTaskVersion !== null ||
      manifest.manifestId !== event.eventId
    ) {
      throw new NodeOperationManifestStateError();
    }
    if (current === undefined) {
      if (eventData.expectedStateVersion !== 0 || eventData.previousManifestId !== null) {
        throw new NodeOperationManifestStateError();
      }
      return manifest;
    }
    const previous = decodeManifestRecord(current);
    if (
      previous.taskId !== manifest.taskId ||
      previous.nodeId !== manifest.nodeId ||
      previous.stateVersion !== eventData.expectedStateVersion ||
      previous.manifestId !== eventData.previousManifestId ||
      previous.manifestId === manifest.manifestId ||
      event.occurredAtMs < previous.updatedAtMs
    ) {
      throw new NodeOperationManifestStateError();
    }
    return manifest;
  }

  if (current === undefined) {
    throw new NodeOperationManifestStateError();
  }
  const previous = decodeManifestRecord(current);
  if (
    previous.status !== "candidate" ||
    manifest.status !== "confirmed" ||
    previous.stateVersion !== eventData.expectedStateVersion ||
    manifest.stateVersion !== previous.stateVersion + 1 ||
    manifest.taskId !== previous.taskId ||
    manifest.nodeId !== previous.nodeId ||
    manifest.manifestId !== previous.manifestId ||
    manifest.proposedAtTaskVersion !== previous.proposedAtTaskVersion ||
    manifest.proposedAtMs !== previous.proposedAtMs ||
    manifest.confirmedAtTaskVersion === null ||
    manifest.confirmedAtMs !== event.occurredAtMs ||
    manifest.updatedAtMs !== event.occurredAtMs ||
    event.occurredAtMs < previous.updatedAtMs ||
    !planningFenceEquals(manifest.planningFence, previous.planningFence) ||
    canonicalJson(manifest.operations as unknown as JsonValue) !==
      canonicalJson(previous.operations as unknown as JsonValue)
  ) {
    throw new NodeOperationManifestStateError();
  }
  return manifest;
}

function requireWritableSubject(
  task: TaskPlanRecord,
  input: Readonly<{
    taskId: string;
    nodeId: string;
    expectedTaskVersion: number;
    expectedGraphRevisionId: string;
  }>,
  occurredAtMs: number,
): TaskNode {
  const graph = task.activeGraph;
  const node = graph?.nodes.find((candidate) => candidate.nodeId === input.nodeId);
  if (
    task.taskId !== input.taskId ||
    task.taskVersion !== input.expectedTaskVersion ||
    graph === null ||
    graph.revisionId !== input.expectedGraphRevisionId ||
    node === undefined ||
    node.status !== "pending" ||
    occurredAtMs < task.updatedAtMs
  ) {
    throw new NodeOperationManifestError("conflict");
  }
  return node;
}

function matchesExpectedCurrent(
  current: NodeOperationManifestRecord | undefined,
  input: ProposeNodeOperationManifestInput,
): boolean {
  if (current === undefined) {
    return input.expectedManifestStateVersion === 0 && input.previousManifestId === null;
  }
  return (
    current.stateVersion === input.expectedManifestStateVersion &&
    current.manifestId === input.previousManifestId &&
    current.manifestId !== input.manifestId &&
    input.occurredAtMs >= current.updatedAtMs
  );
}

function buildPlanningFence(
  task: TaskPlanRecord,
  node: TaskNode,
): NodeOperationManifestPlanningFence {
  if (task.activeGraph === null || task.confirmedPlan === null) {
    throw new NodeOperationManifestError("conflict");
  }
  const nodeDefinition = Object.freeze({
    nodeId: node.nodeId,
    sourcePlanStepId: node.sourcePlanStepId,
    title: node.title,
    description: node.description,
    acceptanceCriteria: node.acceptanceCriteria,
    dependsOnNodeIds: node.dependsOnNodeIds,
  });
  const nodeDigest = digestJson(nodeDefinition as unknown as JsonValue);
  const core = Object.freeze({
    schemaVersion: 1 as const,
    taskId: task.taskId,
    requirementRevisionId: task.activeRequirement.revisionId,
    planRevisionId: task.confirmedPlan.revisionId,
    graphRevisionId: task.activeGraph.revisionId,
    nodeId: node.nodeId,
    nodeDigest,
  });
  return Object.freeze({ ...core, digest: digestJson(core as unknown as JsonValue) });
}

function planningFenceEquals(
  left: NodeOperationManifestPlanningFence,
  right: NodeOperationManifestPlanningFence,
): boolean {
  return (
    canonicalJson(left as unknown as JsonValue) === canonicalJson(right as unknown as JsonValue)
  );
}

function normalizeProposeInput(input: unknown): ProposeNodeOperationManifestInput {
  try {
    if (!validateJsonValue(input).ok) {
      throw new NodeOperationManifestError("invalid_input");
    }
    const record = requireCommandRecord(input, [
      "expectedGraphRevisionId",
      "expectedManifestStateVersion",
      "expectedTaskVersion",
      "manifestId",
      "nodeId",
      "occurredAtMs",
      "operations",
      "previousManifestId",
      "taskId",
    ]);
    const expectedManifestStateVersion = requireNonNegativeInteger(
      record.expectedManifestStateVersion,
    );
    const previousManifestId =
      record.previousManifestId === null ? null : requireUuid(record.previousManifestId);
    const manifestId = requireUuid(record.manifestId);
    if (
      (expectedManifestStateVersion === 0) !== (previousManifestId === null) ||
      expectedManifestStateVersion === Number.MAX_SAFE_INTEGER ||
      manifestId === previousManifestId
    ) {
      throw new NodeOperationManifestError("invalid_input");
    }
    return Object.freeze({
      manifestId,
      taskId: requireUuid(record.taskId),
      nodeId: requireUuid(record.nodeId),
      expectedTaskVersion: requirePositiveInteger(record.expectedTaskVersion),
      expectedGraphRevisionId: requireUuid(record.expectedGraphRevisionId),
      expectedManifestStateVersion,
      previousManifestId,
      occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
      operations: normalizeHarnessRouteOperations(record.operations),
      ...(record.metadata === undefined
        ? {}
        : { metadata: normalizeEventMetadata(record.metadata) }),
    });
  } catch (error: unknown) {
    if (error instanceof NodeOperationManifestError) {
      throw error;
    }
    if (error instanceof HarnessRouteOperationValidationError) {
      throw new NodeOperationManifestError("invalid_input");
    }
    throw new NodeOperationManifestError("invalid_input");
  }
}

function normalizeConfirmInput(input: unknown): ConfirmNodeOperationManifestInput {
  try {
    if (!validateJsonValue(input).ok) {
      throw new NodeOperationManifestError("invalid_input");
    }
    const record = requireCommandRecord(input, [
      "eventId",
      "expectedGraphRevisionId",
      "expectedManifestStateVersion",
      "expectedTaskVersion",
      "manifestId",
      "nodeId",
      "occurredAtMs",
      "taskId",
    ]);
    const eventId = requireUuid(record.eventId);
    const manifestId = requireUuid(record.manifestId);
    const expectedManifestStateVersion = requirePositiveInteger(
      record.expectedManifestStateVersion,
    );
    if (eventId === manifestId || expectedManifestStateVersion === Number.MAX_SAFE_INTEGER) {
      throw new NodeOperationManifestError("invalid_input");
    }
    return Object.freeze({
      eventId,
      taskId: requireUuid(record.taskId),
      nodeId: requireUuid(record.nodeId),
      manifestId,
      expectedTaskVersion: requirePositiveInteger(record.expectedTaskVersion),
      expectedGraphRevisionId: requireUuid(record.expectedGraphRevisionId),
      expectedManifestStateVersion,
      occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
      ...(record.metadata === undefined
        ? {}
        : { metadata: normalizeEventMetadata(record.metadata) }),
    });
  } catch (error: unknown) {
    if (error instanceof NodeOperationManifestError) {
      throw error;
    }
    throw new NodeOperationManifestError("invalid_input");
  }
}

function normalizeEventMetadata(input: unknown): EventMetadata {
  if (
    !validateJsonValue(input).ok ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new NodeOperationManifestError("invalid_input");
  }
  const metadata = input as Record<string, unknown>;
  if (
    Object.keys(metadata).some(
      (key) => !["actor", "causationEventId", "correlationId"].includes(key),
    ) ||
    (metadata.actor !== undefined && !NamespacedTokenSchema.safeParse(metadata.actor).success) ||
    (metadata.causationEventId !== undefined && !isUuid(metadata.causationEventId)) ||
    (metadata.correlationId !== undefined && !RpcIdSchema.safeParse(metadata.correlationId).success)
  ) {
    throw new NodeOperationManifestError("invalid_input");
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

function eventFromManifest(
  eventId: string,
  occurredAtMs: number,
  eventData: ManifestEventData,
  metadata: EventMetadata | undefined,
): Parameters<HarnessEventStore["append"]>[0] {
  return Object.freeze({
    eventId,
    streamType: MANIFEST_STREAM_TYPE,
    streamId: eventData.manifest.taskId,
    eventType: eventData.type === "proposed" ? MANIFEST_PROPOSED : MANIFEST_CONFIRMED,
    eventVersion: 1,
    occurredAtMs,
    payload: requireJsonValue(
      eventData.type === "proposed"
        ? {
            expectedStateVersion: eventData.expectedStateVersion,
            previousManifestId: eventData.previousManifestId,
            manifest: eventData.manifest,
          }
        : {
            expectedStateVersion: eventData.expectedStateVersion,
            manifest: eventData.manifest,
          },
    ),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function decodeManifestEvent(event: StoredEvent): ManifestEventData {
  if (
    event.streamType !== MANIFEST_STREAM_TYPE ||
    event.eventVersion !== 1 ||
    (event.eventType !== MANIFEST_PROPOSED && event.eventType !== MANIFEST_CONFIRMED)
  ) {
    throw new NodeOperationManifestStateError();
  }
  const isProposed = event.eventType === MANIFEST_PROPOSED;
  const payload = requireStateRecord(
    event.payload,
    isProposed
      ? ["expectedStateVersion", "manifest", "previousManifestId"]
      : ["expectedStateVersion", "manifest"],
  );
  const manifest = decodeManifestRecord(payload.manifest);
  const expectedStateVersion = requireStateNonNegativeInteger(payload.expectedStateVersion);
  if (
    manifest.taskId !== event.streamId ||
    manifest.updatedAtMs !== event.occurredAtMs ||
    manifest.stateVersion !== expectedStateVersion + 1
  ) {
    throw new NodeOperationManifestStateError();
  }
  if (isProposed) {
    if (manifest.status !== "candidate") {
      throw new NodeOperationManifestStateError();
    }
    return Object.freeze({
      type: "proposed" as const,
      expectedStateVersion,
      previousManifestId: requireStateNullableUuid(payload.previousManifestId),
      manifest: manifest as NodeOperationManifestRecord & Readonly<{ status: "candidate" }>,
    });
  }
  if (manifest.status !== "confirmed") {
    throw new NodeOperationManifestStateError();
  }
  return Object.freeze({
    type: "confirmed" as const,
    expectedStateVersion,
    manifest: manifest as NodeOperationManifestRecord & Readonly<{ status: "confirmed" }>,
  });
}

function decodeManifestEventForRetry(event: StoredEvent): ManifestEventData {
  try {
    return decodeManifestEvent(event);
  } catch {
    throw new NodeOperationManifestError("conflict");
  }
}

function decodeManifestRecord(input: unknown): NodeOperationManifestRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new NodeOperationManifestStateError();
    }
    const record = requireStateRecord(input, [
      "confirmedAtMs",
      "confirmedAtTaskVersion",
      "manifestId",
      "nodeId",
      "operations",
      "planningFence",
      "proposedAtMs",
      "proposedAtTaskVersion",
      "schemaVersion",
      "stateVersion",
      "status",
      "taskId",
      "updatedAtMs",
    ]);
    const taskId = requireStateUuid(record.taskId);
    const nodeId = requireStateUuid(record.nodeId);
    const planningFence = decodePlanningFence(record.planningFence);
    const proposedAtTaskVersion = requireStatePositiveInteger(record.proposedAtTaskVersion);
    const proposedAtMs = requireStateNonNegativeInteger(record.proposedAtMs);
    const updatedAtMs = requireStateNonNegativeInteger(record.updatedAtMs);
    const confirmedAtMs = requireStateNullableNonNegativeInteger(record.confirmedAtMs);
    const confirmedAtTaskVersion = requireStateNullablePositiveInteger(
      record.confirmedAtTaskVersion,
    );
    if (
      record.schemaVersion !== 1 ||
      (record.status !== "candidate" && record.status !== "confirmed") ||
      taskId !== planningFence.taskId ||
      nodeId !== planningFence.nodeId ||
      proposedAtMs > updatedAtMs ||
      (record.status === "candidate" &&
        (confirmedAtMs !== null ||
          confirmedAtTaskVersion !== null ||
          proposedAtMs !== updatedAtMs)) ||
      (record.status === "confirmed" &&
        (confirmedAtMs === null ||
          confirmedAtTaskVersion === null ||
          confirmedAtTaskVersion < proposedAtTaskVersion ||
          confirmedAtMs !== updatedAtMs ||
          confirmedAtMs < proposedAtMs))
    ) {
      throw new NodeOperationManifestStateError();
    }
    return freezeManifest({
      schemaVersion: 1,
      taskId,
      nodeId,
      manifestId: requireStateUuid(record.manifestId),
      stateVersion: requireStatePositiveInteger(record.stateVersion),
      status: record.status,
      planningFence,
      operations: normalizeHarnessRouteOperations(record.operations),
      proposedAtTaskVersion,
      confirmedAtTaskVersion,
      proposedAtMs,
      confirmedAtMs,
      updatedAtMs,
    });
  } catch (error: unknown) {
    if (error instanceof NodeOperationManifestStateError) {
      throw error;
    }
    throw new NodeOperationManifestStateError();
  }
}

function decodePlanningFence(input: unknown): NodeOperationManifestPlanningFence {
  const record = requireStateRecord(input, [
    "digest",
    "graphRevisionId",
    "nodeDigest",
    "nodeId",
    "planRevisionId",
    "requirementRevisionId",
    "schemaVersion",
    "taskId",
  ]);
  const core = Object.freeze({
    schemaVersion: 1 as const,
    taskId: requireStateUuid(record.taskId),
    requirementRevisionId: requireStateUuid(record.requirementRevisionId),
    planRevisionId: requireStateUuid(record.planRevisionId),
    graphRevisionId: requireStateUuid(record.graphRevisionId),
    nodeId: requireStateUuid(record.nodeId),
    nodeDigest: requireStateSha256(record.nodeDigest),
  });
  const digest = requireStateSha256(record.digest);
  if (record.schemaVersion !== 1 || digest !== digestJson(core as unknown as JsonValue)) {
    throw new NodeOperationManifestStateError();
  }
  return Object.freeze({ ...core, digest });
}

function proposedEventMatchesInput(
  eventData: ProposedEventData,
  event: StoredEvent,
  input: ProposeNodeOperationManifestInput,
): boolean {
  return (
    event.eventId === input.manifestId &&
    event.occurredAtMs === input.occurredAtMs &&
    eventData.expectedStateVersion === input.expectedManifestStateVersion &&
    eventData.previousManifestId === input.previousManifestId &&
    eventData.manifest.taskId === input.taskId &&
    eventData.manifest.nodeId === input.nodeId &&
    eventData.manifest.planningFence.graphRevisionId === input.expectedGraphRevisionId &&
    eventData.manifest.proposedAtTaskVersion === input.expectedTaskVersion &&
    canonicalJson(eventData.manifest.operations as unknown as JsonValue) ===
      canonicalJson(input.operations as unknown as JsonValue)
  );
}

function confirmedEventMatchesInput(
  eventData: ConfirmedEventData,
  event: StoredEvent,
  input: ConfirmNodeOperationManifestInput,
): boolean {
  return (
    event.eventId === input.eventId &&
    event.occurredAtMs === input.occurredAtMs &&
    eventData.expectedStateVersion === input.expectedManifestStateVersion &&
    eventData.manifest.taskId === input.taskId &&
    eventData.manifest.nodeId === input.nodeId &&
    eventData.manifest.manifestId === input.manifestId &&
    eventData.manifest.planningFence.graphRevisionId === input.expectedGraphRevisionId &&
    eventData.manifest.confirmedAtTaskVersion === input.expectedTaskVersion
  );
}

function requireEventType<T extends ManifestEventData["type"]>(
  eventData: ManifestEventData,
  type: T,
): Extract<ManifestEventData, Readonly<{ type: T }>> {
  if (eventData.type !== type) {
    throw new NodeOperationManifestError("conflict");
  }
  return eventData as Extract<ManifestEventData, Readonly<{ type: T }>>;
}

function freezeManifest(input: NodeOperationManifestRecord): NodeOperationManifestRecord {
  return Object.freeze(input);
}

function manifestProjectionKey(taskId: string, nodeId: string): string {
  return `${taskId}/${nodeId}`;
}

function requireCommandRecord(
  input: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new NodeOperationManifestError("invalid_input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([...required, "metadata"]);
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
    throw new NodeOperationManifestError("invalid_input");
  }
  return input as Record<string, unknown>;
}

function requireStateRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new NodeOperationManifestStateError();
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new NodeOperationManifestStateError();
  }
  return input as Record<string, unknown>;
}

function requireJsonValue(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) {
    throw new NodeOperationManifestStateError();
  }
  return input as JsonValue;
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new NodeOperationManifestError("invalid_input");
  }
  return input;
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new NodeOperationManifestError("invalid_input");
  }
  return input as number;
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new NodeOperationManifestError("invalid_input");
  }
  return input as number;
}

function requireStateUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new NodeOperationManifestStateError();
  }
  return input;
}

function requireStatePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new NodeOperationManifestStateError();
  }
  return input as number;
}

function requireStateNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new NodeOperationManifestStateError();
  }
  return input as number;
}

function requireStateNullablePositiveInteger(input: unknown): number | null {
  return input === null ? null : requireStatePositiveInteger(input);
}

function requireStateNullableNonNegativeInteger(input: unknown): number | null {
  return input === null ? null : requireStateNonNegativeInteger(input);
}

function requireStateNullableUuid(input: unknown): string | null {
  return input === null ? null : requireStateUuid(input);
}

function requireStateSha256(input: unknown): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw new NodeOperationManifestStateError();
  }
  return input;
}

function digestJson(input: JsonValue): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function mapRepositoryError(error: unknown): NodeOperationManifestError {
  if (error instanceof NodeOperationManifestError) {
    return error;
  }
  if (error instanceof EventStoreError) {
    if (error.code === "closed") {
      return new NodeOperationManifestError("closed");
    }
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new NodeOperationManifestError("conflict");
    }
    if (error.code === "invalid_event") {
      return new NodeOperationManifestError("invalid_input");
    }
  }
  if (error instanceof TaskPlanError) {
    if (error.code === "closed") {
      return new NodeOperationManifestError("closed");
    }
    if (error.code === "not_found" || error.code === "conflict") {
      return new NodeOperationManifestError("conflict");
    }
    if (error.code === "invalid_input") {
      return new NodeOperationManifestError("invalid_input");
    }
  }
  return new NodeOperationManifestError("storage_failure");
}

if (
  !NamespacedTokenSchema.safeParse(MANIFEST_STREAM_TYPE).success ||
  !NamespacedTokenSchema.safeParse(MANIFEST_PROPOSED).success ||
  !NamespacedTokenSchema.safeParse(MANIFEST_CONFIRMED).success ||
  !NamespacedTokenSchema.safeParse(MANIFEST_PROJECTION_NAME).success
) {
  throw new Error("The node operation manifest event names are invalid.");
}
