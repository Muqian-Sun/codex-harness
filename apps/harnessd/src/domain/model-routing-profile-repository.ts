import { NamespacedTokenSchema, validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import {
  EventStoreError,
  type EventMetadata,
  type HarnessEventStore,
  type ProjectionDefinition,
  type StoredEvent,
} from "../persistence/event-store.js";
import {
  ModelRoutingConfigurationError,
  normalizeModelRoutingConfiguration,
  type ModelRoutingConfiguration,
} from "./model-routing-config.js";

const PROFILE_STREAM_TYPE = "routing.profile";
const PROFILE_EVENT_TYPE = "routing.configuration_set";
const PROFILE_PROJECTION_NAME = "routing.current_profile";
const PROJECTION_REGISTRATION_PROBE = "00000000-0000-4000-8000-000000000000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ModelRoutingProfileRecord = Readonly<{
  schemaVersion: 1;
  profileId: string;
  profileVersion: number;
  activeConfiguration: ModelRoutingConfiguration;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type SetModelRoutingConfigurationInput = Readonly<{
  profileId: string;
  expectedProfileVersion: number;
  previousConfigurationRevisionId: string | null;
  occurredAtMs: number;
  configuration: ModelRoutingConfiguration;
  metadata?: EventMetadata;
}>;

export type ModelRoutingProfileCommandResult = Readonly<{
  duplicate: boolean;
  event: StoredEvent;
  profile: ModelRoutingProfileRecord;
}>;

export type ModelRoutingProfileErrorCode =
  "closed" | "conflict" | "invalid_input" | "not_found" | "storage_failure";

const ERROR_MESSAGES: Readonly<Record<ModelRoutingProfileErrorCode, string>> = Object.freeze({
  closed: "The model routing profile repository is closed.",
  conflict: "The model routing profile command conflicts with current state.",
  invalid_input: "The model routing profile input is invalid.",
  not_found: "The model routing profile does not exist.",
  storage_failure: "The model routing profile repository operation failed.",
});

export class ModelRoutingProfileError extends Error {
  readonly code: ModelRoutingProfileErrorCode;

  constructor(code: ModelRoutingProfileErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ModelRoutingProfileError";
    this.code = code;
  }
}

class ModelRoutingProfileStateError extends Error {}

export const MODEL_ROUTING_PROFILE_PROJECTION: ProjectionDefinition = Object.freeze({
  name: PROFILE_PROJECTION_NAME,
  version: 1,
  selectKeys: (event) =>
    event.streamType === PROFILE_STREAM_TYPE &&
    event.eventType === PROFILE_EVENT_TYPE &&
    UUID_PATTERN.test(event.streamId)
      ? [event.streamId]
      : [],
  reduce: ({ current, event }) => ({
    type: "set",
    state: requireJsonValue(reduceProfileEvent(current, event)),
  }),
});

export class ModelRoutingProfileRepository {
  readonly #events: HarnessEventStore;

  constructor(events: HarnessEventStore) {
    try {
      events.readProjectionState(PROFILE_PROJECTION_NAME, PROJECTION_REGISTRATION_PROBE);
      this.#events = events;
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  setConfiguration(input: SetModelRoutingConfigurationInput): ModelRoutingProfileCommandResult {
    const normalized = normalizeSetConfigurationInput(input);
    try {
      const appended = this.#events.append({
        eventId: normalized.configuration.revisionId,
        streamType: PROFILE_STREAM_TYPE,
        streamId: normalized.profileId,
        eventType: PROFILE_EVENT_TYPE,
        eventVersion: 1,
        occurredAtMs: normalized.occurredAtMs,
        payload: {
          profileId: normalized.profileId,
          expectedProfileVersion: normalized.expectedProfileVersion,
          previousConfigurationRevisionId: normalized.previousConfigurationRevisionId,
          configuration: requireJsonValue(normalized.configuration),
        },
        ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
      });
      return Object.freeze({
        duplicate: appended.duplicate,
        event: appended.event,
        profile: this.readProfile(normalized.profileId),
      });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  readProfile(profileId: string): ModelRoutingProfileRecord {
    if (!isUuid(profileId)) {
      throw new ModelRoutingProfileError("invalid_input");
    }
    try {
      const projected = this.#events.readProjectionState(PROFILE_PROJECTION_NAME, profileId);
      if (projected === undefined) {
        throw new ModelRoutingProfileError("not_found");
      }
      return decodeProfileRecord(projected.state);
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  listProfiles(afterProfileId = "", limit = 100): readonly ModelRoutingProfileRecord[] {
    if (
      (afterProfileId !== "" && !isUuid(afterProfileId)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new ModelRoutingProfileError("invalid_input");
    }
    try {
      return Object.freeze(
        this.#events
          .listProjectionStates(PROFILE_PROJECTION_NAME, afterProfileId, limit)
          .map((projected) => decodeProfileRecord(projected.state)),
      );
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }
}

function reduceProfileEvent(
  current: JsonValue | undefined,
  event: StoredEvent,
): ModelRoutingProfileRecord {
  if (
    event.eventVersion !== 1 ||
    event.streamType !== PROFILE_STREAM_TYPE ||
    event.eventType !== PROFILE_EVENT_TYPE
  ) {
    throw new ModelRoutingProfileStateError();
  }
  const payload = requireStateRecord(event.payload, [
    "configuration",
    "expectedProfileVersion",
    "previousConfigurationRevisionId",
    "profileId",
  ]);
  const profileId = requireStateUuid(payload.profileId);
  const expectedProfileVersion = requireStateNonNegativeInteger(payload.expectedProfileVersion);
  const previousConfigurationRevisionId = requireStateNullableUuid(
    payload.previousConfigurationRevisionId,
  );
  const configuration = decodeConfiguration(payload.configuration);
  if (
    profileId !== event.streamId ||
    configuration.revisionId !== event.eventId ||
    configuration.revisionNumber !== expectedProfileVersion + 1
  ) {
    throw new ModelRoutingProfileStateError();
  }

  if (current === undefined) {
    if (expectedProfileVersion !== 0 || previousConfigurationRevisionId !== null) {
      throw new ModelRoutingProfileStateError();
    }
    return freezeProfile({
      schemaVersion: 1,
      profileId,
      profileVersion: 1,
      activeConfiguration: configuration,
      createdAtMs: event.occurredAtMs,
      updatedAtMs: event.occurredAtMs,
    });
  }

  const profile = decodeProfileRecord(current);
  if (
    profile.profileId !== profileId ||
    expectedProfileVersion !== profile.profileVersion ||
    previousConfigurationRevisionId !== profile.activeConfiguration.revisionId ||
    configuration.revisionId === profile.activeConfiguration.revisionId ||
    event.occurredAtMs < profile.updatedAtMs
  ) {
    throw new ModelRoutingProfileStateError();
  }
  return freezeProfile({
    ...profile,
    profileVersion: configuration.revisionNumber,
    activeConfiguration: configuration,
    updatedAtMs: event.occurredAtMs,
  });
}

function normalizeSetConfigurationInput(input: unknown): SetModelRoutingConfigurationInput {
  try {
    const record = requireCommandRecord(input, [
      "configuration",
      "expectedProfileVersion",
      "occurredAtMs",
      "previousConfigurationRevisionId",
      "profileId",
    ]);
    const expectedProfileVersion = requireNonNegativeInteger(record.expectedProfileVersion);
    const previousConfigurationRevisionId =
      record.previousConfigurationRevisionId === null
        ? null
        : requireUuid(record.previousConfigurationRevisionId);
    const configuration = normalizeModelRoutingConfiguration(record.configuration);
    if (
      configuration.revisionNumber !== expectedProfileVersion + 1 ||
      (expectedProfileVersion === 0) !== (previousConfigurationRevisionId === null)
    ) {
      throw new ModelRoutingProfileError("invalid_input");
    }
    return Object.freeze({
      profileId: requireUuid(record.profileId),
      expectedProfileVersion,
      previousConfigurationRevisionId,
      occurredAtMs: requireNonNegativeInteger(record.occurredAtMs),
      configuration,
      ...(record.metadata === undefined ? {} : { metadata: record.metadata as EventMetadata }),
    });
  } catch (error: unknown) {
    if (error instanceof ModelRoutingProfileError) {
      throw error;
    }
    if (error instanceof ModelRoutingConfigurationError) {
      throw new ModelRoutingProfileError("invalid_input");
    }
    throw new ModelRoutingProfileError("invalid_input");
  }
}

function decodeProfileRecord(input: unknown): ModelRoutingProfileRecord {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ModelRoutingProfileStateError();
    }
    const record = requireStateRecord(input, [
      "activeConfiguration",
      "createdAtMs",
      "profileId",
      "profileVersion",
      "schemaVersion",
      "updatedAtMs",
    ]);
    if (record.schemaVersion !== 1) {
      throw new ModelRoutingProfileStateError();
    }
    const activeConfiguration = decodeConfiguration(record.activeConfiguration);
    const profileVersion = requireStatePositiveInteger(record.profileVersion);
    const createdAtMs = requireStateNonNegativeInteger(record.createdAtMs);
    const updatedAtMs = requireStateNonNegativeInteger(record.updatedAtMs);
    if (profileVersion !== activeConfiguration.revisionNumber || createdAtMs > updatedAtMs) {
      throw new ModelRoutingProfileStateError();
    }
    return freezeProfile({
      schemaVersion: 1,
      profileId: requireStateUuid(record.profileId),
      profileVersion,
      activeConfiguration,
      createdAtMs,
      updatedAtMs,
    });
  } catch (error: unknown) {
    if (error instanceof ModelRoutingProfileStateError) {
      throw error;
    }
    throw new ModelRoutingProfileStateError();
  }
}

function decodeConfiguration(input: unknown): ModelRoutingConfiguration {
  try {
    return normalizeModelRoutingConfiguration(input);
  } catch {
    throw new ModelRoutingProfileStateError();
  }
}

function freezeProfile(input: ModelRoutingProfileRecord): ModelRoutingProfileRecord {
  return Object.freeze(input);
}

function requireCommandRecord(
  input: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelRoutingProfileError("invalid_input");
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
    throw new ModelRoutingProfileError("invalid_input");
  }
  return input as Record<string, unknown>;
}

function requireStateRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelRoutingProfileStateError();
  }
  const actual = Object.keys(input).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new ModelRoutingProfileStateError();
  }
  return input as Record<string, unknown>;
}

function requireJsonValue(input: unknown): JsonValue {
  if (!validateJsonValue(input).ok) {
    throw new ModelRoutingProfileStateError();
  }
  return input as JsonValue;
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ModelRoutingProfileError("invalid_input");
  }
  return input;
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ModelRoutingProfileError("invalid_input");
  }
  return input as number;
}

function requireStateUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ModelRoutingProfileStateError();
  }
  return input;
}

function requireStateNullableUuid(input: unknown): string | null {
  return input === null ? null : requireStateUuid(input);
}

function requireStatePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ModelRoutingProfileStateError();
  }
  return input as number;
}

function requireStateNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ModelRoutingProfileStateError();
  }
  return input as number;
}

function mapRepositoryError(error: unknown): ModelRoutingProfileError {
  if (error instanceof ModelRoutingProfileError) {
    return error;
  }
  if (error instanceof EventStoreError) {
    if (error.code === "closed") {
      return new ModelRoutingProfileError("closed");
    }
    if (error.code === "conflict" || error.code === "projection_failure") {
      return new ModelRoutingProfileError("conflict");
    }
    if (error.code === "invalid_event") {
      return new ModelRoutingProfileError("invalid_input");
    }
  }
  return new ModelRoutingProfileError("storage_failure");
}

if (
  !NamespacedTokenSchema.safeParse(PROFILE_STREAM_TYPE).success ||
  !NamespacedTokenSchema.safeParse(PROFILE_EVENT_TYPE).success ||
  !NamespacedTokenSchema.safeParse(PROFILE_PROJECTION_NAME).success
) {
  throw new Error("The model routing profile event names are invalid.");
}
