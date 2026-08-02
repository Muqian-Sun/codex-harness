import { createHash } from "node:crypto";

import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import type { ModelRouteTaskKind, ModelRouteToolBreadth } from "./model-route-classifier.js";
import {
  MODEL_ROUTE_SAFETY_SIGNAL_NAMES,
  type ModelRouteSafetySignalName,
} from "./shadow-route-feature-snapshot.js";
import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  TaskRecoveryContextError,
  buildTaskRecoveryCapsule,
  type TaskRecoveryFence,
} from "./task-recovery-context.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POLICY_VERSION_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_POLICY_VERSION_CHARACTERS = 128;

export const HARNESS_ROUTE_EVIDENCE_POLICY_VERSION = "harness-route-evidence-policy-v1" as const;

export const HARNESS_ROUTE_TOOL_CLASSES = Object.freeze([
  "workspace_read",
  "workspace_write",
  "command_execution",
  "network_access",
  "credential_access",
  "external_write",
  "user_interaction",
] as const);

export type HarnessRouteToolClass = (typeof HARNESS_ROUTE_TOOL_CLASSES)[number];

export const HARNESS_ROUTE_SAFETY_OBSERVER_SOURCES = Object.freeze([
  "operation_plan",
  "permission_plan",
  "workspace_analysis",
  "runtime_target",
] as const);

export type HarnessRouteSafetyObserverSource =
  (typeof HARNESS_ROUTE_SAFETY_OBSERVER_SOURCES)[number];

export const HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES = Object.freeze({
  operation_plan: Object.freeze([
    "concurrencySensitive",
    "dataMigration",
    "irreversibleOperation",
    "permissionBoundaryChange",
    "productionImpact",
    "publicApiChange",
  ] as const),
  permission_plan: Object.freeze([
    "irreversibleOperation",
    "permissionBoundaryChange",
    "securitySensitive",
  ] as const),
  workspace_analysis: Object.freeze([
    "concurrencySensitive",
    "dataMigration",
    "publicApiChange",
    "securitySensitive",
  ] as const),
  runtime_target: Object.freeze(["productionImpact"] as const),
} satisfies Readonly<
  Record<HarnessRouteSafetyObserverSource, readonly ModelRouteSafetySignalName[]>
>);

export const HARNESS_ROUTE_SAFETY_REQUIRED_SOURCES = Object.freeze({
  securitySensitive: Object.freeze(["permission_plan", "workspace_analysis"] as const),
  dataMigration: Object.freeze(["operation_plan", "workspace_analysis"] as const),
  concurrencySensitive: Object.freeze(["operation_plan", "workspace_analysis"] as const),
  publicApiChange: Object.freeze(["operation_plan", "workspace_analysis"] as const),
  productionImpact: Object.freeze(["operation_plan", "runtime_target"] as const),
  irreversibleOperation: Object.freeze(["operation_plan", "permission_plan"] as const),
  permissionBoundaryChange: Object.freeze(["operation_plan", "permission_plan"] as const),
} satisfies Readonly<
  Record<ModelRouteSafetySignalName, readonly HarnessRouteSafetyObserverSource[]>
>);

export type HarnessRouteTaskClassification = Readonly<{
  source: "harness_task_classifier";
  policyVersion: string;
  taskKind: ModelRouteTaskKind;
}>;

export type HarnessRouteToolPlan = Readonly<{
  source: "harness_tool_planner";
  policyVersion: string;
  complete: true;
  tools: readonly HarnessRouteToolClass[];
}>;

export type HarnessRouteSafetyObservation = "absent" | "present";

export type HarnessRouteSafetyReport = Readonly<{
  source: HarnessRouteSafetyObserverSource;
  policyVersion: string;
  observations: Readonly<
    Partial<Record<ModelRouteSafetySignalName, HarnessRouteSafetyObservation>>
  >;
}>;

export type HarnessRouteEvidenceAuthorityPolicySet = Readonly<{
  taskClassifier: string;
  toolPlanner: string;
  safetyObservers: Readonly<Record<HarnessRouteSafetyObserverSource, string>>;
}>;

export type CreateHarnessRouteEvidenceAuthorityInput = Readonly<{
  schemaVersion: 1;
  authoritySessionId: string;
  policySet: HarnessRouteEvidenceAuthorityPolicySet;
}>;

export type IssueHarnessRouteEvidenceInput = Readonly<{
  schemaVersion: 1;
  evidenceId: string;
  observedAtMs: number;
  taskClassification: HarnessRouteTaskClassification | null;
  toolPlan: HarnessRouteToolPlan | null;
  safetyReports: readonly HarnessRouteSafetyReport[];
}>;

export type HarnessRouteEvidenceResolutionStatus = "observed" | "unresolved";

export type HarnessRouteTaskKindEvidence = Readonly<{
  status: HarnessRouteEvidenceResolutionStatus;
  value: ModelRouteTaskKind | null;
  source: "harness_task_classifier" | null;
  policyVersion: string | null;
}>;

export type HarnessRouteToolBreadthEvidence = Readonly<{
  status: HarnessRouteEvidenceResolutionStatus;
  value: ModelRouteToolBreadth | null;
  source: "harness_tool_planner" | null;
  policyVersion: string | null;
  toolCount: number | null;
}>;

export type HarnessRouteSafetyEvidenceStatus = "absent" | "present" | "unresolved";

export type HarnessRouteSafetyEvidence = Readonly<{
  status: HarnessRouteSafetyEvidenceStatus;
  value: boolean | null;
  observedSources: readonly HarnessRouteSafetyObserverSource[];
  missingSources: readonly HarnessRouteSafetyObserverSource[];
}>;

export type HarnessRouteEvidenceDerived = Readonly<{
  taskKind: HarnessRouteTaskKindEvidence;
  toolBreadth: HarnessRouteToolBreadthEvidence;
  safety: Readonly<Record<ModelRouteSafetySignalName, HarnessRouteSafetyEvidence>>;
  completeForRouting: boolean;
}>;

export type HarnessRouteEvidenceSnapshot = Readonly<{
  schemaVersion: 1;
  mode: "shadow";
  executionAuthorized: false;
  policyVersion: typeof HARNESS_ROUTE_EVIDENCE_POLICY_VERSION;
  authoritySessionId: string;
  authorityPolicySet: HarnessRouteEvidenceAuthorityPolicySet;
  evidenceId: string;
  observedAtMs: number;
  subject: Readonly<{
    taskId: string;
    taskVersion: number;
    nodeId: string | null;
  }>;
  taskFence: TaskRecoveryFence;
  observations: Readonly<{
    taskClassification: HarnessRouteTaskClassification | null;
    toolPlan: HarnessRouteToolPlan | null;
    safetyReports: readonly HarnessRouteSafetyReport[];
  }>;
  derived: HarnessRouteEvidenceDerived;
  evidenceDigest: string;
}>;

export type HarnessRouteEvidenceErrorCode =
  | "invalid_authority"
  | "invalid_observation"
  | "invalid_snapshot"
  | "invalid_task"
  | "node_not_found"
  | "stale_observation";

const ERROR_MESSAGES: Readonly<Record<HarnessRouteEvidenceErrorCode, string>> = Object.freeze({
  invalid_authority: "The Harness route evidence authority is invalid.",
  invalid_observation: "The Harness route evidence observation is invalid.",
  invalid_snapshot: "The Harness route evidence snapshot is invalid.",
  invalid_task: "The authoritative Task route evidence source is invalid.",
  node_not_found: "The route evidence subject node does not exist in the active Task graph.",
  stale_observation: "The route evidence observation predates the current Task state.",
});

export class HarnessRouteEvidenceError extends Error {
  readonly code: HarnessRouteEvidenceErrorCode;

  constructor(code: HarnessRouteEvidenceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessRouteEvidenceError";
    this.code = code;
  }
}

export type HarnessRouteEvidenceAuthority = Readonly<{
  authoritySessionId: string;
  policySet: HarnessRouteEvidenceAuthorityPolicySet;
  issue(
    task: TaskPlanRecord,
    nodeId: string | null,
    input: IssueHarnessRouteEvidenceInput,
  ): HarnessRouteEvidenceSnapshot;
  isVerified(input: unknown): input is HarnessRouteEvidenceSnapshot;
  isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessRouteEvidenceSnapshot;
}>;

export function createHarnessRouteEvidenceAuthority(input: unknown): HarnessRouteEvidenceAuthority {
  let authorityConfig: Readonly<{
    authoritySessionId: string;
    policySet: HarnessRouteEvidenceAuthorityPolicySet;
  }>;
  try {
    authorityConfig = normalizeAuthorityInput(input);
  } catch {
    throw new HarnessRouteEvidenceError("invalid_authority");
  }
  const verifiedSnapshots = new WeakSet<object>();

  return Object.freeze({
    authoritySessionId: authorityConfig.authoritySessionId,
    policySet: authorityConfig.policySet,
    issue(
      task: TaskPlanRecord,
      nodeId: string | null,
      input: IssueHarnessRouteEvidenceInput,
    ): HarnessRouteEvidenceSnapshot {
      const snapshot = buildSnapshotForTask(authorityConfig, task, nodeId, input);
      verifiedSnapshots.add(snapshot);
      return snapshot;
    },
    isVerified(input: unknown): input is HarnessRouteEvidenceSnapshot {
      return typeof input === "object" && input !== null && verifiedSnapshots.has(input);
    },
    isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessRouteEvidenceSnapshot {
      if (typeof input !== "object" || input === null || !verifiedSnapshots.has(input)) {
        return false;
      }
      try {
        const snapshot = input as HarnessRouteEvidenceSnapshot;
        if (
          snapshot.authoritySessionId !== authorityConfig.authoritySessionId ||
          canonicalJson(snapshot.authorityPolicySet as unknown as JsonValue) !==
            canonicalJson(authorityConfig.policySet as unknown as JsonValue)
        ) {
          return false;
        }
        const rebuilt = buildSnapshotForTask(
          authorityConfig,
          task,
          snapshot.subject.nodeId,
          issueInputFromSnapshot(snapshot),
        );
        return (
          canonicalJson(snapshot as unknown as JsonValue) ===
          canonicalJson(rebuilt as unknown as JsonValue)
        );
      } catch {
        return false;
      }
    },
  });
}

export function decodeHarnessRouteEvidenceSnapshot(input: unknown): HarnessRouteEvidenceSnapshot {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessRouteEvidenceError("invalid_snapshot");
    }
    const record = requireExactRecord(
      input,
      [
        "authorityPolicySet",
        "authoritySessionId",
        "derived",
        "evidenceDigest",
        "evidenceId",
        "executionAuthorized",
        "mode",
        "observations",
        "observedAtMs",
        "policyVersion",
        "schemaVersion",
        "subject",
        "taskFence",
      ],
      "invalid_snapshot",
    );
    const subject = requireExactRecord(
      record.subject,
      ["nodeId", "taskId", "taskVersion"],
      "invalid_snapshot",
    );
    const taskFence = decodeTaskFence(record.taskFence);
    const taskId = requireUuid(subject.taskId, "invalid_snapshot");
    const taskVersion = requirePositiveInteger(subject.taskVersion, "invalid_snapshot");
    const nodeId = subject.nodeId === null ? null : requireUuid(subject.nodeId, "invalid_snapshot");
    if (taskId !== taskFence.taskId || taskVersion !== taskFence.taskVersion) {
      throw new HarnessRouteEvidenceError("invalid_snapshot");
    }
    const observations = requireExactRecord(
      record.observations,
      ["safetyReports", "taskClassification", "toolPlan"],
      "invalid_snapshot",
    );
    const authorityPolicySet = normalizeAuthorityPolicySet(
      record.authorityPolicySet,
      "invalid_snapshot",
    );
    const normalizedInput = normalizeIssueInput(
      {
        schemaVersion: record.schemaVersion,
        evidenceId: record.evidenceId,
        observedAtMs: record.observedAtMs,
        taskClassification: observations.taskClassification,
        toolPlan: observations.toolPlan,
        safetyReports: observations.safetyReports,
      },
      "invalid_snapshot",
      authorityPolicySet,
    );
    const expected = materializeSnapshot(
      requireUuid(record.authoritySessionId, "invalid_snapshot"),
      authorityPolicySet,
      taskFence,
      nodeId,
      normalizedInput,
    );
    if (
      record.schemaVersion !== 1 ||
      record.mode !== "shadow" ||
      record.executionAuthorized !== false ||
      record.policyVersion !== HARNESS_ROUTE_EVIDENCE_POLICY_VERSION ||
      typeof record.evidenceDigest !== "string" ||
      !SHA256_PATTERN.test(record.evidenceDigest) ||
      canonicalJson(input as JsonValue) !== canonicalJson(expected as unknown as JsonValue)
    ) {
      throw new HarnessRouteEvidenceError("invalid_snapshot");
    }
    return expected;
  } catch (error: unknown) {
    if (error instanceof HarnessRouteEvidenceError && error.code === "invalid_snapshot") {
      throw error;
    }
    throw new HarnessRouteEvidenceError("invalid_snapshot");
  }
}

function buildSnapshotForTask(
  authorityConfig: Readonly<{
    authoritySessionId: string;
    policySet: HarnessRouteEvidenceAuthorityPolicySet;
  }>,
  task: TaskPlanRecord,
  nodeId: unknown,
  input: unknown,
): HarnessRouteEvidenceSnapshot {
  try {
    const taskFence = cloneTaskFence(buildTaskRecoveryCapsule(task).fence);
    const normalizedNodeId = normalizeNodeId(task, nodeId);
    const normalizedInput = normalizeIssueInput(
      input,
      "invalid_observation",
      authorityConfig.policySet,
    );
    if (normalizedInput.observedAtMs < task.updatedAtMs) {
      throw new HarnessRouteEvidenceError("stale_observation");
    }
    return materializeSnapshot(
      authorityConfig.authoritySessionId,
      authorityConfig.policySet,
      taskFence,
      normalizedNodeId,
      normalizedInput,
    );
  } catch (error: unknown) {
    if (error instanceof HarnessRouteEvidenceError) {
      throw error;
    }
    if (error instanceof TaskRecoveryContextError) {
      throw new HarnessRouteEvidenceError("invalid_task");
    }
    throw new HarnessRouteEvidenceError("invalid_task");
  }
}

function materializeSnapshot(
  authoritySessionId: string,
  authorityPolicySet: HarnessRouteEvidenceAuthorityPolicySet,
  taskFence: TaskRecoveryFence,
  nodeId: string | null,
  input: NormalizedIssueInput,
): HarnessRouteEvidenceSnapshot {
  const observations = Object.freeze({
    taskClassification: input.taskClassification,
    toolPlan: input.toolPlan,
    safetyReports: input.safetyReports,
  });
  const core = Object.freeze({
    schemaVersion: 1 as const,
    mode: "shadow" as const,
    executionAuthorized: false as const,
    policyVersion: HARNESS_ROUTE_EVIDENCE_POLICY_VERSION,
    authoritySessionId,
    authorityPolicySet,
    evidenceId: input.evidenceId,
    observedAtMs: input.observedAtMs,
    subject: Object.freeze({
      taskId: taskFence.taskId,
      taskVersion: taskFence.taskVersion,
      nodeId,
    }),
    taskFence,
    observations,
    derived: deriveEvidence(observations),
  });
  if (!validateJsonValue(core).ok) {
    throw new HarnessRouteEvidenceError("invalid_snapshot");
  }
  const evidenceDigest = createHash("sha256")
    .update(canonicalJson(core as unknown as JsonValue), "utf8")
    .digest("hex");
  return Object.freeze({ ...core, evidenceDigest });
}

type NormalizedIssueInput = Readonly<{
  evidenceId: string;
  observedAtMs: number;
  taskClassification: HarnessRouteTaskClassification | null;
  toolPlan: HarnessRouteToolPlan | null;
  safetyReports: readonly HarnessRouteSafetyReport[];
}>;

function normalizeAuthorityInput(input: unknown): Readonly<{
  authoritySessionId: string;
  policySet: HarnessRouteEvidenceAuthorityPolicySet;
}> {
  if (!validateJsonValue(input).ok) {
    throw new HarnessRouteEvidenceError("invalid_authority");
  }
  const record = requireExactRecord(
    input,
    ["authoritySessionId", "policySet", "schemaVersion"],
    "invalid_authority",
  );
  if (record.schemaVersion !== 1) {
    throw new HarnessRouteEvidenceError("invalid_authority");
  }
  return Object.freeze({
    authoritySessionId: requireUuid(record.authoritySessionId, "invalid_authority"),
    policySet: normalizeAuthorityPolicySet(record.policySet, "invalid_authority"),
  });
}

function normalizeAuthorityPolicySet(
  input: unknown,
  errorCode: "invalid_authority" | "invalid_snapshot",
): HarnessRouteEvidenceAuthorityPolicySet {
  const record = requireExactRecord(
    input,
    ["safetyObservers", "taskClassifier", "toolPlanner"],
    errorCode,
  );
  const safetyObservers = requireExactRecord(
    record.safetyObservers,
    ["operation_plan", "permission_plan", "runtime_target", "workspace_analysis"],
    errorCode,
  );
  return Object.freeze({
    taskClassifier: requirePolicyVersion(record.taskClassifier, errorCode),
    toolPlanner: requirePolicyVersion(record.toolPlanner, errorCode),
    safetyObservers: Object.freeze({
      operation_plan: requirePolicyVersion(safetyObservers.operation_plan, errorCode),
      permission_plan: requirePolicyVersion(safetyObservers.permission_plan, errorCode),
      workspace_analysis: requirePolicyVersion(safetyObservers.workspace_analysis, errorCode),
      runtime_target: requirePolicyVersion(safetyObservers.runtime_target, errorCode),
    }),
  });
}

function normalizeIssueInput(
  input: unknown,
  errorCode: "invalid_observation" | "invalid_snapshot",
  policySet: HarnessRouteEvidenceAuthorityPolicySet,
): NormalizedIssueInput {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessRouteEvidenceError(errorCode);
    }
    const record = requireExactRecord(
      input,
      [
        "evidenceId",
        "observedAtMs",
        "safetyReports",
        "schemaVersion",
        "taskClassification",
        "toolPlan",
      ],
      errorCode,
    );
    if (record.schemaVersion !== 1 || !Array.isArray(record.safetyReports)) {
      throw new HarnessRouteEvidenceError(errorCode);
    }
    if (record.safetyReports.length > HARNESS_ROUTE_SAFETY_OBSERVER_SOURCES.length) {
      throw new HarnessRouteEvidenceError(errorCode);
    }
    const safetyReports = record.safetyReports.map((report) =>
      normalizeSafetyReport(report, errorCode, policySet),
    );
    if (new Set(safetyReports.map((report) => report.source)).size !== safetyReports.length) {
      throw new HarnessRouteEvidenceError(errorCode);
    }
    safetyReports.sort((left, right) => sourceRank(left.source) - sourceRank(right.source));
    return Object.freeze({
      evidenceId: requireUuid(record.evidenceId, errorCode),
      observedAtMs: requireNonNegativeInteger(record.observedAtMs, errorCode),
      taskClassification:
        record.taskClassification === null
          ? null
          : normalizeTaskClassification(
              record.taskClassification,
              errorCode,
              policySet.taskClassifier,
            ),
      toolPlan:
        record.toolPlan === null
          ? null
          : normalizeToolPlan(record.toolPlan, errorCode, policySet.toolPlanner),
      safetyReports: Object.freeze(safetyReports),
    });
  } catch (error: unknown) {
    if (error instanceof HarnessRouteEvidenceError && error.code === errorCode) {
      throw error;
    }
    throw new HarnessRouteEvidenceError(errorCode);
  }
}

function normalizeTaskClassification(
  input: unknown,
  errorCode: "invalid_observation" | "invalid_snapshot",
  expectedPolicyVersion: string,
): HarnessRouteTaskClassification {
  const record = requireExactRecord(input, ["policyVersion", "source", "taskKind"], errorCode);
  if (
    record.source !== "harness_task_classifier" ||
    record.policyVersion !== expectedPolicyVersion
  ) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return Object.freeze({
    source: "harness_task_classifier" as const,
    policyVersion: requirePolicyVersion(record.policyVersion, errorCode),
    taskKind: requireTaskKind(record.taskKind, errorCode),
  });
}

function normalizeToolPlan(
  input: unknown,
  errorCode: "invalid_observation" | "invalid_snapshot",
  expectedPolicyVersion: string,
): HarnessRouteToolPlan {
  const record = requireExactRecord(
    input,
    ["complete", "policyVersion", "source", "tools"],
    errorCode,
  );
  if (
    record.source !== "harness_tool_planner" ||
    record.policyVersion !== expectedPolicyVersion ||
    record.complete !== true ||
    !Array.isArray(record.tools) ||
    record.tools.length > HARNESS_ROUTE_TOOL_CLASSES.length
  ) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  const tools = record.tools.map((tool) => requireToolClass(tool, errorCode));
  if (new Set(tools).size !== tools.length) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  tools.sort((left, right) => toolRank(left) - toolRank(right));
  return Object.freeze({
    source: "harness_tool_planner" as const,
    policyVersion: requirePolicyVersion(record.policyVersion, errorCode),
    complete: true as const,
    tools: Object.freeze(tools),
  });
}

function normalizeSafetyReport(
  input: unknown,
  errorCode: "invalid_observation" | "invalid_snapshot",
  policySet: HarnessRouteEvidenceAuthorityPolicySet,
): HarnessRouteSafetyReport {
  const record = requireExactRecord(input, ["observations", "policyVersion", "source"], errorCode);
  const source = requireSafetySource(record.source, errorCode);
  if (record.policyVersion !== policySet.safetyObservers[source]) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  const expectedSignals = HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES[source];
  const observationsRecord = requireExactRecord(record.observations, expectedSignals, errorCode);
  const observations = Object.freeze(
    Object.fromEntries(
      expectedSignals.map((signal) => [
        signal,
        requireSafetyObservation(observationsRecord[signal], errorCode),
      ]),
    ) as Partial<Record<ModelRouteSafetySignalName, HarnessRouteSafetyObservation>>,
  );
  return Object.freeze({
    source,
    policyVersion: requirePolicyVersion(record.policyVersion, errorCode),
    observations,
  });
}

function deriveEvidence(
  observations: HarnessRouteEvidenceSnapshot["observations"],
): HarnessRouteEvidenceDerived {
  const classification = observations.taskClassification;
  const taskKind: HarnessRouteTaskKindEvidence = Object.freeze({
    status: classification === null ? "unresolved" : "observed",
    value: classification?.taskKind ?? null,
    source: classification?.source ?? null,
    policyVersion: classification?.policyVersion ?? null,
  });
  const toolPlan = observations.toolPlan;
  const toolBreadth: HarnessRouteToolBreadthEvidence = Object.freeze({
    status: toolPlan === null ? "unresolved" : "observed",
    value: toolPlan === null ? null : deriveToolBreadth(toolPlan.tools.length),
    source: toolPlan?.source ?? null,
    policyVersion: toolPlan?.policyVersion ?? null,
    toolCount: toolPlan?.tools.length ?? null,
  });
  const reportsBySource = new Map(
    observations.safetyReports.map((report) => [report.source, report]),
  );
  const safety = Object.freeze(
    Object.fromEntries(
      MODEL_ROUTE_SAFETY_SIGNAL_NAMES.map((signal) => {
        const requiredSources = HARNESS_ROUTE_SAFETY_REQUIRED_SOURCES[signal];
        const observedSources = Object.freeze(
          requiredSources.filter((source) => reportsBySource.has(source)),
        );
        const missingSources = Object.freeze(
          requiredSources.filter((source) => !reportsBySource.has(source)),
        );
        const present = observedSources.some(
          (source) => reportsBySource.get(source)?.observations[signal] === "present",
        );
        const status: HarnessRouteSafetyEvidenceStatus = present
          ? "present"
          : missingSources.length === 0
            ? "absent"
            : "unresolved";
        const evidence: HarnessRouteSafetyEvidence = Object.freeze({
          status,
          value: status === "present" ? true : status === "absent" ? false : null,
          observedSources,
          missingSources,
        });
        return [signal, evidence];
      }),
    ) as Record<ModelRouteSafetySignalName, HarnessRouteSafetyEvidence>,
  );
  return Object.freeze({
    taskKind,
    toolBreadth,
    safety,
    completeForRouting:
      taskKind.status === "observed" &&
      toolBreadth.status === "observed" &&
      MODEL_ROUTE_SAFETY_SIGNAL_NAMES.every((signal) => safety[signal].status !== "unresolved"),
  });
}

function deriveToolBreadth(toolCount: number): ModelRouteToolBreadth {
  if (toolCount === 0) {
    return "none";
  }
  if (toolCount === 1) {
    return "single";
  }
  return toolCount <= 3 ? "multiple" : "extensive";
}

function normalizeNodeId(task: TaskPlanRecord, input: unknown): string | null {
  if (input === null) {
    return null;
  }
  const nodeId = requireUuid(input, "node_not_found");
  if (task.activeGraph === null || !task.activeGraph.nodes.some((node) => node.nodeId === nodeId)) {
    throw new HarnessRouteEvidenceError("node_not_found");
  }
  return nodeId;
}

function issueInputFromSnapshot(
  snapshot: HarnessRouteEvidenceSnapshot,
): IssueHarnessRouteEvidenceInput {
  return {
    schemaVersion: 1,
    evidenceId: snapshot.evidenceId,
    observedAtMs: snapshot.observedAtMs,
    taskClassification: snapshot.observations.taskClassification,
    toolPlan: snapshot.observations.toolPlan,
    safetyReports: snapshot.observations.safetyReports,
  };
}

function decodeTaskFence(input: unknown): TaskRecoveryFence {
  const record = requireExactRecord(
    input,
    [
      "confirmedPlanRevisionId",
      "digest",
      "graphRevisionId",
      "latestPlanRevisionId",
      "reconciliationId",
      "requirementRevisionId",
      "schemaVersion",
      "taskId",
      "taskVersion",
    ],
    "invalid_snapshot",
  );
  if (
    record.schemaVersion !== 1 ||
    typeof record.digest !== "string" ||
    !SHA256_PATTERN.test(record.digest)
  ) {
    throw new HarnessRouteEvidenceError("invalid_snapshot");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    taskId: requireUuid(record.taskId, "invalid_snapshot"),
    taskVersion: requirePositiveInteger(record.taskVersion, "invalid_snapshot"),
    requirementRevisionId: requireUuid(record.requirementRevisionId, "invalid_snapshot"),
    latestPlanRevisionId: requireNullableUuid(record.latestPlanRevisionId, "invalid_snapshot"),
    confirmedPlanRevisionId: requireNullableUuid(
      record.confirmedPlanRevisionId,
      "invalid_snapshot",
    ),
    graphRevisionId: requireNullableUuid(record.graphRevisionId, "invalid_snapshot"),
    reconciliationId: requireNullableUuid(record.reconciliationId, "invalid_snapshot"),
    digest: record.digest,
  });
}

function cloneTaskFence(input: TaskRecoveryFence): TaskRecoveryFence {
  return decodeTaskFence(input);
}

function requireExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  errorCode: HarnessRouteEvidenceErrorCode,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown, errorCode: HarnessRouteEvidenceErrorCode): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input;
}

function requireNullableUuid(
  input: unknown,
  errorCode: HarnessRouteEvidenceErrorCode,
): string | null {
  return input === null ? null : requireUuid(input, errorCode);
}

function requireNonNegativeInteger(
  input: unknown,
  errorCode: HarnessRouteEvidenceErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input as number;
}

function requirePositiveInteger(input: unknown, errorCode: HarnessRouteEvidenceErrorCode): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input as number;
}

function requirePolicyVersion(input: unknown, errorCode: HarnessRouteEvidenceErrorCode): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_POLICY_VERSION_CHARACTERS ||
    !POLICY_VERSION_PATTERN.test(input)
  ) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input;
}

function requireTaskKind(
  input: unknown,
  errorCode: HarnessRouteEvidenceErrorCode,
): ModelRouteTaskKind {
  if (
    input !== "simple" &&
    input !== "code_change" &&
    input !== "analysis" &&
    input !== "architecture" &&
    input !== "systemic_diagnosis"
  ) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input;
}

function requireToolClass(
  input: unknown,
  errorCode: HarnessRouteEvidenceErrorCode,
): HarnessRouteToolClass {
  if (
    typeof input !== "string" ||
    !HARNESS_ROUTE_TOOL_CLASSES.includes(input as HarnessRouteToolClass)
  ) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input as HarnessRouteToolClass;
}

function requireSafetySource(
  input: unknown,
  errorCode: HarnessRouteEvidenceErrorCode,
): HarnessRouteSafetyObserverSource {
  if (
    typeof input !== "string" ||
    !HARNESS_ROUTE_SAFETY_OBSERVER_SOURCES.includes(input as HarnessRouteSafetyObserverSource)
  ) {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input as HarnessRouteSafetyObserverSource;
}

function requireSafetyObservation(
  input: unknown,
  errorCode: HarnessRouteEvidenceErrorCode,
): HarnessRouteSafetyObservation {
  if (input !== "absent" && input !== "present") {
    throw new HarnessRouteEvidenceError(errorCode);
  }
  return input;
}

function sourceRank(source: HarnessRouteSafetyObserverSource): number {
  return HARNESS_ROUTE_SAFETY_OBSERVER_SOURCES.indexOf(source);
}

function toolRank(tool: HarnessRouteToolClass): number {
  return HARNESS_ROUTE_TOOL_CLASSES.indexOf(tool);
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
