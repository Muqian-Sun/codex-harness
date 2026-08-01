import { createHash } from "node:crypto";

import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import {
  ModelRouteClassificationError,
  normalizeModelRouteFeatures,
  type ModelRouteFeatures,
  type ModelRouteLevel,
  type ModelRouteSafetySignals,
  type ModelRouteScope,
  type ModelRouteTaskKind,
  type ModelRouteToolBreadth,
} from "./model-route-classifier.js";
import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  TaskRecoveryContextError,
  buildTaskRecoveryCapsule,
  type TaskRecoveryFence,
} from "./task-recovery-context.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REQUIREMENT_ITEMS = 200;
const MAX_PLAN_STEPS = 200;
const MAX_GRAPH_NODES = 200;
const MAX_GRAPH_DEPENDENCIES = 2_000;
const STANDARD_STRUCTURE_THRESHOLD = 3;
const DEEP_STRUCTURE_THRESHOLD = 9;

export const SHADOW_ROUTE_FEATURE_POLICY_VERSION = "shadow-route-feature-policy-v1" as const;

export const MODEL_ROUTE_SAFETY_SIGNAL_NAMES = Object.freeze([
  "securitySensitive",
  "dataMigration",
  "concurrencySensitive",
  "publicApiChange",
  "productionImpact",
  "irreversibleOperation",
  "permissionBoundaryChange",
] as const satisfies readonly (keyof ModelRouteSafetySignals)[]);

export type ModelRouteSafetySignalName = (typeof MODEL_ROUTE_SAFETY_SIGNAL_NAMES)[number];
export type ShadowRouteFeatureCandidateSource = "user" | "model";

export type ShadowRouteFeatureCandidate = Readonly<{
  source: ShadowRouteFeatureCandidateSource;
  features: ModelRouteFeatures;
}>;

export type ShadowRouteTaskPhase =
  | "requirements_only"
  | "candidate_plan"
  | "confirmed_plan_pending_graph"
  | "active_graph"
  | "active_graph_with_candidate";

export type ShadowRouteTaskStructure = Readonly<{
  phase: ShadowRouteTaskPhase;
  requirementItemCount: number;
  authoritativePlanStepCount: number;
  candidatePlanStepCount: number;
  graphNodeCount: number;
  dependencyCount: number;
  subjectDependencyClosureCount: number | null;
}>;

export type ShadowRouteFeatureValueProvenance =
  "task_structure" | "policy_standard_floor" | "candidate_non_lowering";

export type ShadowRouteSafetyProvenance = "candidate_risk_floor" | "unresolved";

export type ShadowRouteFeatureProvenance = Readonly<{
  taskKind: ShadowRouteFeatureValueProvenance;
  complexity: ShadowRouteFeatureValueProvenance;
  scope: ShadowRouteFeatureValueProvenance;
  ambiguity: ShadowRouteFeatureValueProvenance;
  estimatedSteps: ShadowRouteFeatureValueProvenance;
  toolBreadth: ShadowRouteFeatureValueProvenance;
  safety: Readonly<Record<ModelRouteSafetySignalName, ShadowRouteSafetyProvenance>>;
}>;

export type ShadowRouteFeatureSnapshot = Readonly<{
  schemaVersion: 1;
  mode: "shadow";
  executionAuthorized: false;
  policyVersion: typeof SHADOW_ROUTE_FEATURE_POLICY_VERSION;
  subject: Readonly<{
    taskId: string;
    taskVersion: number;
    nodeId: string | null;
  }>;
  taskFence: TaskRecoveryFence;
  structure: ShadowRouteTaskStructure;
  candidate: ShadowRouteFeatureCandidate | null;
  effectiveFeatures: ModelRouteFeatures;
  provenance: ShadowRouteFeatureProvenance;
  unresolvedSafetySignals: readonly ModelRouteSafetySignalName[];
  routingFloorTier: "deep";
  featureDigest: string;
}>;

export type ShadowRouteFeatureSnapshotErrorCode =
  "invalid_candidate" | "invalid_snapshot" | "invalid_task" | "node_not_found";

const ERROR_MESSAGES: Readonly<Record<ShadowRouteFeatureSnapshotErrorCode, string>> = Object.freeze(
  {
    invalid_candidate: "The advisory route feature candidate is invalid.",
    invalid_snapshot: "The shadow route feature snapshot is invalid.",
    invalid_task: "The authoritative task route feature source is invalid.",
    node_not_found: "The route feature subject node does not exist in the active task graph.",
  },
);

export class ShadowRouteFeatureSnapshotError extends Error {
  readonly code: ShadowRouteFeatureSnapshotErrorCode;

  constructor(code: ShadowRouteFeatureSnapshotErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ShadowRouteFeatureSnapshotError";
    this.code = code;
  }
}

export function buildShadowRouteFeatureSnapshot(
  task: TaskPlanRecord,
  nodeId: string | null = null,
  candidate: ShadowRouteFeatureCandidate | null = null,
): ShadowRouteFeatureSnapshot {
  try {
    const normalizedCandidate = normalizeCandidate(candidate);
    const normalizedNodeId = normalizeSubjectNodeId(nodeId);
    const taskFence = cloneTaskFence(buildTaskRecoveryCapsule(task).fence);
    const structure = validateDerivedTaskStructure(
      deriveTaskStructure(task, normalizedNodeId),
      normalizedNodeId,
    );
    return materializeSnapshot(taskFence, normalizedNodeId, structure, normalizedCandidate);
  } catch (error: unknown) {
    if (error instanceof ShadowRouteFeatureSnapshotError) {
      throw error;
    }
    if (error instanceof ModelRouteClassificationError) {
      throw new ShadowRouteFeatureSnapshotError("invalid_candidate");
    }
    if (error instanceof TaskRecoveryContextError) {
      throw new ShadowRouteFeatureSnapshotError("invalid_task");
    }
    throw new ShadowRouteFeatureSnapshotError("invalid_task");
  }
}

export function decodeShadowRouteFeatureSnapshot(input: unknown): ShadowRouteFeatureSnapshot {
  try {
    if (!validateJsonValue(input).ok) {
      throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
    }
    const record = requireExactRecord(input, [
      "candidate",
      "effectiveFeatures",
      "executionAuthorized",
      "featureDigest",
      "mode",
      "policyVersion",
      "provenance",
      "routingFloorTier",
      "schemaVersion",
      "structure",
      "subject",
      "taskFence",
      "unresolvedSafetySignals",
    ]);
    const taskFence = decodeTaskFence(record.taskFence);
    const subject = requireExactRecord(record.subject, ["nodeId", "taskId", "taskVersion"]);
    const taskId = requireUuid(subject.taskId);
    const taskVersion = requirePositiveInteger(subject.taskVersion);
    const nodeId = subject.nodeId === null ? null : requireUuid(subject.nodeId);
    if (taskId !== taskFence.taskId || taskVersion !== taskFence.taskVersion) {
      throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
    }
    const structure = decodeTaskStructure(record.structure, nodeId);
    const candidate = decodeCandidate(record.candidate);
    const expected = materializeSnapshot(taskFence, nodeId, structure, candidate);
    if (
      record.schemaVersion !== 1 ||
      record.mode !== "shadow" ||
      record.executionAuthorized !== false ||
      record.policyVersion !== SHADOW_ROUTE_FEATURE_POLICY_VERSION ||
      record.routingFloorTier !== "deep" ||
      typeof record.featureDigest !== "string" ||
      !SHA256_PATTERN.test(record.featureDigest) ||
      canonicalJson(input as JsonValue) !== canonicalJson(expected as unknown as JsonValue)
    ) {
      throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
    }
    return expected;
  } catch (error: unknown) {
    if (error instanceof ShadowRouteFeatureSnapshotError) {
      throw error.code === "invalid_snapshot"
        ? error
        : new ShadowRouteFeatureSnapshotError("invalid_snapshot");
    }
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
}

export function isShadowRouteFeatureSnapshotCurrent(
  task: TaskPlanRecord,
  candidate: unknown,
): candidate is ShadowRouteFeatureSnapshot {
  try {
    const decoded = decodeShadowRouteFeatureSnapshot(candidate);
    const current = buildShadowRouteFeatureSnapshot(
      task,
      decoded.subject.nodeId,
      decoded.candidate,
    );
    return (
      canonicalJson(decoded as unknown as JsonValue) ===
      canonicalJson(current as unknown as JsonValue)
    );
  } catch {
    return false;
  }
}

function materializeSnapshot(
  taskFence: TaskRecoveryFence,
  nodeId: string | null,
  structure: ShadowRouteTaskStructure,
  candidate: ShadowRouteFeatureCandidate | null,
): ShadowRouteFeatureSnapshot {
  const derived = deriveEffectiveFeatures(structure, nodeId, candidate);
  const core = Object.freeze({
    schemaVersion: 1 as const,
    mode: "shadow" as const,
    executionAuthorized: false as const,
    policyVersion: SHADOW_ROUTE_FEATURE_POLICY_VERSION,
    subject: Object.freeze({
      taskId: taskFence.taskId,
      taskVersion: taskFence.taskVersion,
      nodeId,
    }),
    taskFence,
    structure,
    candidate,
    effectiveFeatures: derived.features,
    provenance: derived.provenance,
    unresolvedSafetySignals: derived.unresolvedSafetySignals,
    routingFloorTier: "deep" as const,
  });
  if (!validateJsonValue(core).ok) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  const featureDigest = createHash("sha256")
    .update(canonicalJson(core as unknown as JsonValue), "utf8")
    .digest("hex");
  return Object.freeze({ ...core, featureDigest });
}

function deriveTaskStructure(
  task: TaskPlanRecord,
  nodeId: string | null,
): ShadowRouteTaskStructure {
  const requirementRevisionId = task.activeRequirement.revisionId;
  const currentConfirmed =
    task.confirmedPlan?.basedOnRequirementRevisionId === requirementRevisionId
      ? task.confirmedPlan
      : null;
  const currentCandidate =
    task.latestPlan?.status === "candidate" &&
    task.latestPlan.basedOnRequirementRevisionId === requirementRevisionId
      ? task.latestPlan
      : null;
  const graph = task.activeGraph;
  const phase: ShadowRouteTaskPhase =
    graph !== null
      ? currentCandidate === null
        ? "active_graph"
        : "active_graph_with_candidate"
      : currentCandidate !== null
        ? "candidate_plan"
        : currentConfirmed !== null
          ? "confirmed_plan_pending_graph"
          : "requirements_only";
  const dependencyCount =
    graph?.nodes.reduce((total, node) => total + node.dependsOnNodeIds.length, 0) ?? 0;
  let subjectDependencyClosureCount: number | null = null;
  if (nodeId !== null) {
    if (graph === null) {
      throw new ShadowRouteFeatureSnapshotError("node_not_found");
    }
    subjectDependencyClosureCount = dependencyClosureCount(graph.nodes, nodeId);
  }
  return freezeStructure({
    phase,
    requirementItemCount:
      task.activeRequirement.constraints.length + task.activeRequirement.acceptanceCriteria.length,
    authoritativePlanStepCount: currentConfirmed?.steps.length ?? 0,
    candidatePlanStepCount: currentCandidate?.steps.length ?? 0,
    graphNodeCount: graph?.nodes.length ?? 0,
    dependencyCount,
    subjectDependencyClosureCount,
  });
}

function validateDerivedTaskStructure(
  structure: ShadowRouteTaskStructure,
  nodeId: string | null,
): ShadowRouteTaskStructure {
  try {
    return decodeTaskStructure(structure, nodeId);
  } catch {
    throw new ShadowRouteFeatureSnapshotError("invalid_task");
  }
}

function dependencyClosureCount(
  nodes: readonly Readonly<{ nodeId: string; dependsOnNodeIds: readonly string[] }>[],
  subjectNodeId: string,
): number {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  if (!byId.has(subjectNodeId)) {
    throw new ShadowRouteFeatureSnapshotError("node_not_found");
  }
  const visited = new Set<string>();
  const pending = [subjectNodeId];
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === undefined || visited.has(currentId)) {
      continue;
    }
    const current = byId.get(currentId);
    if (current === undefined) {
      throw new ShadowRouteFeatureSnapshotError("invalid_task");
    }
    visited.add(currentId);
    pending.push(...current.dependsOnNodeIds);
  }
  return visited.size;
}

function deriveEffectiveFeatures(
  structure: ShadowRouteTaskStructure,
  nodeId: string | null,
  candidate: ShadowRouteFeatureCandidate | null,
): Readonly<{
  features: ModelRouteFeatures;
  provenance: ShadowRouteFeatureProvenance;
  unresolvedSafetySignals: readonly ModelRouteSafetySignalName[];
}> {
  const structuralUnits = Math.max(
    1,
    structure.graphNodeCount,
    structure.authoritativePlanStepCount,
    structure.candidatePlanStepCount,
  );
  const structuralMagnitude = Math.max(structuralUnits, structure.requirementItemCount);
  const baseComplexity: ModelRouteLevel =
    structuralMagnitude >= DEEP_STRUCTURE_THRESHOLD
      ? "high"
      : structuralMagnitude >= STANDARD_STRUCTURE_THRESHOLD
        ? "medium"
        : "low";
  const baseScope: ModelRouteScope =
    structuralUnits > 1 || structure.dependencyCount > 0 ? "module" : "isolated";
  const baseAmbiguity: ModelRouteLevel =
    structure.phase === "requirements_only" || structure.phase === "candidate_plan"
      ? "high"
      : structure.phase === "confirmed_plan_pending_graph" ||
          structure.phase === "active_graph_with_candidate"
        ? "medium"
        : "low";
  const base: ModelRouteFeatures = Object.freeze({
    schemaVersion: 1 as const,
    taskKind: "analysis" as const,
    complexity: baseComplexity,
    scope: baseScope,
    ambiguity: baseAmbiguity,
    estimatedSteps: nodeId === null ? structuralUnits : 1,
    toolBreadth: "multiple" as const,
    safety: freezeSafety(
      Object.fromEntries(MODEL_ROUTE_SAFETY_SIGNAL_NAMES.map((name) => [name, false])),
    ),
  });
  const advisory = candidate?.features;
  const taskKind = selectRankedValue(base.taskKind, advisory?.taskKind, TASK_KIND_RANK);
  const complexity = selectRankedValue(base.complexity, advisory?.complexity, LEVEL_RANK);
  const scope = selectRankedValue(base.scope, advisory?.scope, SCOPE_RANK);
  const ambiguity = selectRankedValue(base.ambiguity, advisory?.ambiguity, LEVEL_RANK);
  const toolBreadth = selectRankedValue(base.toolBreadth, advisory?.toolBreadth, TOOL_RANK);
  const estimatedSteps = Math.max(base.estimatedSteps, advisory?.estimatedSteps ?? 0);
  const safetyEntries = MODEL_ROUTE_SAFETY_SIGNAL_NAMES.map((name) => {
    const candidateRisk = advisory?.safety[name] === true;
    return [name, candidateRisk] as const;
  });
  const safety = freezeSafety(Object.fromEntries(safetyEntries));
  const safetyProvenance = Object.freeze(
    Object.fromEntries(
      safetyEntries.map(([name, candidateRisk]) => [
        name,
        candidateRisk ? "candidate_risk_floor" : "unresolved",
      ]),
    ) as Record<ModelRouteSafetySignalName, ShadowRouteSafetyProvenance>,
  );
  const unresolvedSafetySignals = Object.freeze(
    MODEL_ROUTE_SAFETY_SIGNAL_NAMES.filter((name) => !safety[name]),
  );
  const features = Object.freeze({
    schemaVersion: 1 as const,
    taskKind: taskKind.value,
    complexity: complexity.value,
    scope: scope.value,
    ambiguity: ambiguity.value,
    estimatedSteps,
    toolBreadth: toolBreadth.value,
    safety,
  });
  const provenance = Object.freeze({
    taskKind: taskKind.fromCandidate ? "candidate_non_lowering" : "policy_standard_floor",
    complexity: complexity.fromCandidate ? "candidate_non_lowering" : "task_structure",
    scope: scope.fromCandidate ? "candidate_non_lowering" : "task_structure",
    ambiguity: ambiguity.fromCandidate ? "candidate_non_lowering" : "task_structure",
    estimatedSteps:
      advisory !== undefined && advisory.estimatedSteps > base.estimatedSteps
        ? "candidate_non_lowering"
        : "task_structure",
    toolBreadth: toolBreadth.fromCandidate ? "candidate_non_lowering" : "policy_standard_floor",
    safety: safetyProvenance,
  } satisfies ShadowRouteFeatureProvenance);
  return Object.freeze({ features, provenance, unresolvedSafetySignals });
}

const TASK_KIND_RANK: Readonly<Record<ModelRouteTaskKind, number>> = Object.freeze({
  simple: 0,
  code_change: 1,
  analysis: 1,
  architecture: 2,
  systemic_diagnosis: 2,
});
const LEVEL_RANK: Readonly<Record<ModelRouteLevel, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});
const SCOPE_RANK: Readonly<Record<ModelRouteScope, number>> = Object.freeze({
  isolated: 0,
  module: 1,
  cross_system: 2,
});
const TOOL_RANK: Readonly<Record<ModelRouteToolBreadth, number>> = Object.freeze({
  none: 0,
  single: 1,
  multiple: 2,
  extensive: 3,
});

function selectRankedValue<T extends string>(
  base: T,
  candidate: T | undefined,
  rank: Readonly<Record<T, number>>,
): Readonly<{ value: T; fromCandidate: boolean }> {
  if (candidate !== undefined && rank[candidate] >= rank[base] && candidate !== base) {
    return Object.freeze({ value: candidate, fromCandidate: true });
  }
  return Object.freeze({ value: base, fromCandidate: false });
}

function normalizeCandidate(input: unknown): ShadowRouteFeatureCandidate | null {
  if (input === null) {
    return null;
  }
  try {
    if (!validateJsonValue(input).ok) {
      throw new ShadowRouteFeatureSnapshotError("invalid_candidate");
    }
    const record = requireExactRecord(input, ["features", "source"]);
    if (record.source !== "user" && record.source !== "model") {
      throw new ShadowRouteFeatureSnapshotError("invalid_candidate");
    }
    return Object.freeze({
      source: record.source,
      features: normalizeModelRouteFeatures(record.features),
    });
  } catch (error: unknown) {
    if (error instanceof ShadowRouteFeatureSnapshotError && error.code === "invalid_candidate") {
      throw error;
    }
    throw new ShadowRouteFeatureSnapshotError("invalid_candidate");
  }
}

function decodeCandidate(input: unknown): ShadowRouteFeatureCandidate | null {
  try {
    return normalizeCandidate(input);
  } catch {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
}

function decodeTaskFence(input: unknown): TaskRecoveryFence {
  const record = requireExactRecord(input, [
    "confirmedPlanRevisionId",
    "digest",
    "graphRevisionId",
    "latestPlanRevisionId",
    "reconciliationId",
    "requirementRevisionId",
    "schemaVersion",
    "taskId",
    "taskVersion",
  ]);
  if (
    record.schemaVersion !== 1 ||
    typeof record.digest !== "string" ||
    !SHA256_PATTERN.test(record.digest)
  ) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    taskId: requireUuid(record.taskId),
    taskVersion: requirePositiveInteger(record.taskVersion),
    requirementRevisionId: requireUuid(record.requirementRevisionId),
    latestPlanRevisionId: requireNullableUuid(record.latestPlanRevisionId),
    confirmedPlanRevisionId: requireNullableUuid(record.confirmedPlanRevisionId),
    graphRevisionId: requireNullableUuid(record.graphRevisionId),
    reconciliationId: requireNullableUuid(record.reconciliationId),
    digest: record.digest,
  });
}

function cloneTaskFence(input: TaskRecoveryFence): TaskRecoveryFence {
  return decodeTaskFence(input);
}

function decodeTaskStructure(input: unknown, nodeId: string | null): ShadowRouteTaskStructure {
  const record = requireExactRecord(input, [
    "authoritativePlanStepCount",
    "candidatePlanStepCount",
    "dependencyCount",
    "graphNodeCount",
    "phase",
    "requirementItemCount",
    "subjectDependencyClosureCount",
  ]);
  const phase = requirePhase(record.phase);
  const requirementItemCount = requireBoundedCount(
    record.requirementItemCount,
    MAX_REQUIREMENT_ITEMS,
  );
  const authoritativePlanStepCount = requireBoundedCount(
    record.authoritativePlanStepCount,
    MAX_PLAN_STEPS,
  );
  const candidatePlanStepCount = requireBoundedCount(record.candidatePlanStepCount, MAX_PLAN_STEPS);
  const graphNodeCount = requireBoundedCount(record.graphNodeCount, MAX_GRAPH_NODES);
  const dependencyCount = requireBoundedCount(record.dependencyCount, MAX_GRAPH_DEPENDENCIES);
  const subjectDependencyClosureCount =
    record.subjectDependencyClosureCount === null
      ? null
      : requirePositiveBoundedCount(record.subjectDependencyClosureCount, MAX_GRAPH_NODES);
  const graphPhase = phase === "active_graph" || phase === "active_graph_with_candidate";
  const validPhaseCounts =
    (phase === "requirements_only" &&
      authoritativePlanStepCount === 0 &&
      candidatePlanStepCount === 0 &&
      graphNodeCount === 0) ||
    (phase === "candidate_plan" && candidatePlanStepCount > 0 && graphNodeCount === 0) ||
    (phase === "confirmed_plan_pending_graph" &&
      authoritativePlanStepCount > 0 &&
      candidatePlanStepCount === 0 &&
      graphNodeCount === 0) ||
    (phase === "active_graph" &&
      authoritativePlanStepCount > 0 &&
      candidatePlanStepCount === 0 &&
      graphNodeCount > 0) ||
    (phase === "active_graph_with_candidate" &&
      authoritativePlanStepCount > 0 &&
      candidatePlanStepCount > 0 &&
      graphNodeCount > 0);
  if (
    !validPhaseCounts ||
    (!graphPhase && dependencyCount !== 0) ||
    (nodeId === null && subjectDependencyClosureCount !== null) ||
    (nodeId !== null &&
      (!graphPhase ||
        subjectDependencyClosureCount === null ||
        subjectDependencyClosureCount > graphNodeCount))
  ) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return freezeStructure({
    phase,
    requirementItemCount,
    authoritativePlanStepCount,
    candidatePlanStepCount,
    graphNodeCount,
    dependencyCount,
    subjectDependencyClosureCount,
  });
}

function freezeStructure(input: ShadowRouteTaskStructure): ShadowRouteTaskStructure {
  return Object.freeze(input);
}

function freezeSafety(input: Record<string, unknown>): ModelRouteSafetySignals {
  return Object.freeze(
    Object.fromEntries(
      MODEL_ROUTE_SAFETY_SIGNAL_NAMES.map((name) => {
        const value = input[name];
        if (typeof value !== "boolean") {
          throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
        }
        return [name, value];
      }),
    ) as Record<ModelRouteSafetySignalName, boolean>,
  );
}

function normalizeSubjectNodeId(input: unknown): string | null {
  if (input === null) {
    return null;
  }
  if (!isUuid(input)) {
    throw new ShadowRouteFeatureSnapshotError("node_not_found");
  }
  return input;
}

function requireExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return input as Record<string, unknown>;
}

function requirePhase(input: unknown): ShadowRouteTaskPhase {
  if (
    input !== "requirements_only" &&
    input !== "candidate_plan" &&
    input !== "confirmed_plan_pending_graph" &&
    input !== "active_graph" &&
    input !== "active_graph_with_candidate"
  ) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return input;
}

function requireUuid(input: unknown): string {
  if (!isUuid(input)) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return input;
}

function requireNullableUuid(input: unknown): string | null {
  return input === null ? null : requireUuid(input);
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return input as number;
}

function requireBoundedCount(input: unknown, maximum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) > maximum) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return input as number;
}

function requirePositiveBoundedCount(input: unknown, maximum: number): number {
  const value = requireBoundedCount(input, maximum);
  if (value < 1) {
    throw new ShadowRouteFeatureSnapshotError("invalid_snapshot");
  }
  return value;
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
