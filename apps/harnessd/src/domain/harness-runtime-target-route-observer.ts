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
const MAX_RUNTIME_TARGETS = 128;

export const HARNESS_RUNTIME_TARGET_ROUTE_OBSERVER_POLICY_VERSION =
  "harness-runtime-target-route-observer-policy-v1" as const;

export const HARNESS_RUNTIME_ENVIRONMENT_CLASSES = Object.freeze([
  "local",
  "ephemeral",
  "development",
  "test",
  "staging",
  "production",
  "production_control_plane",
  "customer_production",
] as const);

export type HarnessRuntimeEnvironmentClass = (typeof HARNESS_RUNTIME_ENVIRONMENT_CLASSES)[number];

export type HarnessRuntimeTarget = Readonly<{
  runtimeTargetId: string;
  environmentClass: HarnessRuntimeEnvironmentClass;
}>;

export type HarnessRuntimeTargetRouteObserverPolicySet = Readonly<{
  runtimeTarget: string;
}>;

export type CreateHarnessRuntimeTargetRouteObserverInput = Readonly<{
  schemaVersion: 1;
  observerSessionId: string;
  policySet: HarnessRuntimeTargetRouteObserverPolicySet;
}>;

export type ObserveHarnessRuntimeTargetRouteInput = Readonly<{
  schemaVersion: 1;
  runtimeTargetPlanId: string;
  runtimeInventorySnapshotId: string;
  runtimeInventoryDigest: string;
  observedAtMs: number;
  complete: true;
  targets: readonly HarnessRuntimeTarget[];
}>;

export type HarnessRuntimeTargetSafetyReport = HarnessRouteSafetyReport &
  Readonly<{ source: "runtime_target" }>;

export type HarnessRuntimeTargetRouteObservation = Readonly<{
  schemaVersion: 1;
  mode: "shadow";
  executionAuthorized: false;
  policyVersion: typeof HARNESS_RUNTIME_TARGET_ROUTE_OBSERVER_POLICY_VERSION;
  observerSessionId: string;
  observerPolicySet: HarnessRuntimeTargetRouteObserverPolicySet;
  runtimeTargetPlanId: string;
  runtimeInventorySnapshotId: string;
  runtimeInventoryDigest: string;
  observedAtMs: number;
  complete: true;
  subject: Readonly<{
    taskId: string;
    taskVersion: number;
    nodeId: string | null;
  }>;
  taskFence: TaskRecoveryFence;
  targets: readonly HarnessRuntimeTarget[];
  runtimeTargetSafetyReport: HarnessRuntimeTargetSafetyReport;
  observationDigest: string;
}>;

export type HarnessRuntimeTargetRouteObserverErrorCode =
  | "invalid_observer"
  | "invalid_runtime_target_plan"
  | "invalid_snapshot"
  | "invalid_task"
  | "node_not_found"
  | "stale_observation";

const ERROR_MESSAGES: Readonly<Record<HarnessRuntimeTargetRouteObserverErrorCode, string>> =
  Object.freeze({
    invalid_observer: "The Harness runtime target route observer is invalid.",
    invalid_runtime_target_plan: "The complete Harness runtime target plan is invalid.",
    invalid_snapshot: "The Harness runtime target route observation is invalid.",
    invalid_task: "The authoritative Task runtime target route source is invalid.",
    node_not_found:
      "The runtime target route subject node does not exist in the active Task graph.",
    stale_observation: "The runtime target route observation predates the current Task state.",
  });

export class HarnessRuntimeTargetRouteObserverError extends Error {
  readonly code: HarnessRuntimeTargetRouteObserverErrorCode;

  constructor(code: HarnessRuntimeTargetRouteObserverErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessRuntimeTargetRouteObserverError";
    this.code = code;
  }
}

export type HarnessRuntimeTargetRouteObserver = Readonly<{
  observerSessionId: string;
  policySet: HarnessRuntimeTargetRouteObserverPolicySet;
  observe(
    task: TaskPlanRecord,
    nodeId: string | null,
    input: ObserveHarnessRuntimeTargetRouteInput,
  ): HarnessRuntimeTargetRouteObservation;
  isVerified(input: unknown): input is HarnessRuntimeTargetRouteObservation;
  isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessRuntimeTargetRouteObservation;
}>;

export function createHarnessRuntimeTargetRouteObserver(
  input: unknown,
): HarnessRuntimeTargetRouteObserver {
  let observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessRuntimeTargetRouteObserverPolicySet;
  }>;
  try {
    observerConfig = normalizeObserverInput(input);
  } catch {
    throw new HarnessRuntimeTargetRouteObserverError("invalid_observer");
  }
  const verifiedObservations = new WeakSet<object>();

  return Object.freeze({
    observerSessionId: observerConfig.observerSessionId,
    policySet: observerConfig.policySet,
    observe(
      task: TaskPlanRecord,
      nodeId: string | null,
      input: ObserveHarnessRuntimeTargetRouteInput,
    ): HarnessRuntimeTargetRouteObservation {
      const observation = buildObservationForTask(observerConfig, task, nodeId, input);
      verifiedObservations.add(observation);
      return observation;
    },
    isVerified(input: unknown): input is HarnessRuntimeTargetRouteObservation {
      return typeof input === "object" && input !== null && verifiedObservations.has(input);
    },
    isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessRuntimeTargetRouteObservation {
      if (typeof input !== "object" || input === null || !verifiedObservations.has(input)) {
        return false;
      }
      try {
        const observation = input as HarnessRuntimeTargetRouteObservation;
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
          runtimeTargetPlanInputFromObservation(observation),
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

export function decodeHarnessRuntimeTargetRouteObservation(
  input: unknown,
): HarnessRuntimeTargetRouteObservation {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessRuntimeTargetRouteObserverError("invalid_snapshot");
    }
    const record = requireExactRecord(
      input,
      [
        "complete",
        "executionAuthorized",
        "mode",
        "observationDigest",
        "observedAtMs",
        "observerPolicySet",
        "observerSessionId",
        "policyVersion",
        "runtimeInventoryDigest",
        "runtimeInventorySnapshotId",
        "runtimeTargetPlanId",
        "runtimeTargetSafetyReport",
        "schemaVersion",
        "subject",
        "targets",
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
      throw new HarnessRuntimeTargetRouteObserverError("invalid_snapshot");
    }
    const policySet = normalizePolicySet(record.observerPolicySet, "invalid_snapshot");
    const runtimeTargetPlan = normalizeRuntimeTargetPlanInput(
      {
        schemaVersion: record.schemaVersion,
        runtimeTargetPlanId: record.runtimeTargetPlanId,
        runtimeInventorySnapshotId: record.runtimeInventorySnapshotId,
        runtimeInventoryDigest: record.runtimeInventoryDigest,
        observedAtMs: record.observedAtMs,
        complete: record.complete,
        targets: record.targets,
      },
      "invalid_snapshot",
    );
    const expected = materializeObservation(
      requireUuid(record.observerSessionId, "invalid_snapshot"),
      policySet,
      taskFence,
      nodeId,
      runtimeTargetPlan,
    );
    if (
      record.schemaVersion !== 1 ||
      record.mode !== "shadow" ||
      record.executionAuthorized !== false ||
      record.policyVersion !== HARNESS_RUNTIME_TARGET_ROUTE_OBSERVER_POLICY_VERSION ||
      typeof record.observationDigest !== "string" ||
      !SHA256_PATTERN.test(record.observationDigest) ||
      canonicalJson(input as JsonValue) !== canonicalJson(expected as unknown as JsonValue)
    ) {
      throw new HarnessRuntimeTargetRouteObserverError("invalid_snapshot");
    }
    return expected;
  } catch (error: unknown) {
    if (
      error instanceof HarnessRuntimeTargetRouteObserverError &&
      error.code === "invalid_snapshot"
    ) {
      throw error;
    }
    throw new HarnessRuntimeTargetRouteObserverError("invalid_snapshot");
  }
}

function buildObservationForTask(
  observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessRuntimeTargetRouteObserverPolicySet;
  }>,
  task: TaskPlanRecord,
  nodeId: unknown,
  input: unknown,
): HarnessRuntimeTargetRouteObservation {
  try {
    const updatedAtMs = requireNonNegativeInteger(task.updatedAtMs, "invalid_task");
    const taskFence = cloneTaskFence(buildTaskRecoveryCapsule(task).fence);
    const normalizedNodeId = normalizeNodeId(task, nodeId);
    const runtimeTargetPlan = normalizeRuntimeTargetPlanInput(input, "invalid_runtime_target_plan");
    if (runtimeTargetPlan.observedAtMs < updatedAtMs) {
      throw new HarnessRuntimeTargetRouteObserverError("stale_observation");
    }
    return materializeObservation(
      observerConfig.observerSessionId,
      observerConfig.policySet,
      taskFence,
      normalizedNodeId,
      runtimeTargetPlan,
    );
  } catch (error: unknown) {
    if (error instanceof HarnessRuntimeTargetRouteObserverError) {
      throw error;
    }
    if (error instanceof TaskRecoveryContextError) {
      throw new HarnessRuntimeTargetRouteObserverError("invalid_task");
    }
    throw new HarnessRuntimeTargetRouteObserverError("invalid_task");
  }
}

type NormalizedRuntimeTargetPlan = Readonly<{
  runtimeTargetPlanId: string;
  runtimeInventorySnapshotId: string;
  runtimeInventoryDigest: string;
  observedAtMs: number;
  complete: true;
  targets: readonly HarnessRuntimeTarget[];
}>;

function materializeObservation(
  observerSessionId: string,
  observerPolicySet: HarnessRuntimeTargetRouteObserverPolicySet,
  taskFence: TaskRecoveryFence,
  nodeId: string | null,
  runtimeTargetPlan: NormalizedRuntimeTargetPlan,
): HarnessRuntimeTargetRouteObservation {
  const runtimeTargetSafetyReport = deriveRuntimeTargetSafetyReport(
    runtimeTargetPlan.targets,
    observerPolicySet.runtimeTarget,
  );
  const core = Object.freeze({
    schemaVersion: 1 as const,
    mode: "shadow" as const,
    executionAuthorized: false as const,
    policyVersion: HARNESS_RUNTIME_TARGET_ROUTE_OBSERVER_POLICY_VERSION,
    observerSessionId,
    observerPolicySet,
    runtimeTargetPlanId: runtimeTargetPlan.runtimeTargetPlanId,
    runtimeInventorySnapshotId: runtimeTargetPlan.runtimeInventorySnapshotId,
    runtimeInventoryDigest: runtimeTargetPlan.runtimeInventoryDigest,
    observedAtMs: runtimeTargetPlan.observedAtMs,
    complete: true as const,
    subject: Object.freeze({
      taskId: taskFence.taskId,
      taskVersion: taskFence.taskVersion,
      nodeId,
    }),
    taskFence,
    targets: runtimeTargetPlan.targets,
    runtimeTargetSafetyReport,
  });
  if (!validateJsonValue(core).ok) {
    throw new HarnessRuntimeTargetRouteObserverError("invalid_snapshot");
  }
  const observationDigest = createHash("sha256")
    .update(canonicalJson(core as unknown as JsonValue), "utf8")
    .digest("hex");
  return Object.freeze({ ...core, observationDigest });
}

function normalizeObserverInput(input: unknown): Readonly<{
  observerSessionId: string;
  policySet: HarnessRuntimeTargetRouteObserverPolicySet;
}> {
  if (!validateJsonValue(input).ok) {
    throw new HarnessRuntimeTargetRouteObserverError("invalid_observer");
  }
  const record = requireExactRecord(
    input,
    ["observerSessionId", "policySet", "schemaVersion"],
    "invalid_observer",
  );
  if (record.schemaVersion !== 1) {
    throw new HarnessRuntimeTargetRouteObserverError("invalid_observer");
  }
  return Object.freeze({
    observerSessionId: requireUuid(record.observerSessionId, "invalid_observer"),
    policySet: normalizePolicySet(record.policySet, "invalid_observer"),
  });
}

function normalizePolicySet(
  input: unknown,
  errorCode: "invalid_observer" | "invalid_snapshot",
): HarnessRuntimeTargetRouteObserverPolicySet {
  const record = requireExactRecord(input, ["runtimeTarget"], errorCode);
  return Object.freeze({
    runtimeTarget: requirePolicyVersion(record.runtimeTarget, errorCode),
  });
}

function normalizeRuntimeTargetPlanInput(
  input: unknown,
  errorCode: "invalid_runtime_target_plan" | "invalid_snapshot",
): NormalizedRuntimeTargetPlan {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessRuntimeTargetRouteObserverError(errorCode);
    }
    const record = requireExactRecord(
      input,
      [
        "complete",
        "observedAtMs",
        "runtimeInventoryDigest",
        "runtimeInventorySnapshotId",
        "runtimeTargetPlanId",
        "schemaVersion",
        "targets",
      ],
      errorCode,
    );
    if (
      record.schemaVersion !== 1 ||
      record.complete !== true ||
      !Array.isArray(record.targets) ||
      record.targets.length > MAX_RUNTIME_TARGETS
    ) {
      throw new HarnessRuntimeTargetRouteObserverError(errorCode);
    }
    const targets = record.targets.map((target) => normalizeRuntimeTarget(target, errorCode));
    if (new Set(targets.map((target) => target.runtimeTargetId)).size !== targets.length) {
      throw new HarnessRuntimeTargetRouteObserverError(errorCode);
    }
    return Object.freeze({
      runtimeTargetPlanId: requireUuid(record.runtimeTargetPlanId, errorCode),
      runtimeInventorySnapshotId: requireUuid(record.runtimeInventorySnapshotId, errorCode),
      runtimeInventoryDigest: requireSha256(record.runtimeInventoryDigest, errorCode),
      observedAtMs: requireNonNegativeInteger(record.observedAtMs, errorCode),
      complete: true as const,
      targets: Object.freeze(targets),
    });
  } catch (error: unknown) {
    if (error instanceof HarnessRuntimeTargetRouteObserverError && error.code === errorCode) {
      throw error;
    }
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
}

function normalizeRuntimeTarget(
  input: unknown,
  errorCode: "invalid_runtime_target_plan" | "invalid_snapshot",
): HarnessRuntimeTarget {
  const record = requireExactRecord(input, ["environmentClass", "runtimeTargetId"], errorCode);
  return Object.freeze({
    runtimeTargetId: requireUuid(record.runtimeTargetId, errorCode),
    environmentClass: requireRuntimeEnvironmentClass(record.environmentClass, errorCode),
  });
}

function deriveRuntimeTargetSafetyReport(
  targets: readonly HarnessRuntimeTarget[],
  policyVersion: string,
): HarnessRuntimeTargetSafetyReport {
  const productionImpact = targets.some((target) =>
    PRODUCTION_RUNTIME_ENVIRONMENT_CLASSES.some(
      (environmentClass) => environmentClass === target.environmentClass,
    ),
  );
  const observations = Object.freeze(
    Object.fromEntries(
      HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES.runtime_target.map((signal) => [
        signal,
        productionImpact ? "present" : "absent",
      ]),
    ) as HarnessRouteSafetyReport["observations"],
  );
  return Object.freeze({
    source: "runtime_target" as const,
    policyVersion,
    observations,
  });
}

const PRODUCTION_RUNTIME_ENVIRONMENT_CLASSES = Object.freeze([
  "production",
  "production_control_plane",
  "customer_production",
] as const satisfies readonly HarnessRuntimeEnvironmentClass[]);

function normalizeNodeId(task: TaskPlanRecord, input: unknown): string | null {
  if (input === null) {
    return null;
  }
  const nodeId = requireUuid(input, "node_not_found");
  if (task.activeGraph === null || !task.activeGraph.nodes.some((node) => node.nodeId === nodeId)) {
    throw new HarnessRuntimeTargetRouteObserverError("node_not_found");
  }
  return nodeId;
}

function runtimeTargetPlanInputFromObservation(
  observation: HarnessRuntimeTargetRouteObservation,
): ObserveHarnessRuntimeTargetRouteInput {
  return {
    schemaVersion: 1,
    runtimeTargetPlanId: observation.runtimeTargetPlanId,
    runtimeInventorySnapshotId: observation.runtimeInventorySnapshotId,
    runtimeInventoryDigest: observation.runtimeInventoryDigest,
    observedAtMs: observation.observedAtMs,
    complete: true,
    targets: observation.targets,
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
    throw new HarnessRuntimeTargetRouteObserverError("invalid_snapshot");
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
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  return input as Record<string, unknown>;
}

function requireUuid(
  input: unknown,
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  return input;
}

function requireNullableUuid(
  input: unknown,
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): string | null {
  return input === null ? null : requireUuid(input, errorCode);
}

function requireSha256(
  input: unknown,
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  return input;
}

function requireNonNegativeInteger(
  input: unknown,
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePositiveInteger(
  input: unknown,
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePolicyVersion(
  input: unknown,
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_POLICY_VERSION_CHARACTERS ||
    !POLICY_VERSION_PATTERN.test(input)
  ) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  return input;
}

function requireRuntimeEnvironmentClass(
  input: unknown,
  errorCode: HarnessRuntimeTargetRouteObserverErrorCode,
): HarnessRuntimeEnvironmentClass {
  if (
    typeof input !== "string" ||
    !HARNESS_RUNTIME_ENVIRONMENT_CLASSES.includes(input as HarnessRuntimeEnvironmentClass)
  ) {
    throw new HarnessRuntimeTargetRouteObserverError(errorCode);
  }
  return input as HarnessRuntimeEnvironmentClass;
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
