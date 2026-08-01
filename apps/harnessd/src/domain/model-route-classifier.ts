import { validateJsonValue } from "@codex-harness/protocol";

import {
  resolveModelTier,
  type ModelRoutingConfiguration,
  type ModelTier,
  type ResolvedModelTier,
} from "./model-routing-config.js";

const MAX_ESTIMATED_STEPS = 10_000;
const STANDARD_STEP_THRESHOLD = 3;
const DEEP_STEP_THRESHOLD = 9;
const MODEL_TIER_RANK: Readonly<Record<ModelTier, number>> = Object.freeze({
  fast: 0,
  standard: 1,
  deep: 2,
});

export const MODEL_ROUTE_POLICY_VERSION = "model-route-policy-v1" as const;

export type ModelRouteTaskKind =
  "simple" | "code_change" | "analysis" | "architecture" | "systemic_diagnosis";

export type ModelRouteLevel = "low" | "medium" | "high";
export type ModelRouteScope = "isolated" | "module" | "cross_system";
export type ModelRouteToolBreadth = "none" | "single" | "multiple" | "extensive";

export type ModelRouteSafetySignals = Readonly<{
  securitySensitive: boolean;
  dataMigration: boolean;
  concurrencySensitive: boolean;
  publicApiChange: boolean;
  productionImpact: boolean;
  irreversibleOperation: boolean;
  permissionBoundaryChange: boolean;
}>;

export type ModelRouteFeatures = Readonly<{
  schemaVersion: 1;
  taskKind: ModelRouteTaskKind;
  complexity: ModelRouteLevel;
  scope: ModelRouteScope;
  ambiguity: ModelRouteLevel;
  estimatedSteps: number;
  toolBreadth: ModelRouteToolBreadth;
  safety: ModelRouteSafetySignals;
}>;

export type ModelRouteCandidateReason =
  | "task_simple"
  | "task_code_change"
  | "task_analysis"
  | "task_architecture"
  | "task_systemic_diagnosis"
  | "complexity_medium"
  | "complexity_high"
  | "scope_module"
  | "scope_cross_system"
  | "ambiguity_medium"
  | "ambiguity_high"
  | "estimated_steps_standard"
  | "estimated_steps_deep"
  | "tools_multiple"
  | "tools_extensive";

export type ModelRouteSafetyReason =
  | "risk_security_sensitive"
  | "risk_data_migration"
  | "risk_concurrency_sensitive"
  | "risk_public_api_change"
  | "risk_production_impact"
  | "risk_irreversible_operation"
  | "risk_permission_boundary_change";

export type ShadowModelRouteDecision = Readonly<{
  schemaVersion: 1;
  mode: "shadow";
  executionAuthorized: false;
  policyVersion: typeof MODEL_ROUTE_POLICY_VERSION;
  features: ModelRouteFeatures;
  candidateTier: ModelTier;
  safetyFloorTier: ModelTier;
  selectedTier: ModelTier;
  candidateReasons: readonly ModelRouteCandidateReason[];
  safetyReasons: readonly ModelRouteSafetyReason[];
  resolvedTarget: ResolvedModelTier;
}>;

export type ModelRouteClassificationErrorCode = "invalid_features";

export class ModelRouteClassificationError extends Error {
  readonly code: ModelRouteClassificationErrorCode;

  constructor() {
    super("The model route features are invalid.");
    this.name = "ModelRouteClassificationError";
    this.code = "invalid_features";
  }
}

export function classifyShadowModelRoute(
  rawFeatures: unknown,
  configuration: ModelRoutingConfiguration,
): ShadowModelRouteDecision {
  const features = normalizeModelRouteFeatures(rawFeatures);
  const candidate = classifyCandidate(features);
  const safetyReasons = classifySafetyReasons(features.safety);
  const safetyFloorTier: ModelTier = safetyReasons.length === 0 ? "fast" : "deep";
  const selectedTier = higherTier(candidate.tier, safetyFloorTier);
  const resolvedTarget = resolveModelTier(configuration, selectedTier);
  return Object.freeze({
    schemaVersion: 1 as const,
    mode: "shadow" as const,
    executionAuthorized: false as const,
    policyVersion: MODEL_ROUTE_POLICY_VERSION,
    features,
    candidateTier: candidate.tier,
    safetyFloorTier,
    selectedTier,
    candidateReasons: candidate.reasons,
    safetyReasons,
    resolvedTarget,
  });
}

export function normalizeModelRouteFeatures(input: unknown): ModelRouteFeatures {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ModelRouteClassificationError();
    }
    const record = requireExactRecord(input, [
      "ambiguity",
      "complexity",
      "estimatedSteps",
      "safety",
      "schemaVersion",
      "scope",
      "taskKind",
      "toolBreadth",
    ]);
    if (record.schemaVersion !== 1) {
      throw new ModelRouteClassificationError();
    }
    const safety = requireExactRecord(record.safety, [
      "concurrencySensitive",
      "dataMigration",
      "irreversibleOperation",
      "permissionBoundaryChange",
      "productionImpact",
      "publicApiChange",
      "securitySensitive",
    ]);
    return Object.freeze({
      schemaVersion: 1 as const,
      taskKind: requireTaskKind(record.taskKind),
      complexity: requireLevel(record.complexity),
      scope: requireScope(record.scope),
      ambiguity: requireLevel(record.ambiguity),
      estimatedSteps: requireEstimatedSteps(record.estimatedSteps),
      toolBreadth: requireToolBreadth(record.toolBreadth),
      safety: Object.freeze({
        securitySensitive: requireBoolean(safety.securitySensitive),
        dataMigration: requireBoolean(safety.dataMigration),
        concurrencySensitive: requireBoolean(safety.concurrencySensitive),
        publicApiChange: requireBoolean(safety.publicApiChange),
        productionImpact: requireBoolean(safety.productionImpact),
        irreversibleOperation: requireBoolean(safety.irreversibleOperation),
        permissionBoundaryChange: requireBoolean(safety.permissionBoundaryChange),
      }),
    });
  } catch (error: unknown) {
    if (error instanceof ModelRouteClassificationError) {
      throw error;
    }
    throw new ModelRouteClassificationError();
  }
}

function classifyCandidate(
  features: ModelRouteFeatures,
): Readonly<{ tier: ModelTier; reasons: readonly ModelRouteCandidateReason[] }> {
  const task = classifyTaskKind(features.taskKind);
  let tier = task.tier;
  const reasons: ModelRouteCandidateReason[] = [task.reason];

  if (features.complexity === "medium") {
    tier = higherTier(tier, "standard");
    reasons.push("complexity_medium");
  } else if (features.complexity === "high") {
    tier = "deep";
    reasons.push("complexity_high");
  }

  if (features.scope === "module") {
    tier = higherTier(tier, "standard");
    reasons.push("scope_module");
  } else if (features.scope === "cross_system") {
    tier = "deep";
    reasons.push("scope_cross_system");
  }

  if (features.ambiguity === "medium") {
    tier = higherTier(tier, "standard");
    reasons.push("ambiguity_medium");
  } else if (features.ambiguity === "high") {
    tier = "deep";
    reasons.push("ambiguity_high");
  }

  if (features.estimatedSteps >= DEEP_STEP_THRESHOLD) {
    tier = "deep";
    reasons.push("estimated_steps_deep");
  } else if (features.estimatedSteps >= STANDARD_STEP_THRESHOLD) {
    tier = higherTier(tier, "standard");
    reasons.push("estimated_steps_standard");
  }

  if (features.toolBreadth === "multiple") {
    tier = higherTier(tier, "standard");
    reasons.push("tools_multiple");
  } else if (features.toolBreadth === "extensive") {
    tier = "deep";
    reasons.push("tools_extensive");
  }

  return Object.freeze({ tier, reasons: Object.freeze(reasons) });
}

function classifyTaskKind(
  taskKind: ModelRouteTaskKind,
): Readonly<{ tier: ModelTier; reason: ModelRouteCandidateReason }> {
  switch (taskKind) {
    case "simple":
      return Object.freeze({ tier: "fast", reason: "task_simple" });
    case "code_change":
      return Object.freeze({ tier: "standard", reason: "task_code_change" });
    case "analysis":
      return Object.freeze({ tier: "standard", reason: "task_analysis" });
    case "architecture":
      return Object.freeze({ tier: "deep", reason: "task_architecture" });
    case "systemic_diagnosis":
      return Object.freeze({ tier: "deep", reason: "task_systemic_diagnosis" });
  }
}

function classifySafetyReasons(safety: ModelRouteSafetySignals): readonly ModelRouteSafetyReason[] {
  const reasons: ModelRouteSafetyReason[] = [];
  if (safety.securitySensitive) reasons.push("risk_security_sensitive");
  if (safety.dataMigration) reasons.push("risk_data_migration");
  if (safety.concurrencySensitive) reasons.push("risk_concurrency_sensitive");
  if (safety.publicApiChange) reasons.push("risk_public_api_change");
  if (safety.productionImpact) reasons.push("risk_production_impact");
  if (safety.irreversibleOperation) reasons.push("risk_irreversible_operation");
  if (safety.permissionBoundaryChange) reasons.push("risk_permission_boundary_change");
  return Object.freeze(reasons);
}

function higherTier(left: ModelTier, right: ModelTier): ModelTier {
  return MODEL_TIER_RANK[left] >= MODEL_TIER_RANK[right] ? left : right;
}

function requireExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelRouteClassificationError();
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ModelRouteClassificationError();
  }
  return input as Record<string, unknown>;
}

function requireTaskKind(input: unknown): ModelRouteTaskKind {
  if (
    input !== "simple" &&
    input !== "code_change" &&
    input !== "analysis" &&
    input !== "architecture" &&
    input !== "systemic_diagnosis"
  ) {
    throw new ModelRouteClassificationError();
  }
  return input;
}

function requireLevel(input: unknown): ModelRouteLevel {
  if (input !== "low" && input !== "medium" && input !== "high") {
    throw new ModelRouteClassificationError();
  }
  return input;
}

function requireScope(input: unknown): ModelRouteScope {
  if (input !== "isolated" && input !== "module" && input !== "cross_system") {
    throw new ModelRouteClassificationError();
  }
  return input;
}

function requireToolBreadth(input: unknown): ModelRouteToolBreadth {
  if (input !== "none" && input !== "single" && input !== "multiple" && input !== "extensive") {
    throw new ModelRouteClassificationError();
  }
  return input;
}

function requireEstimatedSteps(input: unknown): number {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 1 ||
    (input as number) > MAX_ESTIMATED_STEPS
  ) {
    throw new ModelRouteClassificationError();
  }
  return input as number;
}

function requireBoolean(input: unknown): boolean {
  if (typeof input !== "boolean") {
    throw new ModelRouteClassificationError();
  }
  return input;
}
