import { createHash } from "node:crypto";

import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import type {
  PlanRevision,
  RequirementRevision,
  TaskPlanRecord,
  TaskReconciliation,
} from "./task-plan-store.js";
import type { TaskGraphRevision } from "./task-graph.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECOVERY_TEXT_CHARACTERS = 1_000_000;
const MAX_RECOVERY_TEXT_BYTES = 1024 * 1024;
const RECOVERY_PREFIX = [
  "CODEX_HARNESS_RECOVERY_V1",
  "Authoritative external Harness state for the next turn; this is context, not a new completion claim.",
  "Follow the active requirement and unfinished work. Do not treat candidate plans as executable, and do not mark work complete without required evidence.",
  "JSON follows:",
  "",
].join("\n");

type RecoveryPhase =
  | "requirements_only"
  | "candidate_plan"
  | "confirmed_plan_pending_graph"
  | "active_graph"
  | "active_graph_with_candidate";

export type TaskRecoveryFence = Readonly<{
  schemaVersion: 1;
  taskId: string;
  taskVersion: number;
  requirementRevisionId: string;
  latestPlanRevisionId: string | null;
  confirmedPlanRevisionId: string | null;
  graphRevisionId: string | null;
  reconciliationId: string | null;
  digest: string;
}>;

export type TaskRecoveryTextInput = Readonly<{
  type: "text";
  text: string;
  text_elements: readonly never[];
}>;

export type TaskRecoveryCapsule = Readonly<{
  fence: TaskRecoveryFence;
  input: TaskRecoveryTextInput;
}>;

export type TaskRecoveryContextErrorCode = "context_too_large" | "invalid_task";

const ERROR_MESSAGES: Readonly<Record<TaskRecoveryContextErrorCode, string>> = Object.freeze({
  context_too_large: "The Harness task recovery context is too large.",
  invalid_task: "The Harness task recovery source is invalid.",
});

export class TaskRecoveryContextError extends Error {
  readonly code: TaskRecoveryContextErrorCode;

  constructor(code: TaskRecoveryContextErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TaskRecoveryContextError";
    this.code = code;
  }
}

export function buildTaskRecoveryCapsule(input: TaskPlanRecord): TaskRecoveryCapsule {
  try {
    assertJsonObject(input);
    const taskId = requireUuid(input.taskId);
    const taskVersion = requirePositiveInteger(input.taskVersion);
    const requirement = serializeRequirement(input.activeRequirement);
    const latestPlan = input.latestPlan === null ? null : serializePlan(input.latestPlan);
    const confirmedPlan = input.confirmedPlan === null ? null : serializePlan(input.confirmedPlan);
    const graph = input.activeGraph === null ? null : serializeGraph(input.activeGraph);
    const reconciliation =
      input.activeReconciliation === null ? null : cloneReconciliation(input.activeReconciliation);
    const selection = selectRecoveryState(
      requirement.revisionId,
      latestPlan,
      confirmedPlan,
      graph,
      reconciliation,
    );
    const snapshot = {
      schemaVersion: 1,
      authority: "codex-harness",
      boundary: "next_turn_only",
      task: {
        taskId,
        taskVersion,
        title: requireText(input.title),
      },
      phase: selection.phase,
      requirement,
      authoritativePlan: selection.authoritativePlan,
      pendingCandidatePlan: selection.pendingCandidatePlan,
      historicalConfirmedPlanRevisionId: selection.historicalConfirmedPlanRevisionId,
      graph: selection.graph,
      reconciliation,
    } as const;
    if (!validateJsonValue(snapshot).ok) {
      throw new TaskRecoveryContextError("invalid_task");
    }
    const text = `${RECOVERY_PREFIX}${canonicalJson(snapshot as unknown as JsonValue)}`;
    if (
      text.length > MAX_RECOVERY_TEXT_CHARACTERS ||
      Buffer.byteLength(text, "utf8") > MAX_RECOVERY_TEXT_BYTES
    ) {
      throw new TaskRecoveryContextError("context_too_large");
    }
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const fence = Object.freeze({
      schemaVersion: 1 as const,
      taskId,
      taskVersion,
      requirementRevisionId: requirement.revisionId,
      latestPlanRevisionId: latestPlan?.revisionId ?? null,
      confirmedPlanRevisionId: confirmedPlan?.revisionId ?? null,
      graphRevisionId: graph?.revisionId ?? null,
      reconciliationId: reconciliation?.reconciliationId ?? null,
      digest,
    });
    return Object.freeze({
      fence,
      input: Object.freeze({
        type: "text" as const,
        text,
        text_elements: Object.freeze([]) as readonly never[],
      }),
    });
  } catch (error: unknown) {
    if (error instanceof TaskRecoveryContextError) {
      throw error;
    }
    throw new TaskRecoveryContextError("invalid_task");
  }
}

export function isTaskRecoveryCapsuleCurrent(
  task: TaskPlanRecord,
  candidate: unknown,
): candidate is TaskRecoveryCapsule {
  try {
    if (!isRecoveryCapsule(candidate)) {
      return false;
    }
    const current = buildTaskRecoveryCapsule(task);
    return (
      candidate.fence.schemaVersion === current.fence.schemaVersion &&
      candidate.fence.taskId === current.fence.taskId &&
      candidate.fence.taskVersion === current.fence.taskVersion &&
      candidate.fence.requirementRevisionId === current.fence.requirementRevisionId &&
      candidate.fence.latestPlanRevisionId === current.fence.latestPlanRevisionId &&
      candidate.fence.confirmedPlanRevisionId === current.fence.confirmedPlanRevisionId &&
      candidate.fence.graphRevisionId === current.fence.graphRevisionId &&
      candidate.fence.reconciliationId === current.fence.reconciliationId &&
      candidate.fence.digest === current.fence.digest &&
      candidate.input.text === current.input.text
    );
  } catch {
    return false;
  }
}

function selectRecoveryState(
  requirementRevisionId: string,
  latestPlan: SerializedPlan | null,
  confirmedPlan: SerializedPlan | null,
  graph: SerializedGraph | null,
  reconciliation: TaskReconciliation | null,
): Readonly<{
  phase: RecoveryPhase;
  authoritativePlan: SerializedPlan | null;
  pendingCandidatePlan: SerializedPlan | null;
  historicalConfirmedPlanRevisionId: string | null;
  graph: SerializedGraph | null;
}> {
  const currentLatest =
    latestPlan?.basedOnRequirementRevisionId === requirementRevisionId ? latestPlan : null;
  const currentConfirmed =
    confirmedPlan?.basedOnRequirementRevisionId === requirementRevisionId ? confirmedPlan : null;
  const pendingCandidatePlan = currentLatest?.status === "candidate" ? currentLatest : null;
  let authoritativePlan: SerializedPlan | null = null;
  if (graph !== null) {
    if (
      currentConfirmed === null ||
      currentConfirmed.status !== "confirmed" ||
      graph.basedOnPlanRevisionId !== currentConfirmed.revisionId
    ) {
      throw new TaskRecoveryContextError("invalid_task");
    }
    authoritativePlan = currentConfirmed;
  } else if (currentConfirmed !== null) {
    if (
      currentConfirmed.status !== "confirmed" ||
      (currentLatest?.status === "confirmed" &&
        currentConfirmed.revisionId !== currentLatest.revisionId)
    ) {
      throw new TaskRecoveryContextError("invalid_task");
    }
    authoritativePlan = currentConfirmed;
  }
  if (
    reconciliation !== null &&
    (graph === null ||
      reconciliation.requirementRevisionId !== requirementRevisionId ||
      reconciliation.planRevisionId !== authoritativePlan?.revisionId ||
      reconciliation.graphRevisionId !== graph.revisionId)
  ) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  const phase: RecoveryPhase =
    graph !== null
      ? pendingCandidatePlan === null
        ? "active_graph"
        : "active_graph_with_candidate"
      : pendingCandidatePlan !== null
        ? "candidate_plan"
        : authoritativePlan !== null
          ? "confirmed_plan_pending_graph"
          : "requirements_only";
  return Object.freeze({
    phase,
    authoritativePlan,
    pendingCandidatePlan,
    historicalConfirmedPlanRevisionId:
      confirmedPlan !== null && confirmedPlan.revisionId !== authoritativePlan?.revisionId
        ? confirmedPlan.revisionId
        : null,
    graph,
  });
}

type SerializedPlan = Readonly<{
  revisionId: string;
  revisionNumber: number;
  status: "candidate" | "confirmed";
  basedOnRequirementRevisionId: string;
  steps: readonly Readonly<{
    stepId: string;
    title: string;
    description: string;
    acceptanceCriteria: readonly string[];
  }>[];
}>;

type SerializedGraph = Readonly<{
  revisionId: string;
  revisionNumber: number;
  basedOnPlanRevisionId: string;
  topologicalOrder: readonly string[];
  unfinishedNodes: readonly SerializedUnfinishedNode[];
  terminalNodes: readonly SerializedTerminalNode[];
}>;

type SerializedUnfinishedNode = Readonly<{
  nodeId: string;
  sourcePlanStepId: string;
  status: Exclude<TaskGraphRevision["nodes"][number]["status"], "succeeded" | "cancelled">;
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  dependsOnNodeIds: readonly string[];
}>;

type SerializedTerminalNode = Readonly<{
  nodeId: string;
  status: "succeeded" | "cancelled";
}>;

function serializeRequirement(requirement: RequirementRevision) {
  return Object.freeze({
    revisionId: requireUuid(requirement.revisionId),
    revisionNumber: requirePositiveInteger(requirement.revisionNumber),
    sourceText: requireText(requirement.sourceText),
    objective: requireText(requirement.objective),
    constraints: requireTextArray(requirement.constraints),
    acceptanceCriteria: requireTextArray(requirement.acceptanceCriteria),
  });
}

function serializePlan(plan: PlanRevision): SerializedPlan {
  if (plan.status !== "candidate" && plan.status !== "confirmed") {
    throw new TaskRecoveryContextError("invalid_task");
  }
  const stepIds = new Set<string>();
  const steps = requireArray(plan.steps).map((step) => {
    const stepId = requireUuid(step.stepId);
    if (stepIds.has(stepId)) {
      throw new TaskRecoveryContextError("invalid_task");
    }
    stepIds.add(stepId);
    return Object.freeze({
      stepId,
      title: requireText(step.title),
      description: requireText(step.description),
      acceptanceCriteria: requireTextArray(step.acceptanceCriteria),
    });
  });
  if (steps.length < 1) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return Object.freeze({
    revisionId: requireUuid(plan.revisionId),
    revisionNumber: requirePositiveInteger(plan.revisionNumber),
    status: plan.status,
    basedOnRequirementRevisionId: requireUuid(plan.basedOnRequirementRevisionId),
    steps: Object.freeze(steps),
  });
}

function serializeGraph(graph: TaskGraphRevision): SerializedGraph {
  const nodes = requireArray(graph.nodes);
  const nodeById = new Map(nodes.map((node) => [requireUuid(node.nodeId), node]));
  const topologicalOrder = requireUuidArray(graph.topologicalOrder);
  if (
    nodeById.size !== nodes.length ||
    topologicalOrder.length !== nodes.length ||
    topologicalOrder.some((nodeId) => !nodeById.has(nodeId))
  ) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  const unfinishedNodes: SerializedUnfinishedNode[] = [];
  const terminalNodes: SerializedTerminalNode[] = [];
  for (const nodeId of topologicalOrder) {
    const node = nodeById.get(nodeId);
    if (node === undefined) {
      throw new TaskRecoveryContextError("invalid_task");
    }
    const status = requireNodeStatus(node.status);
    if (status === "succeeded" || status === "cancelled") {
      terminalNodes.push(Object.freeze({ nodeId, status }));
    } else {
      unfinishedNodes.push(
        Object.freeze({
          nodeId,
          sourcePlanStepId: requireUuid(node.sourcePlanStepId),
          status,
          title: requireText(node.title),
          description: requireText(node.description),
          acceptanceCriteria: requireTextArray(node.acceptanceCriteria),
          dependsOnNodeIds: requireUuidArray(node.dependsOnNodeIds),
        }),
      );
    }
  }
  return Object.freeze({
    revisionId: requireUuid(graph.revisionId),
    revisionNumber: requirePositiveInteger(graph.revisionNumber),
    basedOnPlanRevisionId: requireUuid(graph.basedOnPlanRevisionId),
    topologicalOrder,
    unfinishedNodes: Object.freeze(unfinishedNodes),
    terminalNodes: Object.freeze(terminalNodes),
  });
}

function cloneReconciliation(reconciliation: TaskReconciliation): TaskReconciliation {
  if (!validateJsonValue(reconciliation).ok) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return JSON.parse(JSON.stringify(reconciliation)) as TaskReconciliation;
}

function isRecoveryCapsule(input: unknown): input is TaskRecoveryCapsule {
  if (!validateJsonValue(input).ok || !isRecord(input)) {
    return false;
  }
  const fence = input.fence;
  const textInput = input.input;
  return (
    hasExactKeys(input, ["fence", "input"]) &&
    isRecord(fence) &&
    hasExactKeys(fence, [
      "confirmedPlanRevisionId",
      "digest",
      "graphRevisionId",
      "latestPlanRevisionId",
      "reconciliationId",
      "requirementRevisionId",
      "schemaVersion",
      "taskId",
      "taskVersion",
    ]) &&
    fence.schemaVersion === 1 &&
    typeof fence.taskId === "string" &&
    typeof fence.taskVersion === "number" &&
    typeof fence.requirementRevisionId === "string" &&
    (fence.latestPlanRevisionId === null || typeof fence.latestPlanRevisionId === "string") &&
    (fence.confirmedPlanRevisionId === null || typeof fence.confirmedPlanRevisionId === "string") &&
    (fence.graphRevisionId === null || typeof fence.graphRevisionId === "string") &&
    (fence.reconciliationId === null || typeof fence.reconciliationId === "string") &&
    typeof fence.digest === "string" &&
    /^[0-9a-f]{64}$/.test(fence.digest) &&
    isRecord(textInput) &&
    hasExactKeys(textInput, ["text", "text_elements", "type"]) &&
    textInput.type === "text" &&
    typeof textInput.text === "string" &&
    Array.isArray(textInput.text_elements) &&
    textInput.text_elements.length === 0
  );
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function hasExactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(input).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertJsonObject(input: unknown): asserts input is Record<string, unknown> {
  if (!validateJsonValue(input).ok || !isRecord(input)) {
    throw new TaskRecoveryContextError("invalid_task");
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requireArray<T>(input: readonly T[]): readonly T[] {
  if (!Array.isArray(input)) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return input;
}

function requireUuid(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return input;
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return input as number;
}

function requireText(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return input;
}

function requireTextArray(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return Object.freeze(input.map((value) => requireText(value)));
}

function requireUuidArray(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  const values = input.map((value) => requireUuid(value));
  if (new Set(values).size !== values.length) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return Object.freeze(values);
}

function requireNodeStatus(input: unknown): TaskGraphRevision["nodes"][number]["status"] {
  if (
    input !== "pending" &&
    input !== "ready" &&
    input !== "running" &&
    input !== "blocked" &&
    input !== "succeeded" &&
    input !== "failed" &&
    input !== "interrupted" &&
    input !== "cancelled"
  ) {
    throw new TaskRecoveryContextError("invalid_task");
  }
  return input;
}
