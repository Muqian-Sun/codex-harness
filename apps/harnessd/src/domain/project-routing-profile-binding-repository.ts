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
  ModelRoutingProfileError,
  ModelRoutingProfileRepository,
} from "./model-routing-profile-repository.js";

const BINDING_STREAM_TYPE = "project.model_routing";
const BINDING_EVENT_TYPE = "project.model_routing_profile_bound";
const BINDING_PROJECTION_NAME = "project.current_model_routing_profile";
const PROJECTION_PROBE_KEY = "00000000-0000-4000-8000-000000000000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ProjectRoutingProfileBindingRecord = Readonly<{
  schemaVersion: 1;
  projectId: string;
  bindingVersion: number;
  profileId: string;
  profileVersionAtBinding: number;
  configurationRevisionIdAtBinding: string;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type BindProjectRoutingProfileInput = Readonly<{
  eventId: string;
  projectId: string;
  expectedBindingVersion: number;
  previousProfileId: string | null;
  profileId: string;
  expectedProfileVersion: number;
  expectedConfigurationRevisionId: string;
  occurredAtMs: number;
  metadata?: EventMetadata;
}>;

export type ProjectRoutingProfileBindingCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  binding: ProjectRoutingProfileBindingRecord;
}>;

export type ProjectRoutingProfileBindingErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

const ERROR_MESSAGES: Readonly<Record<ProjectRoutingProfileBindingErrorCode, string>> =
  Object.freeze({
    closed: "The project routing profile binding repository is closed.",
    conflict: "The project routing profile binding command conflicts with current state.",
    invalid_input: "The project routing profile binding input is invalid.",
    not_found: "The project routing profile binding does not exist.",
    storage_failure: "The project routing profile binding repository operation failed.",
  });

export class ProjectRoutingProfileBindingError extends Error {
  readonly code: ProjectRoutingProfileBindingErrorCode;

  constructor(code: ProjectRoutingProfileBindingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProjectRoutingProfileBindingError";
    this.code = code;
  }
}

class ProjectRoutingProfileBindingStateError extends Error {}

type BindingEventData = Readonly<{
  expectedBindingVersion: number;
  previousProfileId: string | null;
  binding: ProjectRoutingProfileBindingRecord;
}>;

export const PROJECT_ROUTING_PROFILE_BINDING_PROJECTION: ProjectionDefinition = Object.freeze({
  name: BINDING_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) =>
    event.streamType === BINDING_STREAM_TYPE &&
    event.eventType === BINDING_EVENT_TYPE &&
    UUID_PATTERN.test(event.streamId)
      ? [event.streamId]
      : [],
  reduce: ({ current, event }) => ({
    type: "set",
    state: requireJsonValue(reduceBindingEvent(current, event)),
  }),
});

export class ProjectRoutingProfileBindingRepository {
  readonly #events: HarnessEventStore;
  readonly #profiles: ModelRoutingProfileRepository;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(BINDING_PROJECTION_NAME, PROJECTION_PROBE_KEY);
      this.#profiles = new ModelRoutingProfileRepository(events);
      this.#events = events;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  bindProfile(input: BindProjectRoutingProfileInput): ProjectRoutingProfileBindingCommandResult {
    const normalized = normalizeBindInput(input);
    try {
      const existingEvent = this.#events.readByEventId(normalized.eventId);
      if (existingEvent !== undefined) {
        return this.#retryExisting(normalized, existingEvent);
      }

      const current = this.#readOptionalBinding(normalized.projectId);
      if (
        (current === undefined &&
          (normalized.expectedBindingVersion !== 0 || normalized.previousProfileId !== null)) ||
        (current !== undefined &&
          (normalized.expectedBindingVersion !== current.bindingVersion ||
            normalized.previousProfileId !== current.profileId ||
            normalized.profileId === current.profileId ||
            normalized.occurredAtMs < current.updatedAtMs))
      ) {
        throw new ProjectRoutingProfileBindingError("conflict");
      }

      const profile = this.#profiles.readProfile(normalized.profileId);
      if (
        profile.profileVersion !== normalized.expectedProfileVersion ||
        profile.activeConfiguration.revisionId !== normalized.expectedConfigurationRevisionId ||
        normalized.occurredAtMs < profile.updatedAtMs
      ) {
        throw new ProjectRoutingProfileBindingError("conflict");
      }

      const binding = freezeBinding({
        schemaVersion: 1,
        projectId: normalized.projectId,
        bindingVersion: normalized.expectedBindingVersion + 1,
        profileId: normalized.profileId,
        profileVersionAtBinding: profile.profileVersion,
        configurationRevisionIdAtBinding: profile.activeConfiguration.revisionId,
        createdAtMs: current?.createdAtMs ?? normalized.occurredAtMs,
        updatedAtMs: normalized.occurredAtMs,
      });
      const eventData = Object.freeze({
        expectedBindingVersion: normalized.expectedBindingVersion,
        previousProfileId: normalized.previousProfileId,
        binding,
      });
      const appended = this.#events.append(
        eventFromBinding(
          normalized.eventId,
          normalized.occurredAtMs,
          eventData,
          normalized.metadata,
        ),
      );
      return Object.freeze({
        duplicate: appended.duplicate,
        event: appended.event,
        binding,
      });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readBinding(projectId: string): ProjectRoutingProfileBindingRecord {
    if (!isUuid(projectId)) {
      throw new ProjectRoutingProfileBindingError("invalid_input");
    }
    try {
      const binding = this.#readOptionalBinding(projectId);
      if (binding === undefined) {
        throw new ProjectRoutingProfileBindingError("not_found");
      }
      return binding;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  listBindings(afterProjectId = "", limit = 100): readonly ProjectRoutingProfileBindingRecord[] {
    if (
      (afterProjectId !== "" && !isUuid(afterProjectId)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new ProjectRoutingProfileBindingError("invalid_input");
    }
    try {
      return Object.freeze(
        this.#events
          .listProjectionStates(BINDING_PROJECTION_NAME, afterProjectId, limit)
          .map((projected) => decodeBindingRecord(projected.state)),
      );
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  #readOptionalBinding(projectId: string): ProjectRoutingProfileBindingRecord | undefined {
    const projected = this.#events.readProjectionState(BINDING_PROJECTION_NAME, projectId);
    return projected === undefined ? undefined : decodeBindingRecord(projected.state);
  }

  #retryExisting(
    input: BindProjectRoutingProfileInput,
    event: StoredEvent,
  ): ProjectRoutingProfileBindingCommandResult {
    let eventData: BindingEventData;
    try {
      eventData = decodeBindingEvent(event);
    } catch {
      throw new ProjectRoutingProfileBindingError("conflict");
    }
    if (!eventDataMatchesInput(eventData, event, input)) {
      throw new ProjectRoutingProfileBindingError("conflict");
    }
    const appended = this.#events.append(
      eventFromBinding(event.eventId, event.occurredAtMs, eventData, input.metadata),
    );
    if (!appended.duplicate) {
      throw new ProjectRoutingProfileBindingError("conflict");
    }
    return Object.freeze({
      duplicate: true,
      event: appended.event,
      binding: eventData.binding,
    });
  }
}

function reduceBindingEvent(
  current: JsonValue | undefined,
  event: StoredEvent,
): ProjectRoutingProfileBindingRecord {
  const eventData = decodeBindingEvent(event);
  const { binding, expectedBindingVersion, previousProfileId } = eventData;
  if (
    binding.bindingVersion !== expectedBindingVersion + 1 ||
    binding.updatedAtMs !== event.occurredAtMs
  ) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  if (current === undefined) {
    if (
      expectedBindingVersion !== 0 ||
      previousProfileId !== null ||
      binding.createdAtMs !== event.occurredAtMs
    ) {
      throw new ProjectRoutingProfileBindingStateError();
    }
    return binding;
  }

  const previous = decodeBindingRecord(current);
  if (
    previous.projectId !== binding.projectId ||
    expectedBindingVersion !== previous.bindingVersion ||
    previousProfileId !== previous.profileId ||
    binding.profileId === previous.profileId ||
    binding.createdAtMs !== previous.createdAtMs ||
    event.occurredAtMs < previous.updatedAtMs
  ) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  return binding;
}

function normalizeBindInput(input: unknown): BindProjectRoutingProfileInput {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ProjectRoutingProfileBindingError("invalid_input");
    }
    const record = requireCommandRecord(input, [
      "eventId",
      "expectedBindingVersion",
      "expectedConfigurationRevisionId",
      "expectedProfileVersion",
      "occurredAtMs",
      "previousProfileId",
      "profileId",
      "projectId",
    ]);
    const expectedBindingVersion = requireNonNegativeInteger(record.expectedBindingVersion);
    const previousProfileId =
      record.previousProfileId === null ? null : requireUuid(record.previousProfileId);
    if ((expectedBindingVersion === 0) !== (previousProfileId === null)) {
      throw new ProjectRoutingProfileBindingError("invalid_input");
    }
    return Object.freeze({
      eventId: requireUuid(record.eventId),
      projectId: requireUuid(record.projectId),
      expectedBindingVersion,
      previousProfileId,
      profileId: requireUuid(record.profileId),
      expectedProfileVersion: requirePositiveInteger(record.expectedProfileVersion),
      expectedConfigurationRevisionId: requireUuid(record.expectedConfigurationRevisionId),
      occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
      ...(record.metadata === undefined
        ? {}
        : { metadata: normalizeEventMetadata(record.metadata) }),
    });
  } catch (error: unknown) {
    if (error instanceof ProjectRoutingProfileBindingError) {
      throw error;
    }
    throw new ProjectRoutingProfileBindingError("invalid_input");
  }
}

function normalizeEventMetadata(input: unknown): EventMetadata {
  if (
    !validateJsonValue(input).ok ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new ProjectRoutingProfileBindingError("invalid_input");
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
    throw new ProjectRoutingProfileBindingError("invalid_input");
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

function eventFromBinding(
  eventId: string,
  occurredAtMs: number,
  eventData: BindingEventData,
  metadata: EventMetadata | undefined,
): Parameters<HarnessEventStore["append"]>[0] {
  return Object.freeze({
    eventId,
    streamType: BINDING_STREAM_TYPE,
    streamId: eventData.binding.projectId,
    eventType: BINDING_EVENT_TYPE,
    eventVersion: 1,
    occurredAtMs,
    payload: requireJsonValue(eventData),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function decodeBindingEvent(event: StoredEvent): BindingEventData {
  if (
    event.streamType !== BINDING_STREAM_TYPE ||
    event.eventType !== BINDING_EVENT_TYPE ||
    event.eventVersion !== 1
  ) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  const payload = requireStateRecord(event.payload, [
    "binding",
    "expectedBindingVersion",
    "previousProfileId",
  ]);
  const binding = decodeBindingRecord(payload.binding);
  const expectedBindingVersion = requireStateNonNegativeInteger(payload.expectedBindingVersion);
  const previousProfileId = requireStateNullableUuid(payload.previousProfileId);
  if (
    binding.projectId !== event.streamId ||
    binding.updatedAtMs !== event.occurredAtMs ||
    binding.bindingVersion !== expectedBindingVersion + 1
  ) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  return Object.freeze({ expectedBindingVersion, previousProfileId, binding });
}

function decodeBindingRecord(input: unknown): ProjectRoutingProfileBindingRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ProjectRoutingProfileBindingStateError();
    }
    const record = requireStateRecord(input, [
      "bindingVersion",
      "configurationRevisionIdAtBinding",
      "createdAtMs",
      "profileId",
      "profileVersionAtBinding",
      "projectId",
      "schemaVersion",
      "updatedAtMs",
    ]);
    const createdAtMs = requireStateNonNegativeInteger(record.createdAtMs);
    const updatedAtMs = requireStateNonNegativeInteger(record.updatedAtMs);
    if (record.schemaVersion !== 1 || createdAtMs > updatedAtMs) {
      throw new ProjectRoutingProfileBindingStateError();
    }
    return freezeBinding({
      schemaVersion: 1,
      projectId: requireStateUuid(record.projectId),
      bindingVersion: requireStatePositiveInteger(record.bindingVersion),
      profileId: requireStateUuid(record.profileId),
      profileVersionAtBinding: requireStatePositiveInteger(record.profileVersionAtBinding),
      configurationRevisionIdAtBinding: requireStateUuid(record.configurationRevisionIdAtBinding),
      createdAtMs,
      updatedAtMs,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectRoutingProfileBindingStateError) {
      throw error;
    }
    throw new ProjectRoutingProfileBindingStateError();
  }
}

function eventDataMatchesInput(
  eventData: BindingEventData,
  event: StoredEvent,
  input: BindProjectRoutingProfileInput,
): boolean {
  return (
    event.eventId === input.eventId &&
    event.occurredAtMs === input.occurredAtMs &&
    eventData.binding.projectId === input.projectId &&
    eventData.expectedBindingVersion === input.expectedBindingVersion &&
    eventData.previousProfileId === input.previousProfileId &&
    eventData.binding.profileId === input.profileId &&
    eventData.binding.profileVersionAtBinding === input.expectedProfileVersion &&
    eventData.binding.configurationRevisionIdAtBinding === input.expectedConfigurationRevisionId
  );
}

function freezeBinding(
  input: ProjectRoutingProfileBindingRecord,
): ProjectRoutingProfileBindingRecord {
  return Object.freeze(input);
}

function requireCommandRecord(
  input: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProjectRoutingProfileBindingError("invalid_input");
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
    throw new ProjectRoutingProfileBindingError("invalid_input");
  }
  return input as Record<string, unknown>;
}

function requireStateRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  return input as Record<string, unknown>;
}

function requireJsonValue(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  return input as JsonValue;
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ProjectRoutingProfileBindingError("invalid_input");
  }
  return input;
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ProjectRoutingProfileBindingError("invalid_input");
  }
  return input as number;
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ProjectRoutingProfileBindingError("invalid_input");
  }
  return input as number;
}

function requireStateUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  return input;
}

function requireStateNullableUuid(input: unknown): string | null {
  return input === null ? null : requireStateUuid(input);
}

function requireStatePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  return input as number;
}

function requireStateNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ProjectRoutingProfileBindingStateError();
  }
  return input as number;
}

function mapRepositoryError(error: unknown): ProjectRoutingProfileBindingError {
  if (error instanceof ProjectRoutingProfileBindingError) {
    return error;
  }
  if (error instanceof EventStoreError) {
    if (error.code === "closed") {
      return new ProjectRoutingProfileBindingError("closed");
    }
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new ProjectRoutingProfileBindingError("conflict");
    }
    if (error.code === "invalid_event") {
      return new ProjectRoutingProfileBindingError("invalid_input");
    }
  }
  if (error instanceof ModelRoutingProfileError) {
    if (error.code === "closed") {
      return new ProjectRoutingProfileBindingError("closed");
    }
    if (error.code === "not_found" || error.code === "conflict") {
      return new ProjectRoutingProfileBindingError("conflict");
    }
    if (error.code === "invalid_input") {
      return new ProjectRoutingProfileBindingError("invalid_input");
    }
  }
  return new ProjectRoutingProfileBindingError("storage_failure");
}

if (
  !NamespacedTokenSchema.safeParse(BINDING_STREAM_TYPE).success ||
  !NamespacedTokenSchema.safeParse(BINDING_EVENT_TYPE).success ||
  !NamespacedTokenSchema.safeParse(BINDING_PROJECTION_NAME).success
) {
  throw new Error("The project routing profile binding event names are invalid.");
}
