import { MAX_MODEL_REASONING_EFFORTS, validateJsonValue } from "@codex-harness/protocol";

import {
  ModelRoutingConfigurationError,
  normalizeModelRoutingConfiguration,
  type ModelRoutingConfiguration,
  type ModelTier,
  type ModelTierTarget,
} from "./model-routing-config.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROVIDER_CHARACTERS = 256;
const MAX_MODEL_ID_CHARACTERS = 256;
const MAX_MODEL_CHARACTERS = 4_096;
const MAX_REASONING_EFFORT_CHARACTERS = 128;
const MAX_CURSOR_CHARACTERS = 4_096;
const MAX_CATALOG_PAGES = 128;
const MAX_CATALOG_MODELS = 10_000;

export type ModelInputModality = "audio" | "image" | "text";

export type ObservedModel = Readonly<{
  id: string;
  model: string;
  hidden: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly string[];
  inputModalities: readonly ModelInputModality[];
}>;

export type ModelCatalogSnapshot = Readonly<{
  schemaVersion: 1;
  snapshotId: string;
  workerSessionId: string;
  provider: string;
  observedAtMs: number;
  includeHidden: true;
  complete: true;
  models: readonly ObservedModel[];
}>;

export type ModelCatalogPageInput = Readonly<{
  requestCursor: string | null;
  includeHidden: true;
  response: unknown;
}>;

export type CreateModelCatalogSnapshotInput = Readonly<{
  schemaVersion: 1;
  snapshotId: string;
  workerSessionId: string;
  provider: string;
  observedAtMs: number;
  pages: readonly ModelCatalogPageInput[];
}>;

export type ObservedModelAvailabilityStatus =
  | "model_unavailable"
  | "observed_available"
  | "provider_unobserved"
  | "reasoning_effort_unsupported";

export type ObservedModelTierAvailability = Readonly<{
  tier: ModelTier;
  provider: string;
  model: string;
  reasoningEffort: string;
  status: ObservedModelAvailabilityStatus;
  snapshotId: string | null;
  workerSessionId: string | null;
  observedAtMs: number | null;
  modelId: string | null;
  supportedReasoningEfforts: readonly string[];
}>;

export type ModelRoutingAvailabilityAssessment = Readonly<{
  schemaVersion: 1;
  configurationRevisionId: string;
  configurationRevisionNumber: number;
  allObservedAvailable: boolean;
  executionAuthorized: false;
  tiers: Readonly<Record<ModelTier, ObservedModelTierAvailability>>;
}>;

export type ModelCatalogErrorCode =
  "ambiguous_provider" | "invalid_catalog" | "invalid_configuration";

const ERROR_MESSAGES: Readonly<Record<ModelCatalogErrorCode, string>> = Object.freeze({
  ambiguous_provider: "More than one model catalog snapshot was supplied for a provider.",
  invalid_catalog: "The model catalog snapshot is invalid.",
  invalid_configuration: "The model routing configuration is invalid.",
});

export class ModelCatalogError extends Error {
  readonly code: ModelCatalogErrorCode;

  constructor(code: ModelCatalogErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ModelCatalogError";
    this.code = code;
  }
}

const VERIFIED_SNAPSHOTS = new WeakSet<object>();

export function createModelCatalogSnapshot(input: unknown): ModelCatalogSnapshot {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ModelCatalogError("invalid_catalog");
    }
    const record = requireExactRecord(input, [
      "observedAtMs",
      "pages",
      "provider",
      "schemaVersion",
      "snapshotId",
      "workerSessionId",
    ]);
    if (record.schemaVersion !== 1 || !Array.isArray(record.pages)) {
      throw new ModelCatalogError("invalid_catalog");
    }
    if (record.pages.length < 1 || record.pages.length > MAX_CATALOG_PAGES) {
      throw new ModelCatalogError("invalid_catalog");
    }

    const models: ObservedModel[] = [];
    const modelIds = new Set<string>();
    const modelNames = new Set<string>();
    const seenRequestCursors = new Set<string>();
    let expectedRequestCursor: string | null = null;

    for (const pageInput of record.pages) {
      const page = requireExactRecord(pageInput, ["includeHidden", "requestCursor", "response"]);
      const requestCursor = requireNullableCursor(page.requestCursor);
      if (page.includeHidden !== true || requestCursor !== expectedRequestCursor) {
        throw new ModelCatalogError("invalid_catalog");
      }
      if (requestCursor !== null) {
        if (seenRequestCursors.has(requestCursor)) {
          throw new ModelCatalogError("invalid_catalog");
        }
        seenRequestCursors.add(requestCursor);
      }

      const response = normalizePageResponse(page.response);
      for (const model of response.models) {
        if (modelIds.has(model.id) || modelNames.has(model.model)) {
          throw new ModelCatalogError("invalid_catalog");
        }
        modelIds.add(model.id);
        modelNames.add(model.model);
        models.push(model);
        if (models.length > MAX_CATALOG_MODELS) {
          throw new ModelCatalogError("invalid_catalog");
        }
      }
      if (response.nextCursor !== null && seenRequestCursors.has(response.nextCursor)) {
        throw new ModelCatalogError("invalid_catalog");
      }
      expectedRequestCursor = response.nextCursor;
    }

    if (expectedRequestCursor !== null) {
      throw new ModelCatalogError("invalid_catalog");
    }

    models.sort((left, right) =>
      left.model === right.model
        ? compareStrings(left.id, right.id)
        : compareStrings(left.model, right.model),
    );
    return freezeVerifiedSnapshot({
      schemaVersion: 1,
      snapshotId: requireUuid(record.snapshotId),
      workerSessionId: requireUuid(record.workerSessionId),
      provider: requireIdentifier(record.provider, MAX_PROVIDER_CHARACTERS),
      observedAtMs: requireNonNegativeInteger(record.observedAtMs),
      includeHidden: true,
      complete: true,
      models: Object.freeze(models),
    });
  } catch (error: unknown) {
    if (error instanceof ModelCatalogError) {
      throw error;
    }
    throw new ModelCatalogError("invalid_catalog");
  }
}

export function assessModelRoutingAvailability(
  rawConfiguration: unknown,
  rawSnapshots: unknown,
): ModelRoutingAvailabilityAssessment {
  let configuration: ModelRoutingConfiguration;
  try {
    configuration = normalizeModelRoutingConfiguration(rawConfiguration);
  } catch (error: unknown) {
    if (error instanceof ModelRoutingConfigurationError) {
      throw new ModelCatalogError("invalid_configuration");
    }
    throw new ModelCatalogError("invalid_configuration");
  }
  if (
    !validateJsonValue(rawSnapshots).ok ||
    !Array.isArray(rawSnapshots) ||
    rawSnapshots.length > 128
  ) {
    throw new ModelCatalogError("invalid_catalog");
  }
  const snapshots = rawSnapshots.map((snapshot) => requireVerifiedSnapshot(snapshot));
  const byProvider = new Map<string, ModelCatalogSnapshot>();
  for (const snapshot of snapshots) {
    if (byProvider.has(snapshot.provider)) {
      throw new ModelCatalogError("ambiguous_provider");
    }
    byProvider.set(snapshot.provider, snapshot);
  }

  const tiers = Object.freeze({
    fast: assessTier("fast", configuration.tiers.fast, byProvider),
    standard: assessTier("standard", configuration.tiers.standard, byProvider),
    deep: assessTier("deep", configuration.tiers.deep, byProvider),
  });
  return Object.freeze({
    schemaVersion: 1,
    configurationRevisionId: configuration.revisionId,
    configurationRevisionNumber: configuration.revisionNumber,
    allObservedAvailable: Object.values(tiers).every(
      (tier) => tier.status === "observed_available",
    ),
    executionAuthorized: false,
    tiers,
  });
}

function normalizePageResponse(input: unknown): Readonly<{
  models: readonly ObservedModel[];
  nextCursor: string | null;
}> {
  const response = requireRecord(input);
  if (!Array.isArray(response.data) || response.data.length > MAX_CATALOG_MODELS) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return Object.freeze({
    models: Object.freeze(response.data.map((model) => normalizeObservedModel(model))),
    nextCursor:
      response.nextCursor === undefined ? null : requireNullableCursor(response.nextCursor),
  });
}

function normalizeObservedModel(input: unknown): ObservedModel {
  const record = requireRecord(input);
  if (!Array.isArray(record.supportedReasoningEfforts)) {
    throw new ModelCatalogError("invalid_catalog");
  }
  const efforts = record.supportedReasoningEfforts.map((option) => {
    const effort = requireRecord(option).reasoningEffort;
    return requireIdentifier(effort, MAX_REASONING_EFFORT_CHARACTERS);
  });
  const normalizedEfforts = uniqueSortedStrings(efforts);
  const defaultReasoningEffort = requireIdentifier(
    record.defaultReasoningEffort,
    MAX_REASONING_EFFORT_CHARACTERS,
  );
  if (!normalizedEfforts.includes(defaultReasoningEffort)) {
    throw new ModelCatalogError("invalid_catalog");
  }
  const inputModalities = normalizeInputModalities(record.inputModalities);
  return freezeObservedModel({
    id: requireIdentifier(record.id, MAX_MODEL_ID_CHARACTERS),
    model: requireIdentifier(record.model, MAX_MODEL_CHARACTERS),
    hidden: requireBoolean(record.hidden),
    defaultReasoningEffort,
    supportedReasoningEfforts: normalizedEfforts,
    inputModalities,
  });
}

function assessTier(
  tier: ModelTier,
  target: ModelTierTarget,
  snapshots: ReadonlyMap<string, ModelCatalogSnapshot>,
): ObservedModelTierAvailability {
  const snapshot = snapshots.get(target.provider);
  if (snapshot === undefined) {
    return freezeTierAvailability({
      tier,
      ...target,
      status: "provider_unobserved",
      snapshotId: null,
      workerSessionId: null,
      observedAtMs: null,
      modelId: null,
      supportedReasoningEfforts: Object.freeze([]),
    });
  }
  const model = snapshot.models.find((candidate) => candidate.model === target.model);
  if (model === undefined) {
    return freezeTierAvailability({
      tier,
      ...target,
      status: "model_unavailable",
      snapshotId: snapshot.snapshotId,
      workerSessionId: snapshot.workerSessionId,
      observedAtMs: snapshot.observedAtMs,
      modelId: null,
      supportedReasoningEfforts: Object.freeze([]),
    });
  }
  const status: ObservedModelAvailabilityStatus = model.supportedReasoningEfforts.includes(
    target.reasoningEffort,
  )
    ? "observed_available"
    : "reasoning_effort_unsupported";
  return freezeTierAvailability({
    tier,
    ...target,
    status,
    snapshotId: snapshot.snapshotId,
    workerSessionId: snapshot.workerSessionId,
    observedAtMs: snapshot.observedAtMs,
    modelId: model.id,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
  });
}

function normalizeInputModalities(input: unknown): readonly ModelInputModality[] {
  if (input === undefined) {
    return Object.freeze(["image", "text"]);
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return uniqueSortedModalities(input.map((modality) => requireInputModality(modality)));
}

function uniqueSortedStrings(input: readonly string[]): readonly string[] {
  if (
    input.length < 1 ||
    input.length > MAX_MODEL_REASONING_EFFORTS ||
    new Set(input).size !== input.length
  ) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return Object.freeze([...input].sort());
}

function uniqueSortedModalities(
  input: readonly ModelInputModality[],
): readonly ModelInputModality[] {
  if (input.length < 1 || new Set(input).size !== input.length) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return Object.freeze([...input].sort());
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeVerifiedSnapshot(input: ModelCatalogSnapshot): ModelCatalogSnapshot {
  const snapshot = Object.freeze(input);
  VERIFIED_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function freezeObservedModel(input: ObservedModel): ObservedModel {
  return Object.freeze(input);
}

function freezeTierAvailability(
  input: ObservedModelTierAvailability,
): ObservedModelTierAvailability {
  return Object.freeze(input);
}

function requireExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(input);
  const keys = Object.keys(record).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return record;
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input;
}

function requireIdentifier(input: unknown, maxCharacters: number): string {
  if (!isIdentifier(input, maxCharacters)) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input;
}

function isIdentifier(input: unknown, maxCharacters: number): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    input.length <= maxCharacters &&
    input.trim() === input &&
    !containsControlCharacter(input)
  );
}

function requireNullableCursor(input: unknown): string | null {
  if (input === null) {
    return null;
  }
  if (typeof input !== "string" || input.length < 1 || input.length > MAX_CURSOR_CHARACTERS) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input;
}

function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input as number;
}

function requireBoolean(input: unknown): boolean {
  if (typeof input !== "boolean") {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input;
}

function requireInputModality(input: unknown): ModelInputModality {
  if (input !== "audio" && input !== "image" && input !== "text") {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input;
}

function requireVerifiedSnapshot(input: unknown): ModelCatalogSnapshot {
  if (typeof input !== "object" || input === null || !VERIFIED_SNAPSHOTS.has(input)) {
    throw new ModelCatalogError("invalid_catalog");
  }
  return input as ModelCatalogSnapshot;
}

function containsControlCharacter(input: string): boolean {
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}
