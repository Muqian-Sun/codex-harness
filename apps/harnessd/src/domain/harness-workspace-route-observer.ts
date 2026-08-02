import { createHash } from "node:crypto";

import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import {
  HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES,
  type HarnessRouteSafetyReport,
} from "./harness-route-evidence.js";
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
const MAX_WORKSPACE_FINDINGS = 512;

export const HARNESS_WORKSPACE_ROUTE_OBSERVER_POLICY_VERSION =
  "harness-workspace-route-observer-policy-v1" as const;

export const HARNESS_WORKSPACE_FINDING_KINDS = Object.freeze([
  "shared_mutable_state_change",
  "concurrent_resource_access_change",
  "database_schema_change",
  "persistent_data_rewrite",
  "exported_api_change",
  "protocol_contract_change",
  "authentication_authorization_change",
  "credential_handling_change",
  "cryptographic_change",
  "security_boundary_change",
] as const);

export type HarnessWorkspaceFindingKind = (typeof HARNESS_WORKSPACE_FINDING_KINDS)[number];

export type HarnessWorkspaceFinding = Readonly<{
  findingId: string;
  kind: HarnessWorkspaceFindingKind;
}>;

export type HarnessWorkspaceRouteObserverPolicySet = Readonly<{
  workspaceAnalysis: string;
}>;

export type CreateHarnessWorkspaceRouteObserverInput = Readonly<{
  schemaVersion: 1;
  observerSessionId: string;
  policySet: HarnessWorkspaceRouteObserverPolicySet;
}>;

export type ObserveHarnessWorkspaceRouteInput = Readonly<{
  schemaVersion: 1;
  analysisId: string;
  workspaceSnapshotId: string;
  workspaceDigest: string;
  observedAtMs: number;
  complete: true;
  findings: readonly HarnessWorkspaceFinding[];
}>;

export type HarnessWorkspaceAnalysisSafetyReport = HarnessRouteSafetyReport &
  Readonly<{ source: "workspace_analysis" }>;

export type HarnessWorkspaceRouteObservation = Readonly<{
  schemaVersion: 1;
  mode: "shadow";
  executionAuthorized: false;
  policyVersion: typeof HARNESS_WORKSPACE_ROUTE_OBSERVER_POLICY_VERSION;
  observerSessionId: string;
  observerPolicySet: HarnessWorkspaceRouteObserverPolicySet;
  analysisId: string;
  workspaceSnapshotId: string;
  workspaceDigest: string;
  observedAtMs: number;
  complete: true;
  subject: Readonly<{
    taskId: string;
    taskVersion: number;
    nodeId: string | null;
  }>;
  taskFence: TaskRecoveryFence;
  findings: readonly HarnessWorkspaceFinding[];
  workspaceAnalysisSafetyReport: HarnessWorkspaceAnalysisSafetyReport;
  observationDigest: string;
}>;

export type HarnessWorkspaceRouteObserverErrorCode =
  | "invalid_observer"
  | "invalid_workspace_analysis"
  | "invalid_snapshot"
  | "invalid_task"
  | "node_not_found"
  | "stale_observation";

const ERROR_MESSAGES: Readonly<Record<HarnessWorkspaceRouteObserverErrorCode, string>> =
  Object.freeze({
    invalid_observer: "The Harness workspace route observer is invalid.",
    invalid_workspace_analysis: "The complete Harness workspace analysis is invalid.",
    invalid_snapshot: "The Harness workspace route observation is invalid.",
    invalid_task: "The authoritative Task workspace route source is invalid.",
    node_not_found: "The workspace route subject node does not exist in the active Task graph.",
    stale_observation: "The workspace route observation predates the current Task state.",
  });

export class HarnessWorkspaceRouteObserverError extends Error {
  readonly code: HarnessWorkspaceRouteObserverErrorCode;

  constructor(code: HarnessWorkspaceRouteObserverErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessWorkspaceRouteObserverError";
    this.code = code;
  }
}

export type HarnessWorkspaceRouteObserver = Readonly<{
  observerSessionId: string;
  policySet: HarnessWorkspaceRouteObserverPolicySet;
  observe(
    task: TaskPlanRecord,
    nodeId: string | null,
    input: ObserveHarnessWorkspaceRouteInput,
  ): HarnessWorkspaceRouteObservation;
  isVerified(input: unknown): input is HarnessWorkspaceRouteObservation;
  isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessWorkspaceRouteObservation;
}>;

export function createHarnessWorkspaceRouteObserver(input: unknown): HarnessWorkspaceRouteObserver {
  let observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessWorkspaceRouteObserverPolicySet;
  }>;
  try {
    observerConfig = normalizeObserverInput(input);
  } catch {
    throw new HarnessWorkspaceRouteObserverError("invalid_observer");
  }
  const verifiedObservations = new WeakSet<object>();

  return Object.freeze({
    observerSessionId: observerConfig.observerSessionId,
    policySet: observerConfig.policySet,
    observe(
      task: TaskPlanRecord,
      nodeId: string | null,
      input: ObserveHarnessWorkspaceRouteInput,
    ): HarnessWorkspaceRouteObservation {
      const observation = buildObservationForTask(observerConfig, task, nodeId, input);
      verifiedObservations.add(observation);
      return observation;
    },
    isVerified(input: unknown): input is HarnessWorkspaceRouteObservation {
      return typeof input === "object" && input !== null && verifiedObservations.has(input);
    },
    isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessWorkspaceRouteObservation {
      if (typeof input !== "object" || input === null || !verifiedObservations.has(input)) {
        return false;
      }
      try {
        const observation = input as HarnessWorkspaceRouteObservation;
        if (
          observation.observerSessionId !== observerConfig.observerSessionId ||
          canonicalJson(observation.observerPolicySet as unknown as JsonValue) !==
            canonicalJson(observerConfig.policySet as unknown as JsonValue)
        ) {
          return false;
        }
        const rebuilt = buildObservationForTask(
          observerConfig,
          task,
          observation.subject.nodeId,
          workspaceAnalysisInputFromObservation(observation),
        );
        return (
          canonicalJson(observation as unknown as JsonValue) ===
          canonicalJson(rebuilt as unknown as JsonValue)
        );
      } catch {
        return false;
      }
    },
  });
}

export function decodeHarnessWorkspaceRouteObservation(
  input: unknown,
): HarnessWorkspaceRouteObservation {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessWorkspaceRouteObserverError("invalid_snapshot");
    }
    const record = requireExactRecord(
      input,
      [
        "analysisId",
        "complete",
        "executionAuthorized",
        "findings",
        "mode",
        "observationDigest",
        "observedAtMs",
        "observerPolicySet",
        "observerSessionId",
        "policyVersion",
        "schemaVersion",
        "subject",
        "taskFence",
        "workspaceAnalysisSafetyReport",
        "workspaceDigest",
        "workspaceSnapshotId",
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
      throw new HarnessWorkspaceRouteObserverError("invalid_snapshot");
    }
    const policySet = normalizePolicySet(record.observerPolicySet, "invalid_snapshot");
    const analysis = normalizeWorkspaceAnalysisInput(
      {
        schemaVersion: record.schemaVersion,
        analysisId: record.analysisId,
        workspaceSnapshotId: record.workspaceSnapshotId,
        workspaceDigest: record.workspaceDigest,
        observedAtMs: record.observedAtMs,
        complete: record.complete,
        findings: record.findings,
      },
      "invalid_snapshot",
    );
    const expected = materializeObservation(
      requireUuid(record.observerSessionId, "invalid_snapshot"),
      policySet,
      taskFence,
      nodeId,
      analysis,
    );
    if (
      record.schemaVersion !== 1 ||
      record.mode !== "shadow" ||
      record.executionAuthorized !== false ||
      record.policyVersion !== HARNESS_WORKSPACE_ROUTE_OBSERVER_POLICY_VERSION ||
      typeof record.observationDigest !== "string" ||
      !SHA256_PATTERN.test(record.observationDigest) ||
      canonicalJson(input as JsonValue) !== canonicalJson(expected as unknown as JsonValue)
    ) {
      throw new HarnessWorkspaceRouteObserverError("invalid_snapshot");
    }
    return expected;
  } catch (error: unknown) {
    if (error instanceof HarnessWorkspaceRouteObserverError && error.code === "invalid_snapshot") {
      throw error;
    }
    throw new HarnessWorkspaceRouteObserverError("invalid_snapshot");
  }
}

function buildObservationForTask(
  observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessWorkspaceRouteObserverPolicySet;
  }>,
  task: TaskPlanRecord,
  nodeId: unknown,
  input: unknown,
): HarnessWorkspaceRouteObservation {
  try {
    const updatedAtMs = requireNonNegativeInteger(task.updatedAtMs, "invalid_task");
    const taskFence = cloneTaskFence(buildTaskRecoveryCapsule(task).fence);
    const normalizedNodeId = normalizeNodeId(task, nodeId);
    const analysis = normalizeWorkspaceAnalysisInput(input, "invalid_workspace_analysis");
    if (analysis.observedAtMs < updatedAtMs) {
      throw new HarnessWorkspaceRouteObserverError("stale_observation");
    }
    return materializeObservation(
      observerConfig.observerSessionId,
      observerConfig.policySet,
      taskFence,
      normalizedNodeId,
      analysis,
    );
  } catch (error: unknown) {
    if (error instanceof HarnessWorkspaceRouteObserverError) {
      throw error;
    }
    if (error instanceof TaskRecoveryContextError) {
      throw new HarnessWorkspaceRouteObserverError("invalid_task");
    }
    throw new HarnessWorkspaceRouteObserverError("invalid_task");
  }
}

type NormalizedWorkspaceAnalysis = Readonly<{
  analysisId: string;
  workspaceSnapshotId: string;
  workspaceDigest: string;
  observedAtMs: number;
  complete: true;
  findings: readonly HarnessWorkspaceFinding[];
}>;

function materializeObservation(
  observerSessionId: string,
  observerPolicySet: HarnessWorkspaceRouteObserverPolicySet,
  taskFence: TaskRecoveryFence,
  nodeId: string | null,
  analysis: NormalizedWorkspaceAnalysis,
): HarnessWorkspaceRouteObservation {
  const workspaceAnalysisSafetyReport = deriveWorkspaceAnalysisSafetyReport(
    analysis.findings,
    observerPolicySet.workspaceAnalysis,
  );
  const core = Object.freeze({
    schemaVersion: 1 as const,
    mode: "shadow" as const,
    executionAuthorized: false as const,
    policyVersion: HARNESS_WORKSPACE_ROUTE_OBSERVER_POLICY_VERSION,
    observerSessionId,
    observerPolicySet,
    analysisId: analysis.analysisId,
    workspaceSnapshotId: analysis.workspaceSnapshotId,
    workspaceDigest: analysis.workspaceDigest,
    observedAtMs: analysis.observedAtMs,
    complete: true as const,
    subject: Object.freeze({
      taskId: taskFence.taskId,
      taskVersion: taskFence.taskVersion,
      nodeId,
    }),
    taskFence,
    findings: analysis.findings,
    workspaceAnalysisSafetyReport,
  });
  if (!validateJsonValue(core).ok) {
    throw new HarnessWorkspaceRouteObserverError("invalid_snapshot");
  }
  const observationDigest = createHash("sha256")
    .update(canonicalJson(core as unknown as JsonValue), "utf8")
    .digest("hex");
  return Object.freeze({ ...core, observationDigest });
}

function normalizeObserverInput(input: unknown): Readonly<{
  observerSessionId: string;
  policySet: HarnessWorkspaceRouteObserverPolicySet;
}> {
  if (!validateJsonValue(input).ok) {
    throw new HarnessWorkspaceRouteObserverError("invalid_observer");
  }
  const record = requireExactRecord(
    input,
    ["observerSessionId", "policySet", "schemaVersion"],
    "invalid_observer",
  );
  if (record.schemaVersion !== 1) {
    throw new HarnessWorkspaceRouteObserverError("invalid_observer");
  }
  return Object.freeze({
    observerSessionId: requireUuid(record.observerSessionId, "invalid_observer"),
    policySet: normalizePolicySet(record.policySet, "invalid_observer"),
  });
}

function normalizePolicySet(
  input: unknown,
  errorCode: "invalid_observer" | "invalid_snapshot",
): HarnessWorkspaceRouteObserverPolicySet {
  const record = requireExactRecord(input, ["workspaceAnalysis"], errorCode);
  return Object.freeze({
    workspaceAnalysis: requirePolicyVersion(record.workspaceAnalysis, errorCode),
  });
}

function normalizeWorkspaceAnalysisInput(
  input: unknown,
  errorCode: "invalid_workspace_analysis" | "invalid_snapshot",
): NormalizedWorkspaceAnalysis {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessWorkspaceRouteObserverError(errorCode);
    }
    const record = requireExactRecord(
      input,
      [
        "analysisId",
        "complete",
        "findings",
        "observedAtMs",
        "schemaVersion",
        "workspaceDigest",
        "workspaceSnapshotId",
      ],
      errorCode,
    );
    if (
      record.schemaVersion !== 1 ||
      record.complete !== true ||
      !Array.isArray(record.findings) ||
      record.findings.length > MAX_WORKSPACE_FINDINGS
    ) {
      throw new HarnessWorkspaceRouteObserverError(errorCode);
    }
    const findings = record.findings.map((finding) => normalizeFinding(finding, errorCode));
    if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length) {
      throw new HarnessWorkspaceRouteObserverError(errorCode);
    }
    return Object.freeze({
      analysisId: requireUuid(record.analysisId, errorCode),
      workspaceSnapshotId: requireUuid(record.workspaceSnapshotId, errorCode),
      workspaceDigest: requireSha256(record.workspaceDigest, errorCode),
      observedAtMs: requireNonNegativeInteger(record.observedAtMs, errorCode),
      complete: true as const,
      findings: Object.freeze(findings),
    });
  } catch (error: unknown) {
    if (error instanceof HarnessWorkspaceRouteObserverError && error.code === errorCode) {
      throw error;
    }
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
}

function normalizeFinding(
  input: unknown,
  errorCode: "invalid_workspace_analysis" | "invalid_snapshot",
): HarnessWorkspaceFinding {
  const record = requireExactRecord(input, ["findingId", "kind"], errorCode);
  return Object.freeze({
    findingId: requireUuid(record.findingId, errorCode),
    kind: requireWorkspaceFindingKind(record.kind, errorCode),
  });
}

function deriveWorkspaceAnalysisSafetyReport(
  findings: readonly HarnessWorkspaceFinding[],
  policyVersion: string,
): HarnessWorkspaceAnalysisSafetyReport {
  const kinds = new Set(findings.map((finding) => finding.kind));
  const observations = Object.freeze(
    Object.fromEntries(
      HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES.workspace_analysis.map((signal) => [
        signal,
        WORKSPACE_SIGNAL_FINDING_KINDS[signal].some((kind) => kinds.has(kind))
          ? "present"
          : "absent",
      ]),
    ) as HarnessRouteSafetyReport["observations"],
  );
  return Object.freeze({
    source: "workspace_analysis" as const,
    policyVersion,
    observations,
  });
}

const WORKSPACE_SIGNAL_FINDING_KINDS = Object.freeze({
  concurrencySensitive: Object.freeze([
    "shared_mutable_state_change",
    "concurrent_resource_access_change",
  ]),
  dataMigration: Object.freeze(["database_schema_change", "persistent_data_rewrite"]),
  publicApiChange: Object.freeze(["exported_api_change", "protocol_contract_change"]),
  securitySensitive: Object.freeze([
    "authentication_authorization_change",
    "credential_handling_change",
    "cryptographic_change",
    "security_boundary_change",
  ]),
} as const satisfies Readonly<
  Record<
    (typeof HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES.workspace_analysis)[number],
    readonly HarnessWorkspaceFindingKind[]
  >
>);

function normalizeNodeId(task: TaskPlanRecord, input: unknown): string | null {
  if (input === null) {
    return null;
  }
  const nodeId = requireUuid(input, "node_not_found");
  if (task.activeGraph === null || !task.activeGraph.nodes.some((node) => node.nodeId === nodeId)) {
    throw new HarnessWorkspaceRouteObserverError("node_not_found");
  }
  return nodeId;
}

function workspaceAnalysisInputFromObservation(
  observation: HarnessWorkspaceRouteObservation,
): ObserveHarnessWorkspaceRouteInput {
  return {
    schemaVersion: 1,
    analysisId: observation.analysisId,
    workspaceSnapshotId: observation.workspaceSnapshotId,
    workspaceDigest: observation.workspaceDigest,
    observedAtMs: observation.observedAtMs,
    complete: true,
    findings: observation.findings,
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
    throw new HarnessWorkspaceRouteObserverError("invalid_snapshot");
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
  errorCode: HarnessWorkspaceRouteObserverErrorCode,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown, errorCode: HarnessWorkspaceRouteObserverErrorCode): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  return input;
}

function requireNullableUuid(
  input: unknown,
  errorCode: HarnessWorkspaceRouteObserverErrorCode,
): string | null {
  return input === null ? null : requireUuid(input, errorCode);
}

function requireSha256(input: unknown, errorCode: HarnessWorkspaceRouteObserverErrorCode): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  return input;
}

function requireNonNegativeInteger(
  input: unknown,
  errorCode: HarnessWorkspaceRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePositiveInteger(
  input: unknown,
  errorCode: HarnessWorkspaceRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePolicyVersion(
  input: unknown,
  errorCode: HarnessWorkspaceRouteObserverErrorCode,
): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_POLICY_VERSION_CHARACTERS ||
    !POLICY_VERSION_PATTERN.test(input)
  ) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  return input;
}

function requireWorkspaceFindingKind(
  input: unknown,
  errorCode: HarnessWorkspaceRouteObserverErrorCode,
): HarnessWorkspaceFindingKind {
  if (
    typeof input !== "string" ||
    !HARNESS_WORKSPACE_FINDING_KINDS.includes(input as HarnessWorkspaceFindingKind)
  ) {
    throw new HarnessWorkspaceRouteObserverError(errorCode);
  }
  return input as HarnessWorkspaceFindingKind;
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
