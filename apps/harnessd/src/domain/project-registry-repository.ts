import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

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

const PROJECT_STREAM_TYPE = "project.registry";
const PROJECT_REGISTERED = "project.registered";
const PROJECT_PROJECTION_NAME = "project.current";
const WORKSPACE_OWNER_PROJECTION_NAME = "project.workspace_owner";
const PROJECTION_PROBE_KEY = "00000000-0000-4000-8000-000000000000";
const WORKSPACE_PROBE_KEY = `workspace/${"0".repeat(64)}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Z]:\\/;
const WINDOWS_UNC_PATTERN = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/;
const MAX_DISPLAY_NAME_BYTES = 256;
const MAX_ABSOLUTE_PATH_BYTES = 4_096;

export type ProjectPlatform = "macos" | "windows" | "linux";

export type ProjectWorkspace = Readonly<{
  platform: ProjectPlatform;
  absolutePath: string;
  identityStatus: "unverified";
}>;

export type ProjectRecord = Readonly<{
  schemaVersion: 1;
  projectId: string;
  projectVersion: 1;
  displayName: string;
  workspace: ProjectWorkspace;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type RegisterProjectInput = Readonly<{
  eventId: string;
  projectId: string;
  displayName: string;
  workspace: Readonly<{
    platform: ProjectPlatform;
    absolutePath: string;
  }>;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type ProjectRegistryCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  project: ProjectRecord;
}>;

export type ProjectRegistryErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

const ERROR_MESSAGES: Readonly<Record<ProjectRegistryErrorCode, string>> = Object.freeze({
  closed: "The project registry repository is closed.",
  conflict: "The project registry command conflicts with current state.",
  invalid_input: "The project registry input is invalid.",
  not_found: "The project does not exist.",
  storage_failure: "The project registry operation failed.",
});

export class ProjectRegistryError extends Error {
  readonly code: ProjectRegistryErrorCode;

  constructor(code: ProjectRegistryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProjectRegistryError";
    this.code = code;
  }
}

class ProjectRegistryStateError extends Error {}

type ProjectEventData = Readonly<{ project: ProjectRecord }>;

type WorkspaceOwnerRecord = Readonly<{
  schemaVersion: 1;
  projectId: string;
  workspace: ProjectWorkspace;
}>;

export const PROJECT_REGISTRY_PROJECTION: ProjectionDefinition = Object.freeze({
  name: PROJECT_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) =>
    event.streamType === PROJECT_STREAM_TYPE &&
    event.eventType === PROJECT_REGISTERED &&
    UUID_PATTERN.test(event.streamId)
      ? [event.streamId]
      : [],
  reduce: ({ current, event }) => {
    if (current !== undefined) {
      throw new ProjectRegistryStateError();
    }
    return { type: "set", state: requireJsonValue(decodeProjectEvent(event).project) };
  },
});

export const PROJECT_WORKSPACE_OWNER_PROJECTION: ProjectionDefinition = Object.freeze({
  name: WORKSPACE_OWNER_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) => {
    if (
      event.streamType !== PROJECT_STREAM_TYPE ||
      event.eventType !== PROJECT_REGISTERED ||
      !UUID_PATTERN.test(event.streamId)
    ) {
      return [];
    }
    return [workspaceProjectionKey(decodeProjectEvent(event).project.workspace)];
  },
  reduce: ({ current, event }) => {
    if (current !== undefined) {
      throw new ProjectRegistryStateError();
    }
    const project = decodeProjectEvent(event).project;
    return {
      type: "set",
      state: requireJsonValue(
        freezeWorkspaceOwner({
          schemaVersion: 1,
          projectId: project.projectId,
          workspace: project.workspace,
        }),
      ),
    };
  },
});

export class ProjectRegistryRepository {
  readonly #events: HarnessEventStore;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(PROJECT_PROJECTION_NAME, PROJECTION_PROBE_KEY);
      events.readProjectionState(WORKSPACE_OWNER_PROJECTION_NAME, WORKSPACE_PROBE_KEY);
      this.#events = events;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  registerProject(input: RegisterProjectInput): ProjectRegistryCommandResult {
    const normalized = normalizeRegisterInput(input);
    try {
      const existingEvent = this.#events.readByEventId(normalized.eventId);
      if (existingEvent !== undefined) {
        return this.#retryExisting(normalized, existingEvent);
      }
      if (
        this.#readOptionalProject(normalized.projectId) !== undefined ||
        this.#readOptionalWorkspaceOwner(normalized.workspace) !== undefined
      ) {
        throw new ProjectRegistryError("conflict");
      }

      const project = freezeProject({
        schemaVersion: 1,
        projectId: normalized.projectId,
        projectVersion: 1,
        displayName: normalized.displayName,
        workspace: freezeWorkspace({
          platform: normalized.workspace.platform,
          absolutePath: normalized.workspace.absolutePath,
          identityStatus: "unverified",
        }),
        createdAtMs: normalized.occurredAtMs,
        updatedAtMs: normalized.occurredAtMs,
      });
      const eventData = Object.freeze({ project });
      const appended = this.#events.append(
        eventFromProject(
          normalized.eventId,
          normalized.occurredAtMs,
          eventData,
          normalized.metadata,
        ),
      );
      return Object.freeze({ duplicate: appended.duplicate, event: appended.event, project });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readProject(projectId: string): ProjectRecord {
    if (!isUuid(projectId)) {
      throw new ProjectRegistryError("invalid_input");
    }
    try {
      const project = this.#readOptionalProject(projectId);
      if (project === undefined) {
        throw new ProjectRegistryError("not_found");
      }
      return project;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readProjectByWorkspace(
    workspace: Readonly<{ platform: ProjectPlatform; absolutePath: string }>,
  ): ProjectRecord {
    const normalized = normalizeWorkspace(workspace);
    try {
      const owner = this.#readOptionalWorkspaceOwner(normalized);
      if (owner === undefined) {
        throw new ProjectRegistryError("not_found");
      }
      const project = this.#readOptionalProject(owner.projectId);
      if (project === undefined || !workspaceEquals(project.workspace, owner.workspace)) {
        throw new ProjectRegistryStateError();
      }
      return project;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  listProjects(afterProjectId = "", limit = 100): readonly ProjectRecord[] {
    if (
      (afterProjectId !== "" && !isUuid(afterProjectId)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new ProjectRegistryError("invalid_input");
    }
    try {
      return Object.freeze(
        this.#events
          .listProjectionStates(PROJECT_PROJECTION_NAME, afterProjectId, limit)
          .map((projected) => decodeProjectRecord(projected.state)),
      );
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  #readOptionalProject(projectId: string): ProjectRecord | undefined {
    const projected = this.#events.readProjectionState(PROJECT_PROJECTION_NAME, projectId);
    return projected === undefined ? undefined : decodeProjectRecord(projected.state);
  }

  #readOptionalWorkspaceOwner(workspace: ProjectWorkspaceInput): WorkspaceOwnerRecord | undefined {
    const projected = this.#events.readProjectionState(
      WORKSPACE_OWNER_PROJECTION_NAME,
      workspaceProjectionKey(workspace),
    );
    return projected === undefined ? undefined : decodeWorkspaceOwner(projected.state);
  }

  #retryExisting(
    input: NormalizedRegisterProjectInput,
    event: StoredEvent,
  ): ProjectRegistryCommandResult {
    let eventData: ProjectEventData;
    try {
      eventData = decodeProjectEvent(event);
    } catch {
      throw new ProjectRegistryError("conflict");
    }
    if (!eventDataMatchesInput(eventData, event, input)) {
      throw new ProjectRegistryError("conflict");
    }
    const appended = this.#events.append(
      eventFromProject(event.eventId, event.occurredAtMs, eventData, input.metadata),
    );
    if (!appended.duplicate) {
      throw new ProjectRegistryError("conflict");
    }
    return Object.freeze({
      duplicate: true,
      event: appended.event,
      project: eventData.project,
    });
  }
}

type ProjectWorkspaceInput = Readonly<{
  platform: ProjectPlatform;
  absolutePath: string;
}>;

type NormalizedRegisterProjectInput = Readonly<{
  eventId: string;
  projectId: string;
  displayName: string;
  workspace: ProjectWorkspaceInput;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

function normalizeRegisterInput(input: unknown): NormalizedRegisterProjectInput {
  try {
    const record = requireCommandRecord(input, [
      "displayName",
      "eventId",
      "occurredAtMs",
      "projectId",
      "workspace",
    ]);
    const normalized = Object.freeze({
      eventId: requireUuid(record.eventId),
      projectId: requireUuid(record.projectId),
      displayName: requireDisplayName(record.displayName),
      workspace: normalizeWorkspace(record.workspace),
      occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
      ...(record.metadata === undefined
        ? {}
        : { metadata: normalizeEventMetadata(record.metadata) }),
    });
    if (!validateJsonValue(normalized).ok) {
      throw new ProjectRegistryError("invalid_input");
    }
    return normalized;
  } catch (error: unknown) {
    if (error instanceof ProjectRegistryError) {
      throw error;
    }
    throw new ProjectRegistryError("invalid_input");
  }
}

function normalizeWorkspace(input: unknown): ProjectWorkspaceInput {
  const record = requireExactDataRecord(input, ["absolutePath", "platform"]);
  const platform = record.platform;
  if (platform !== "macos" && platform !== "windows" && platform !== "linux") {
    throw new ProjectRegistryError("invalid_input");
  }
  if (
    typeof record.absolutePath !== "string" ||
    record.absolutePath.includes("\0") ||
    Buffer.byteLength(record.absolutePath, "utf8") < 1 ||
    Buffer.byteLength(record.absolutePath, "utf8") > MAX_ABSOLUTE_PATH_BYTES
  ) {
    throw new ProjectRegistryError("invalid_input");
  }
  const absolutePath = record.absolutePath;
  if (platform === "windows") {
    const normalizedPath = win32.normalize(absolutePath);
    const rootPath = win32.parse(absolutePath).root;
    if (
      absolutePath.includes("/") ||
      absolutePath.startsWith("\\\\?\\") ||
      absolutePath.startsWith("\\\\.\\") ||
      (!WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(absolutePath) &&
        !WINDOWS_UNC_PATTERN.test(absolutePath)) ||
      !win32.isAbsolute(absolutePath) ||
      (absolutePath.endsWith("\\") && absolutePath !== rootPath) ||
      normalizedPath !== absolutePath
    ) {
      throw new ProjectRegistryError("invalid_input");
    }
  } else if (
    !posix.isAbsolute(absolutePath) ||
    (absolutePath.length > 1 && absolutePath.endsWith("/")) ||
    posix.normalize(absolutePath) !== absolutePath
  ) {
    throw new ProjectRegistryError("invalid_input");
  }
  return Object.freeze({ platform, absolutePath });
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
    throw new ProjectRegistryError("invalid_input");
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

function eventFromProject(
  eventId: string,
  occurredAtMs: number,
  eventData: ProjectEventData,
  metadata: EventMetadata | undefined,
): Parameters<HarnessEventStore["append"]>[0] {
  return Object.freeze({
    eventId,
    streamType: PROJECT_STREAM_TYPE,
    streamId: eventData.project.projectId,
    eventType: PROJECT_REGISTERED,
    eventVersion: 1,
    occurredAtMs,
    payload: requireJsonValue(eventData),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function decodeProjectEvent(event: StoredEvent): ProjectEventData {
  if (
    event.streamType !== PROJECT_STREAM_TYPE ||
    event.eventType !== PROJECT_REGISTERED ||
    event.eventVersion !== 1
  ) {
    throw new ProjectRegistryStateError();
  }
  const payload = requireStateRecord(event.payload, ["project"]);
  const project = decodeProjectRecord(payload.project);
  if (
    project.projectId !== event.streamId ||
    project.createdAtMs !== event.occurredAtMs ||
    project.updatedAtMs !== event.occurredAtMs
  ) {
    throw new ProjectRegistryStateError();
  }
  return Object.freeze({ project });
}

function decodeProjectRecord(input: unknown): ProjectRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ProjectRegistryStateError();
    }
    const record = requireStateRecord(input, [
      "createdAtMs",
      "displayName",
      "projectId",
      "projectVersion",
      "schemaVersion",
      "updatedAtMs",
      "workspace",
    ]);
    const createdAtMs = requireStateNonNegativeInteger(record.createdAtMs);
    const updatedAtMs = requireStateNonNegativeInteger(record.updatedAtMs);
    if (record.schemaVersion !== 1 || record.projectVersion !== 1 || createdAtMs !== updatedAtMs) {
      throw new ProjectRegistryStateError();
    }
    const workspaceRecord = requireStateRecord(record.workspace, [
      "absolutePath",
      "identityStatus",
      "platform",
    ]);
    if (workspaceRecord.identityStatus !== "unverified") {
      throw new ProjectRegistryStateError();
    }
    const workspace = normalizeWorkspace({
      platform: workspaceRecord.platform,
      absolutePath: workspaceRecord.absolutePath,
    });
    return freezeProject({
      schemaVersion: 1,
      projectId: requireStateUuid(record.projectId),
      projectVersion: 1,
      displayName: requireStateDisplayName(record.displayName),
      workspace: freezeWorkspace({ ...workspace, identityStatus: "unverified" }),
      createdAtMs,
      updatedAtMs,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectRegistryStateError) {
      throw error;
    }
    throw new ProjectRegistryStateError();
  }
}

function decodeWorkspaceOwner(input: unknown): WorkspaceOwnerRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ProjectRegistryStateError();
    }
    const record = requireStateRecord(input, ["projectId", "schemaVersion", "workspace"]);
    if (record.schemaVersion !== 1) {
      throw new ProjectRegistryStateError();
    }
    const workspaceRecord = requireStateRecord(record.workspace, [
      "absolutePath",
      "identityStatus",
      "platform",
    ]);
    if (workspaceRecord.identityStatus !== "unverified") {
      throw new ProjectRegistryStateError();
    }
    const workspace = normalizeWorkspace({
      platform: workspaceRecord.platform,
      absolutePath: workspaceRecord.absolutePath,
    });
    return freezeWorkspaceOwner({
      schemaVersion: 1,
      projectId: requireStateUuid(record.projectId),
      workspace: freezeWorkspace({ ...workspace, identityStatus: "unverified" }),
    });
  } catch (error: unknown) {
    if (error instanceof ProjectRegistryStateError) {
      throw error;
    }
    throw new ProjectRegistryStateError();
  }
}

function eventDataMatchesInput(
  eventData: ProjectEventData,
  event: StoredEvent,
  input: NormalizedRegisterProjectInput,
): boolean {
  return (
    event.eventId === input.eventId &&
    event.occurredAtMs === input.occurredAtMs &&
    eventData.project.projectId === input.projectId &&
    eventData.project.displayName === input.displayName &&
    workspaceEquals(eventData.project.workspace, input.workspace)
  );
}

function workspaceProjectionKey(workspace: ProjectWorkspaceInput): string {
  const digest = createHash("sha256")
    .update(workspace.platform)
    .update("\0")
    .update(workspace.absolutePath)
    .digest("hex");
  return `workspace/${digest}`;
}

function workspaceEquals(
  left: Pick<ProjectWorkspace, "platform" | "absolutePath">,
  right: Pick<ProjectWorkspace, "platform" | "absolutePath">,
): boolean {
  return left.platform === right.platform && left.absolutePath === right.absolutePath;
}

function freezeProject(input: ProjectRecord): ProjectRecord {
  return Object.freeze(input);
}

function freezeWorkspace(input: ProjectWorkspace): ProjectWorkspace {
  return Object.freeze(input);
}

function freezeWorkspaceOwner(input: WorkspaceOwnerRecord): WorkspaceOwnerRecord {
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
    throw new ProjectRegistryError("invalid_input");
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
    throw new ProjectRegistryError("invalid_input");
  }
  return input as Record<string, unknown>;
}

function requireStateRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProjectRegistryStateError();
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ProjectRegistryStateError();
  }
  return input as Record<string, unknown>;
}

function requireJsonValue(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) {
    throw new ProjectRegistryStateError();
  }
  return input as JsonValue;
}

function requireDisplayName(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_DISPLAY_NAME_BYTES ||
    input.trim() !== input ||
    Buffer.byteLength(input, "utf8") > MAX_DISPLAY_NAME_BYTES
  ) {
    throw new ProjectRegistryError("invalid_input");
  }
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      throw new ProjectRegistryError("invalid_input");
    }
  }
  return input;
}

function requireStateDisplayName(input: unknown): string {
  try {
    return requireDisplayName(input);
  } catch {
    throw new ProjectRegistryStateError();
  }
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ProjectRegistryError("invalid_input");
  }
  return input;
}

function requireStateUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ProjectRegistryStateError();
  }
  return input;
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ProjectRegistryError("invalid_input");
  }
  return input as number;
}

function requireStateNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ProjectRegistryStateError();
  }
  return input as number;
}

function mapRepositoryError(error: unknown): ProjectRegistryError {
  if (error instanceof ProjectRegistryError) {
    return error;
  }
  if (error instanceof EventStoreError) {
    if (error.code === "closed") {
      return new ProjectRegistryError("closed");
    }
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new ProjectRegistryError("conflict");
    }
    if (error.code === "invalid_event") {
      return new ProjectRegistryError("invalid_input");
    }
  }
  return new ProjectRegistryError("storage_failure");
}

if (
  !NamespacedTokenSchema.safeParse(PROJECT_STREAM_TYPE).success ||
  !NamespacedTokenSchema.safeParse(PROJECT_REGISTERED).success ||
  !NamespacedTokenSchema.safeParse(PROJECT_PROJECTION_NAME).success ||
  !NamespacedTokenSchema.safeParse(WORKSPACE_OWNER_PROJECTION_NAME).success
) {
  throw new Error("The project registry event names are invalid.");
}
