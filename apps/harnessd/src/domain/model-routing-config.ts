import { validateJsonValue } from "@codex-harness/protocol";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROVIDER_CHARACTERS = 256;
const MAX_MODEL_CHARACTERS = 4096;
const MAX_REASONING_EFFORT_CHARACTERS = 128;

export const MODEL_TIERS = Object.freeze(["fast", "standard", "deep"] as const);

export type ModelTier = (typeof MODEL_TIERS)[number];

export type ModelTierTarget = Readonly<{
  provider: string;
  model: string;
  reasoningEffort: string;
}>;

export type ModelRoutingConfiguration = Readonly<{
  schemaVersion: 1;
  revisionId: string;
  revisionNumber: number;
  tiers: Readonly<Record<ModelTier, ModelTierTarget>>;
}>;

export type ResolvedModelTier = Readonly<{
  tier: ModelTier;
  configurationRevisionId: string;
  configurationRevisionNumber: number;
  provider: string;
  model: string;
  reasoningEffort: string;
}>;

export type ModelRoutingConfigurationErrorCode = "invalid_configuration" | "invalid_tier";

const ERROR_MESSAGES: Readonly<Record<ModelRoutingConfigurationErrorCode, string>> = Object.freeze({
  invalid_configuration: "The model routing configuration is invalid.",
  invalid_tier: "The model routing tier is invalid.",
});

export class ModelRoutingConfigurationError extends Error {
  readonly code: ModelRoutingConfigurationErrorCode;

  constructor(code: ModelRoutingConfigurationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ModelRoutingConfigurationError";
    this.code = code;
  }
}

export function normalizeModelRoutingConfiguration(input: unknown): ModelRoutingConfiguration {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ModelRoutingConfigurationError("invalid_configuration");
    }
    const record = requireExactRecord(input, [
      "revisionId",
      "revisionNumber",
      "schemaVersion",
      "tiers",
    ]);
    if (record.schemaVersion !== 1) {
      throw new ModelRoutingConfigurationError("invalid_configuration");
    }
    const tiers = requireExactRecord(record.tiers, ["deep", "fast", "standard"]);
    return Object.freeze({
      schemaVersion: 1 as const,
      revisionId: requireUuid(record.revisionId),
      revisionNumber: requirePositiveInteger(record.revisionNumber),
      tiers: Object.freeze({
        fast: normalizeTarget(tiers.fast),
        standard: normalizeTarget(tiers.standard),
        deep: normalizeTarget(tiers.deep),
      }),
    });
  } catch (error: unknown) {
    if (error instanceof ModelRoutingConfigurationError) {
      throw error;
    }
    throw new ModelRoutingConfigurationError("invalid_configuration");
  }
}

export function resolveModelTier(input: unknown, rawTier: unknown): ResolvedModelTier {
  const tier = requireTier(rawTier);
  const configuration = normalizeModelRoutingConfiguration(input);
  const target = configuration.tiers[tier];
  return Object.freeze({
    tier,
    configurationRevisionId: configuration.revisionId,
    configurationRevisionNumber: configuration.revisionNumber,
    provider: target.provider,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
  });
}

function normalizeTarget(input: unknown): ModelTierTarget {
  const record = requireExactRecord(input, ["model", "provider", "reasoningEffort"]);
  return Object.freeze({
    provider: requireIdentifier(record.provider, MAX_PROVIDER_CHARACTERS),
    model: requireIdentifier(record.model, MAX_MODEL_CHARACTERS),
    reasoningEffort: requireIdentifier(record.reasoningEffort, MAX_REASONING_EFFORT_CHARACTERS),
  });
}

function requireExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelRoutingConfigurationError("invalid_configuration");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ModelRoutingConfigurationError("invalid_configuration");
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new ModelRoutingConfigurationError("invalid_configuration");
  }
  return input;
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ModelRoutingConfigurationError("invalid_configuration");
  }
  return input as number;
}

function requireIdentifier(input: unknown, maxCharacters: number): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > maxCharacters ||
    input.trim() !== input ||
    containsControlCharacter(input)
  ) {
    throw new ModelRoutingConfigurationError("invalid_configuration");
  }
  return input;
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

function requireTier(input: unknown): ModelTier {
  if (input !== "fast" && input !== "standard" && input !== "deep") {
    throw new ModelRoutingConfigurationError("invalid_tier");
  }
  return input;
}
