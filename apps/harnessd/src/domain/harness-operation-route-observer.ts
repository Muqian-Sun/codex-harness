import { createHash } from "node:crypto";

import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";

import type { ModelRouteTaskKind } from "./model-route-classifier.js";
import {
  HarnessRouteOperationValidationError,
  normalizeHarnessRouteOperations,
  type HarnessRouteOperation,
  type HarnessRouteOperationKind,
} from "./harness-route-operation.js";
import {
  HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES,
  HARNESS_ROUTE_TOOL_CLASSES,
  type HarnessRouteSafetyReport,
  type HarnessRouteTaskClassification,
  type HarnessRouteToolClass,
  type HarnessRouteToolPlan,
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

export const HARNESS_OPERATION_ROUTE_OBSERVER_POLICY_VERSION =
  "harness-operation-route-observer-policy-v1" as const;

export {
  HARNESS_ROUTE_OPERATION_KINDS,
  type HarnessRouteOperation,
  type HarnessRouteOperationKind,
} from "./harness-route-operation.js";

export type HarnessOperationRouteObserverPolicySet = Readonly<{
  taskClassifier: string;
  toolPlanner: string;
  operationPlan: string;
}>;

export type CreateHarnessOperationRouteObserverInput = Readonly<{
  schemaVersion: 1;
  observerSessionId: string;
  policySet: HarnessOperationRouteObserverPolicySet;
}>;

export type ObserveHarnessOperationRouteInput = Readonly<{
  schemaVersion: 1;
  manifestId: string;
  observedAtMs: number;
  operations: readonly HarnessRouteOperation[];
}>;

export type HarnessOperationRouteEvidence = Readonly<{
  taskClassification: HarnessRouteTaskClassification;
  toolPlan: HarnessRouteToolPlan;
  operationPlanSafetyReport: HarnessRouteSafetyReport & Readonly<{ source: "operation_plan" }>;
}>;

export type HarnessOperationRouteObservation = Readonly<{
  schemaVersion: 1;
  mode: "shadow";
  executionAuthorized: false;
  policyVersion: typeof HARNESS_OPERATION_ROUTE_OBSERVER_POLICY_VERSION;
  observerSessionId: string;
  observerPolicySet: HarnessOperationRouteObserverPolicySet;
  manifestId: string;
  observedAtMs: number;
  subject: Readonly<{
    taskId: string;
    taskVersion: number;
    nodeId: string | null;
  }>;
  taskFence: TaskRecoveryFence;
  operations: readonly HarnessRouteOperation[];
  routeEvidence: HarnessOperationRouteEvidence;
  observationDigest: string;
}>;

export type HarnessOperationRouteObserverErrorCode =
  | "invalid_observer"
  | "invalid_manifest"
  | "invalid_snapshot"
  | "invalid_task"
  | "node_not_found"
  | "stale_observation";

const ERROR_MESSAGES: Readonly<Record<HarnessOperationRouteObserverErrorCode, string>> =
  Object.freeze({
    invalid_observer: "The Harness operation route observer is invalid.",
    invalid_manifest: "The closed Harness operation manifest is invalid.",
    invalid_snapshot: "The Harness operation route observation is invalid.",
    invalid_task: "The authoritative Task operation route source is invalid.",
    node_not_found: "The operation route subject node does not exist in the active Task graph.",
    stale_observation: "The operation route observation predates the current Task state.",
  });

export class HarnessOperationRouteObserverError extends Error {
  readonly code: HarnessOperationRouteObserverErrorCode;

  constructor(code: HarnessOperationRouteObserverErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessOperationRouteObserverError";
    this.code = code;
  }
}

export type HarnessOperationRouteObserver = Readonly<{
  observerSessionId: string;
  policySet: HarnessOperationRouteObserverPolicySet;
  observe(
    task: TaskPlanRecord,
    nodeId: string | null,
    input: ObserveHarnessOperationRouteInput,
  ): HarnessOperationRouteObservation;
  isVerified(input: unknown): input is HarnessOperationRouteObservation;
  isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessOperationRouteObservation;
}>;

export function createHarnessOperationRouteObserver(input: unknown): HarnessOperationRouteObserver {
  let observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessOperationRouteObserverPolicySet;
  }>;
  try {
    observerConfig = normalizeObserverInput(input);
  } catch {
    throw new HarnessOperationRouteObserverError("invalid_observer");
  }
  const verifiedObservations = new WeakSet<object>();

  return Object.freeze({
    observerSessionId: observerConfig.observerSessionId,
    policySet: observerConfig.policySet,
    observe(
      task: TaskPlanRecord,
      nodeId: string | null,
      input: ObserveHarnessOperationRouteInput,
    ): HarnessOperationRouteObservation {
      const observation = buildObservationForTask(observerConfig, task, nodeId, input);
      verifiedObservations.add(observation);
      return observation;
    },
    isVerified(input: unknown): input is HarnessOperationRouteObservation {
      return typeof input === "object" && input !== null && verifiedObservations.has(input);
    },
    isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessOperationRouteObservation {
      if (typeof input !== "object" || input === null || !verifiedObservations.has(input)) {
        return false;
      }
      try {
        const observation = input as HarnessOperationRouteObservation;
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
          manifestInputFromObservation(observation),
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

export function decodeHarnessOperationRouteObservation(
  input: unknown,
): HarnessOperationRouteObservation {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessOperationRouteObserverError("invalid_snapshot");
    }
    const record = requireExactRecord(
      input,
      [
        "executionAuthorized",
        "manifestId",
        "mode",
        "observationDigest",
        "observedAtMs",
        "observerPolicySet",
        "observerSessionId",
        "operations",
        "policyVersion",
        "routeEvidence",
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
      throw new HarnessOperationRouteObserverError("invalid_snapshot");
    }
    const policySet = normalizePolicySet(record.observerPolicySet, "invalid_snapshot");
    const manifest = normalizeManifestInput(
      {
        schemaVersion: record.schemaVersion,
        manifestId: record.manifestId,
        observedAtMs: record.observedAtMs,
        operations: record.operations,
      },
      "invalid_snapshot",
    );
    const expected = materializeObservation(
      requireUuid(record.observerSessionId, "invalid_snapshot"),
      policySet,
      taskFence,
      nodeId,
      manifest,
    );
    if (
      record.schemaVersion !== 1 ||
      record.mode !== "shadow" ||
      record.executionAuthorized !== false ||
      record.policyVersion !== HARNESS_OPERATION_ROUTE_OBSERVER_POLICY_VERSION ||
      typeof record.observationDigest !== "string" ||
      !SHA256_PATTERN.test(record.observationDigest) ||
      canonicalJson(input as JsonValue) !== canonicalJson(expected as unknown as JsonValue)
    ) {
      throw new HarnessOperationRouteObserverError("invalid_snapshot");
    }
    return expected;
  } catch (error: unknown) {
    if (error instanceof HarnessOperationRouteObserverError && error.code === "invalid_snapshot") {
      throw error;
    }
    throw new HarnessOperationRouteObserverError("invalid_snapshot");
  }
}

function buildObservationForTask(
  observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessOperationRouteObserverPolicySet;
  }>,
  task: TaskPlanRecord,
  nodeId: unknown,
  input: unknown,
): HarnessOperationRouteObservation {
  try {
    const updatedAtMs = requireNonNegativeInteger(task.updatedAtMs, "invalid_task");
    const taskFence = cloneTaskFence(buildTaskRecoveryCapsule(task).fence);
    const normalizedNodeId = normalizeNodeId(task, nodeId);
    const manifest = normalizeManifestInput(input, "invalid_manifest");
    if (manifest.observedAtMs < updatedAtMs) {
      throw new HarnessOperationRouteObserverError("stale_observation");
    }
    return materializeObservation(
      observerConfig.observerSessionId,
      observerConfig.policySet,
      taskFence,
      normalizedNodeId,
      manifest,
    );
  } catch (error: unknown) {
    if (error instanceof HarnessOperationRouteObserverError) {
      throw error;
    }
    if (error instanceof TaskRecoveryContextError) {
      throw new HarnessOperationRouteObserverError("invalid_task");
    }
    throw new HarnessOperationRouteObserverError("invalid_task");
  }
}

type NormalizedManifest = Readonly<{
  manifestId: string;
  observedAtMs: number;
  operations: readonly HarnessRouteOperation[];
}>;

function materializeObservation(
  observerSessionId: string,
  observerPolicySet: HarnessOperationRouteObserverPolicySet,
  taskFence: TaskRecoveryFence,
  nodeId: string | null,
  manifest: NormalizedManifest,
): HarnessOperationRouteObservation {
  const routeEvidence = deriveRouteEvidence(manifest.operations, observerPolicySet);
  const core = Object.freeze({
    schemaVersion: 1 as const,
    mode: "shadow" as const,
    executionAuthorized: false as const,
    policyVersion: HARNESS_OPERATION_ROUTE_OBSERVER_POLICY_VERSION,
    observerSessionId,
    observerPolicySet,
    manifestId: manifest.manifestId,
    observedAtMs: manifest.observedAtMs,
    subject: Object.freeze({
      taskId: taskFence.taskId,
      taskVersion: taskFence.taskVersion,
      nodeId,
    }),
    taskFence,
    operations: manifest.operations,
    routeEvidence,
  });
  if (!validateJsonValue(core).ok) {
    throw new HarnessOperationRouteObserverError("invalid_snapshot");
  }
  const observationDigest = createHash("sha256")
    .update(canonicalJson(core as unknown as JsonValue), "utf8")
    .digest("hex");
  return Object.freeze({ ...core, observationDigest });
}

function normalizeObserverInput(input: unknown): Readonly<{
  observerSessionId: string;
  policySet: HarnessOperationRouteObserverPolicySet;
}> {
  if (!validateJsonValue(input).ok) {
    throw new HarnessOperationRouteObserverError("invalid_observer");
  }
  const record = requireExactRecord(
    input,
    ["observerSessionId", "policySet", "schemaVersion"],
    "invalid_observer",
  );
  if (record.schemaVersion !== 1) {
    throw new HarnessOperationRouteObserverError("invalid_observer");
  }
  return Object.freeze({
    observerSessionId: requireUuid(record.observerSessionId, "invalid_observer"),
    policySet: normalizePolicySet(record.policySet, "invalid_observer"),
  });
}

function normalizePolicySet(
  input: unknown,
  errorCode: "invalid_observer" | "invalid_snapshot",
): HarnessOperationRouteObserverPolicySet {
  const record = requireExactRecord(
    input,
    ["operationPlan", "taskClassifier", "toolPlanner"],
    errorCode,
  );
  return Object.freeze({
    taskClassifier: requirePolicyVersion(record.taskClassifier, errorCode),
    toolPlanner: requirePolicyVersion(record.toolPlanner, errorCode),
    operationPlan: requirePolicyVersion(record.operationPlan, errorCode),
  });
}

function normalizeManifestInput(
  input: unknown,
  errorCode: "invalid_manifest" | "invalid_snapshot",
): NormalizedManifest {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessOperationRouteObserverError(errorCode);
    }
    const record = requireExactRecord(
      input,
      ["manifestId", "observedAtMs", "operations", "schemaVersion"],
      errorCode,
    );
    if (record.schemaVersion !== 1 || !Array.isArray(record.operations)) {
      throw new HarnessOperationRouteObserverError(errorCode);
    }
    const operations = normalizeHarnessRouteOperations(record.operations);
    return Object.freeze({
      manifestId: requireUuid(record.manifestId, errorCode),
      observedAtMs: requireNonNegativeInteger(record.observedAtMs, errorCode),
      operations,
    });
  } catch (error: unknown) {
    if (error instanceof HarnessOperationRouteObserverError && error.code === errorCode) {
      throw error;
    }
    if (error instanceof HarnessRouteOperationValidationError) {
      throw new HarnessOperationRouteObserverError(errorCode);
    }
    throw new HarnessOperationRouteObserverError(errorCode);
  }
}

function deriveRouteEvidence(
  operations: readonly HarnessRouteOperation[],
  policySet: HarnessOperationRouteObserverPolicySet,
): HarnessOperationRouteEvidence {
  const kinds = new Set(operations.map((operation) => operation.kind));
  const taskClassification = Object.freeze({
    source: "harness_task_classifier" as const,
    policyVersion: policySet.taskClassifier,
    taskKind: deriveTaskKind(kinds),
  });
  const toolSet = new Set<HarnessRouteToolClass>();
  for (const operation of operations) {
    for (const tool of OPERATION_TOOL_CLASSES[operation.kind]) {
      toolSet.add(tool);
    }
  }
  const tools = Object.freeze(HARNESS_ROUTE_TOOL_CLASSES.filter((tool) => toolSet.has(tool)));
  const toolPlan = Object.freeze({
    source: "harness_tool_planner" as const,
    policyVersion: policySet.toolPlanner,
    complete: true as const,
    tools,
  });
  const observations = Object.freeze(
    Object.fromEntries(
      HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES.operation_plan.map((signal) => [
        signal,
        kinds.has(SAFETY_SIGNAL_OPERATION_KIND[signal]) ? "present" : "absent",
      ]),
    ) as HarnessRouteSafetyReport["observations"],
  );
  const operationPlanSafetyReport = Object.freeze({
    source: "operation_plan" as const,
    policyVersion: policySet.operationPlan,
    observations,
  });
  return Object.freeze({
    taskClassification,
    toolPlan,
    operationPlanSafetyReport,
  });
}

function deriveTaskKind(kinds: ReadonlySet<HarnessRouteOperationKind>): ModelRouteTaskKind {
  if (kinds.has("systemic_diagnosis")) {
    return "systemic_diagnosis";
  }
  if (kinds.has("architecture_decision")) {
    return "architecture";
  }
  if (CODE_CHANGE_OPERATION_KINDS.some((kind) => kinds.has(kind))) {
    return "code_change";
  }
  if (ANALYSIS_OPERATION_KINDS.some((kind) => kinds.has(kind))) {
    return "analysis";
  }
  return "simple";
}

const CODE_CHANGE_OPERATION_KINDS = Object.freeze([
  "modify_workspace",
  "database_migration",
  "production_change",
  "irreversible_action",
  "permission_boundary_change",
  "public_api_change",
  "concurrent_change",
] as const satisfies readonly HarnessRouteOperationKind[]);

const ANALYSIS_OPERATION_KINDS = Object.freeze([
  "inspect_workspace",
  "run_workspace_command",
  "network_read",
  "credential_access",
  "external_write",
] as const satisfies readonly HarnessRouteOperationKind[]);

const OPERATION_TOOL_CLASSES = Object.freeze({
  answer: Object.freeze([]),
  inspect_workspace: Object.freeze(["workspace_read"]),
  modify_workspace: Object.freeze(["workspace_write"]),
  run_workspace_command: Object.freeze(["command_execution"]),
  network_read: Object.freeze(["network_access"]),
  credential_access: Object.freeze(["credential_access"]),
  external_write: Object.freeze(["network_access", "external_write"]),
  database_migration: Object.freeze(["workspace_write", "command_execution"]),
  production_change: Object.freeze(["network_access", "external_write"]),
  irreversible_action: Object.freeze([
    "workspace_write",
    "command_execution",
    "network_access",
    "external_write",
  ]),
  permission_boundary_change: Object.freeze(["workspace_write"]),
  public_api_change: Object.freeze(["workspace_write"]),
  concurrent_change: Object.freeze(["workspace_write"]),
  architecture_decision: Object.freeze(["workspace_read"]),
  systemic_diagnosis: Object.freeze(["workspace_read", "command_execution"]),
  user_interaction: Object.freeze(["user_interaction"]),
} as const satisfies Readonly<Record<HarnessRouteOperationKind, readonly HarnessRouteToolClass[]>>);

const SAFETY_SIGNAL_OPERATION_KIND = Object.freeze({
  concurrencySensitive: "concurrent_change",
  dataMigration: "database_migration",
  irreversibleOperation: "irreversible_action",
  permissionBoundaryChange: "permission_boundary_change",
  productionImpact: "production_change",
  publicApiChange: "public_api_change",
} as const satisfies Readonly<
  Record<
    (typeof HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES.operation_plan)[number],
    HarnessRouteOperationKind
  >
>);

function normalizeNodeId(task: TaskPlanRecord, input: unknown): string | null {
  if (input === null) {
    return null;
  }
  const nodeId = requireUuid(input, "node_not_found");
  if (task.activeGraph === null || !task.activeGraph.nodes.some((node) => node.nodeId === nodeId)) {
    throw new HarnessOperationRouteObserverError("node_not_found");
  }
  return nodeId;
}

function manifestInputFromObservation(
  observation: HarnessOperationRouteObservation,
): ObserveHarnessOperationRouteInput {
  return {
    schemaVersion: 1,
    manifestId: observation.manifestId,
    observedAtMs: observation.observedAtMs,
    operations: observation.operations,
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
    throw new HarnessOperationRouteObserverError("invalid_snapshot");
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
  errorCode: HarnessOperationRouteObserverErrorCode,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessOperationRouteObserverError(errorCode);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new HarnessOperationRouteObserverError(errorCode);
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown, errorCode: HarnessOperationRouteObserverErrorCode): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new HarnessOperationRouteObserverError(errorCode);
  }
  return input;
}

function requireNullableUuid(
  input: unknown,
  errorCode: HarnessOperationRouteObserverErrorCode,
): string | null {
  return input === null ? null : requireUuid(input, errorCode);
}

function requireNonNegativeInteger(
  input: unknown,
  errorCode: HarnessOperationRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new HarnessOperationRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePositiveInteger(
  input: unknown,
  errorCode: HarnessOperationRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new HarnessOperationRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePolicyVersion(
  input: unknown,
  errorCode: HarnessOperationRouteObserverErrorCode,
): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_POLICY_VERSION_CHARACTERS ||
    !POLICY_VERSION_PATTERN.test(input)
  ) {
    throw new HarnessOperationRouteObserverError(errorCode);
  }
  return input;
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
