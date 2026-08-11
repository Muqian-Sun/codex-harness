import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  EXECUTION_ADMISSION_REJECTION_REASONS,
  NamespacedTokenSchema,
  TASK_OPERATION_KINDS,
  validateJsonValue,
  type HarnessExecutionAdmissionRejectionReason,
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
  decodeShadowModelRouteDecision,
  type ShadowModelRouteDecision,
} from "./model-route-classifier.js";
import type { NodeExecutionPermissionEnvelope } from "./node-execution-admission.js";
import type { VerifiedMacosWorkspaceSnapshot } from "../runtime/macos-workspace-admission-observer.js";

const STREAM_TYPE = "execution.node_admission";
const EVENT_TYPE = "execution.node_admission_decided";
const PROJECTION_NAME = "execution.node_admissions";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROBE_ID = "id/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000";

export type RouteActivation = Readonly<{
  schemaVersion: 1;
  executionAuthorized: true;
  activationId: string;
  decisionId: string;
  projectId: string;
  projectVersion: number;
  taskId: string;
  taskVersion: number;
  ownershipVersion: number;
  nodeId: string;
  requirementRevisionId: string;
  planRevisionId: string;
  graphRevisionId: string;
  manifestId: string;
  manifestStateVersion: number;
  routingBindingVersion: number;
  profileId: string;
  profileVersion: number;
  configurationRevisionId: string;
  catalog: Readonly<{
    snapshotId: string;
    workerSessionId: string;
    provider: string;
    observedAtMs: number;
  }>;
  routeDecision: ShadowModelRouteDecision;
  permission: NodeExecutionPermissionEnvelope;
  workspace: VerifiedMacosWorkspaceSnapshot;
  userConfirmedAtMs: number;
}>;

export type NodeExecutionAdmissionRecord = Readonly<{
  schemaVersion: 1;
  activationId: string;
  decisionId: string;
  commandDigest: string;
  projectId: string;
  taskId: string;
  nodeId: string;
  manifestId: string;
  occurredAtMs: number;
  status: "activated" | "denied";
  rejectionReason: HarnessExecutionAdmissionRejectionReason | null;
  routeActivation: RouteActivation | null;
}>;

export type RouteActivationCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  record: NodeExecutionAdmissionRecord;
}>;

export type RouteActivationRepositoryErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

export class RouteActivationRepositoryError extends Error {
  readonly code: RouteActivationRepositoryErrorCode;

  constructor(code: RouteActivationRepositoryErrorCode) {
    super(`The route activation repository failed: ${code}.`);
    this.name = "RouteActivationRepositoryError";
    this.code = code;
  }
}

class RouteActivationStateError extends Error {}

export const ROUTE_ACTIVATION_PROJECTION: ProjectionDefinition = Object.freeze({
  name: PROJECTION_NAME,
  version: 1,
  selectKeys: (event) => {
    if (
      event.streamType !== STREAM_TYPE ||
      event.eventType !== EVENT_TYPE ||
      !isUuid(event.streamId) ||
      !isUuid(event.eventId)
    ) {
      return [];
    }
    const record = decodeEvent(event);
    return [idKey(record.taskId, record.activationId), nodeKey(record.taskId, record.nodeId)];
  },
  reduce: ({ key, current, event }) => {
    const next = decodeEvent(event);
    if (key.startsWith("id/")) {
      if (current !== undefined) throw new RouteActivationStateError();
      return { type: "set", state: requireJson(next) };
    }
    if (current !== undefined) {
      const previous = decodeRecord(current);
      if (
        previous.occurredAtMs > next.occurredAtMs ||
        (previous.status === "activated" && previous.activationId !== next.activationId)
      ) {
        throw new RouteActivationStateError();
      }
    }
    return { type: "set", state: requireJson(next) };
  },
});

export class RouteActivationRepository {
  readonly #events: HarnessEventStore;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(PROJECTION_NAME, PROBE_ID);
      this.#events = events;
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  record(
    rawRecord: NodeExecutionAdmissionRecord,
    metadata?: EventMetadata,
  ): RouteActivationCommandResult {
    let record: NodeExecutionAdmissionRecord;
    try {
      record = decodeRecord(rawRecord);
    } catch {
      throw new RouteActivationRepositoryError("invalid_input");
    }
    try {
      const existing = this.#events.readByEventId(record.activationId);
      if (existing !== undefined) {
        const persisted = decodeEvent(existing);
        if (!sameCommand(persisted, record)) throw new RouteActivationRepositoryError("conflict");
        const appended = this.#events.append(eventFromRecord(persisted, metadata));
        if (!appended.duplicate) throw new RouteActivationRepositoryError("conflict");
        return Object.freeze({ duplicate: true, event: appended.event, record: persisted });
      }
      const latest = this.#readOptionalLatest(record.taskId, record.nodeId);
      if (latest?.status === "activated") throw new RouteActivationRepositoryError("conflict");
      const appended = this.#events.append(eventFromRecord(record, metadata));
      return Object.freeze({ duplicate: appended.duplicate, event: appended.event, record });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  readAdmission(taskId: string, activationId: string): NodeExecutionAdmissionRecord {
    if (!isUuid(taskId) || !isUuid(activationId)) {
      throw new RouteActivationRepositoryError("invalid_input");
    }
    try {
      const projected = this.#events.readProjectionState(
        PROJECTION_NAME,
        idKey(taskId, activationId),
      );
      if (projected === undefined) throw new RouteActivationRepositoryError("not_found");
      return decodeRecord(projected.state);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  readLatestForNode(taskId: string, nodeId: string): NodeExecutionAdmissionRecord {
    if (!isUuid(taskId) || !isUuid(nodeId)) {
      throw new RouteActivationRepositoryError("invalid_input");
    }
    try {
      const record = this.#readOptionalLatest(taskId, nodeId);
      if (record === undefined) throw new RouteActivationRepositoryError("not_found");
      return record;
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  #readOptionalLatest(taskId: string, nodeId: string): NodeExecutionAdmissionRecord | undefined {
    const projected = this.#events.readProjectionState(PROJECTION_NAME, nodeKey(taskId, nodeId));
    return projected === undefined ? undefined : decodeRecord(projected.state);
  }
}

function eventFromRecord(
  record: NodeExecutionAdmissionRecord,
  metadata: EventMetadata | undefined,
): Parameters<HarnessEventStore["append"]>[0] {
  return Object.freeze({
    eventId: record.activationId,
    streamType: STREAM_TYPE,
    streamId: record.taskId,
    eventType: EVENT_TYPE,
    eventVersion: 1,
    occurredAtMs: record.occurredAtMs,
    payload: requireJson(record),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function decodeEvent(event: StoredEvent): NodeExecutionAdmissionRecord {
  if (
    event.streamType !== STREAM_TYPE ||
    event.eventType !== EVENT_TYPE ||
    event.eventVersion !== 1
  ) {
    throw new RouteActivationStateError();
  }
  const record = decodeRecord(event.payload);
  if (
    record.activationId !== event.eventId ||
    record.taskId !== event.streamId ||
    record.occurredAtMs !== event.occurredAtMs
  ) {
    throw new RouteActivationStateError();
  }
  return record;
}

function decodeRecord(input: unknown): NodeExecutionAdmissionRecord {
  try {
    const record = exactRecord(input, [
      "activationId",
      "commandDigest",
      "decisionId",
      "manifestId",
      "nodeId",
      "occurredAtMs",
      "projectId",
      "rejectionReason",
      "routeActivation",
      "schemaVersion",
      "status",
      "taskId",
    ]);
    const status =
      record.status === "activated" || record.status === "denied" ? record.status : fail();
    const rejectionReason =
      record.rejectionReason === null
        ? null
        : typeof record.rejectionReason === "string" &&
            EXECUTION_ADMISSION_REJECTION_REASONS.includes(
              record.rejectionReason as HarnessExecutionAdmissionRejectionReason,
            )
          ? (record.rejectionReason as HarnessExecutionAdmissionRejectionReason)
          : fail();
    const routeActivation =
      record.routeActivation === null ? null : decodeRouteActivation(record.routeActivation);
    if (
      record.schemaVersion !== 1 ||
      (status === "activated") !== (rejectionReason === null && routeActivation !== null)
    ) {
      fail();
    }
    const normalized = Object.freeze({
      schemaVersion: 1 as const,
      activationId: uuid(record.activationId),
      decisionId: uuid(record.decisionId),
      commandDigest: requireSha256(record.commandDigest),
      projectId: uuid(record.projectId),
      taskId: uuid(record.taskId),
      nodeId: uuid(record.nodeId),
      manifestId: uuid(record.manifestId),
      occurredAtMs: nonNegative(record.occurredAtMs),
      status,
      rejectionReason,
      routeActivation,
    });
    if (
      routeActivation !== null &&
      (routeActivation.activationId !== normalized.activationId ||
        routeActivation.decisionId !== normalized.decisionId ||
        routeActivation.projectId !== normalized.projectId ||
        routeActivation.taskId !== normalized.taskId ||
        routeActivation.nodeId !== normalized.nodeId ||
        routeActivation.manifestId !== normalized.manifestId)
    ) {
      fail();
    }
    return normalized;
  } catch (error: unknown) {
    if (error instanceof RouteActivationStateError) throw error;
    throw new RouteActivationStateError();
  }
}

function decodeRouteActivation(input: unknown): RouteActivation {
  const record = exactRecord(input, [
    "activationId",
    "catalog",
    "configurationRevisionId",
    "decisionId",
    "executionAuthorized",
    "graphRevisionId",
    "manifestId",
    "manifestStateVersion",
    "nodeId",
    "ownershipVersion",
    "permission",
    "planRevisionId",
    "profileId",
    "profileVersion",
    "projectId",
    "projectVersion",
    "requirementRevisionId",
    "routeDecision",
    "routingBindingVersion",
    "schemaVersion",
    "taskId",
    "taskVersion",
    "userConfirmedAtMs",
    "workspace",
  ]);
  if (record.schemaVersion !== 1 || record.executionAuthorized !== true) fail();
  const catalog = exactRecord(record.catalog, [
    "observedAtMs",
    "provider",
    "snapshotId",
    "workerSessionId",
  ]);
  const decision = decodeShadowModelRouteDecision(record.routeDecision);
  const permission = decodePermission(record.permission);
  const workspace = decodeWorkspace(record.workspace);
  const configurationRevisionId = uuid(record.configurationRevisionId);
  const profileVersion = positive(record.profileVersion);
  const normalizedCatalog = Object.freeze({
    snapshotId: uuid(catalog.snapshotId),
    workerSessionId: uuid(catalog.workerSessionId),
    provider: text(catalog.provider),
    observedAtMs: nonNegative(catalog.observedAtMs),
  });
  const userConfirmedAtMs = nonNegative(record.userConfirmedAtMs);
  if (
    decision.resolvedTarget.configurationRevisionId !== configurationRevisionId ||
    decision.resolvedTarget.configurationRevisionNumber !== profileVersion ||
    decision.resolvedTarget.provider !== normalizedCatalog.provider ||
    normalizedCatalog.observedAtMs > userConfirmedAtMs ||
    workspace.observedAtMs > userConfirmedAtMs
  ) {
    fail();
  }
  return Object.freeze({
    schemaVersion: 1,
    executionAuthorized: true,
    activationId: uuid(record.activationId),
    decisionId: uuid(record.decisionId),
    projectId: uuid(record.projectId),
    projectVersion: positive(record.projectVersion),
    taskId: uuid(record.taskId),
    taskVersion: positive(record.taskVersion),
    ownershipVersion: positive(record.ownershipVersion),
    nodeId: uuid(record.nodeId),
    requirementRevisionId: uuid(record.requirementRevisionId),
    planRevisionId: uuid(record.planRevisionId),
    graphRevisionId: uuid(record.graphRevisionId),
    manifestId: uuid(record.manifestId),
    manifestStateVersion: positive(record.manifestStateVersion),
    routingBindingVersion: positive(record.routingBindingVersion),
    profileId: uuid(record.profileId),
    profileVersion,
    configurationRevisionId,
    catalog: normalizedCatalog,
    routeDecision: decision,
    permission,
    workspace,
    userConfirmedAtMs,
  });
}

function decodePermission(input: unknown): NodeExecutionPermissionEnvelope {
  const record = exactRecord(input, [
    "allowedOperationKinds",
    "commandExecution",
    "networkAccess",
    "policyVersion",
    "schemaVersion",
    "workspaceMode",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.policyVersion !== "node-execution-permission-policy-v1" ||
    (record.workspaceMode !== "read_only" && record.workspaceMode !== "workspace_write") ||
    typeof record.commandExecution !== "boolean" ||
    record.networkAccess !== false ||
    !Array.isArray(record.allowedOperationKinds)
  ) {
    fail();
  }
  const allowedOperationKinds = record.allowedOperationKinds.map((kind) => {
    const normalized = text(kind);
    if (!TASK_OPERATION_KINDS.includes(normalized as (typeof TASK_OPERATION_KINDS)[number])) {
      fail();
    }
    return normalized as (typeof TASK_OPERATION_KINDS)[number];
  });
  if (
    allowedOperationKinds.length < 1 ||
    allowedOperationKinds.length > 256 ||
    new Set(allowedOperationKinds).size !== allowedOperationKinds.length
  ) {
    fail();
  }
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: "node-execution-permission-policy-v1",
    workspaceMode: record.workspaceMode,
    commandExecution: record.commandExecution,
    networkAccess: false,
    allowedOperationKinds: Object.freeze(allowedOperationKinds),
  });
}

function decodeWorkspace(input: unknown): VerifiedMacosWorkspaceSnapshot {
  const record = exactRecord(input, [
    "canonicalPath",
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
    record.schemaVersion !== 1 ||
    record.policyVersion !== "macos-workspace-admission-policy-v1" ||
    record.platform !== "macos" ||
    typeof record.gitHead !== "string" ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(record.gitHead)
  ) {
    fail();
  }
  const canonicalPath = text(record.canonicalPath);
  const deviceId = decimalIdentifier(record.deviceId);
  const inode = decimalIdentifier(record.inode);
  const gitHead = record.gitHead;
  const statusDigest = requireSha256(record.statusDigest);
  const workspaceDigest = requireSha256(record.workspaceDigest);
  if (
    !isAbsolute(canonicalPath) ||
    canonicalPath.includes("\0") ||
    statusDigest !== digest("") ||
    workspaceDigest !==
      digest(JSON.stringify({ canonicalPath, deviceId, gitHead, inode, statusDigest }))
  ) {
    fail();
  }
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: "macos-workspace-admission-policy-v1",
    platform: "macos",
    canonicalPath,
    deviceId,
    inode,
    gitHead,
    statusDigest,
    workspaceDigest,
    observedAtMs: nonNegative(record.observedAtMs),
  });
}

function sameCommand(
  left: NodeExecutionAdmissionRecord,
  right: NodeExecutionAdmissionRecord,
): boolean {
  return (
    left.commandDigest === right.commandDigest &&
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.nodeId === right.nodeId &&
    left.manifestId === right.manifestId &&
    left.decisionId === right.decisionId
  );
}

function exactRecord(input: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (
    !validateJsonValue(input).ok ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  )
    fail();
  const keys = Object.keys(input).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    fail();
  return input as Record<string, unknown>;
}

function uuid(input: unknown): string {
  if (!isUuid(input)) fail();
  return input;
}
function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}
function requireSha256(input: unknown): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) fail();
  return input;
}
function decimalIdentifier(input: unknown): string {
  const value = text(input);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail();
  return value;
}
function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
function text(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) fail();
  return input;
}
function positive(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) fail();
  return input as number;
}
function nonNegative(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) fail();
  return input as number;
}
function fail(): never {
  throw new RouteActivationStateError();
}
function requireJson(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) fail();
  return input as JsonValue;
}
function idKey(taskId: string, activationId: string): string {
  return `id/${taskId}/${activationId}`;
}
function nodeKey(taskId: string, nodeId: string): string {
  return `node/${taskId}/${nodeId}`;
}

function mapError(error: unknown): RouteActivationRepositoryError {
  if (error instanceof RouteActivationRepositoryError) return error;
  if (error instanceof EventStoreError) {
    if (error.code === "closed") return new RouteActivationRepositoryError("closed");
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new RouteActivationRepositoryError("conflict");
    }
    if (error.code === "invalid_event") return new RouteActivationRepositoryError("invalid_input");
  }
  if (error instanceof RouteActivationStateError) {
    return new RouteActivationRepositoryError("conflict");
  }
  return new RouteActivationRepositoryError("storage_failure");
}

if (
  !NamespacedTokenSchema.safeParse(STREAM_TYPE).success ||
  !NamespacedTokenSchema.safeParse(EVENT_TYPE).success ||
  !NamespacedTokenSchema.safeParse(PROJECTION_NAME).success
) {
  throw new Error("The route activation event names are invalid.");
}
