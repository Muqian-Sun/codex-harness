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
const MAX_PERMISSION_REQUESTS = 256;

export const HARNESS_PERMISSION_ROUTE_OBSERVER_POLICY_VERSION =
  "harness-permission-route-observer-policy-v1" as const;

export const HARNESS_PERMISSION_CAPABILITIES = Object.freeze([
  "workspace_read",
  "workspace_write",
  "command_execution",
  "network_access",
  "credential_access",
  "external_write",
  "privileged_command_execution",
  "permission_boundary_change",
  "irreversible_workspace_change",
  "irreversible_external_write",
  "production_access",
  "user_interaction",
] as const);

export type HarnessPermissionCapability = (typeof HARNESS_PERMISSION_CAPABILITIES)[number];

export type HarnessPermissionRequest = Readonly<{
  permissionRequestId: string;
  capability: HarnessPermissionCapability;
}>;

export type HarnessPermissionRouteObserverPolicySet = Readonly<{
  permissionPlan: string;
}>;

export type CreateHarnessPermissionRouteObserverInput = Readonly<{
  schemaVersion: 1;
  observerSessionId: string;
  policySet: HarnessPermissionRouteObserverPolicySet;
}>;

export type ObserveHarnessPermissionRouteInput = Readonly<{
  schemaVersion: 1;
  permissionPlanId: string;
  observedAtMs: number;
  complete: true;
  requests: readonly HarnessPermissionRequest[];
}>;

export type HarnessPermissionPlanSafetyReport = HarnessRouteSafetyReport &
  Readonly<{ source: "permission_plan" }>;

export type HarnessPermissionRouteObservation = Readonly<{
  schemaVersion: 1;
  mode: "shadow";
  executionAuthorized: false;
  policyVersion: typeof HARNESS_PERMISSION_ROUTE_OBSERVER_POLICY_VERSION;
  observerSessionId: string;
  observerPolicySet: HarnessPermissionRouteObserverPolicySet;
  permissionPlanId: string;
  observedAtMs: number;
  complete: true;
  subject: Readonly<{
    taskId: string;
    taskVersion: number;
    nodeId: string | null;
  }>;
  taskFence: TaskRecoveryFence;
  requests: readonly HarnessPermissionRequest[];
  permissionPlanSafetyReport: HarnessPermissionPlanSafetyReport;
  observationDigest: string;
}>;

export type HarnessPermissionRouteObserverErrorCode =
  | "invalid_observer"
  | "invalid_permission_plan"
  | "invalid_snapshot"
  | "invalid_task"
  | "node_not_found"
  | "stale_observation";

const ERROR_MESSAGES: Readonly<Record<HarnessPermissionRouteObserverErrorCode, string>> =
  Object.freeze({
    invalid_observer: "The Harness permission route observer is invalid.",
    invalid_permission_plan: "The complete Harness permission plan is invalid.",
    invalid_snapshot: "The Harness permission route observation is invalid.",
    invalid_task: "The authoritative Task permission route source is invalid.",
    node_not_found: "The permission route subject node does not exist in the active Task graph.",
    stale_observation: "The permission route observation predates the current Task state.",
  });

export class HarnessPermissionRouteObserverError extends Error {
  readonly code: HarnessPermissionRouteObserverErrorCode;

  constructor(code: HarnessPermissionRouteObserverErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessPermissionRouteObserverError";
    this.code = code;
  }
}

export type HarnessPermissionRouteObserver = Readonly<{
  observerSessionId: string;
  policySet: HarnessPermissionRouteObserverPolicySet;
  observe(
    task: TaskPlanRecord,
    nodeId: string | null,
    input: ObserveHarnessPermissionRouteInput,
  ): HarnessPermissionRouteObservation;
  isVerified(input: unknown): input is HarnessPermissionRouteObservation;
  isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessPermissionRouteObservation;
}>;

export function createHarnessPermissionRouteObserver(
  input: unknown,
): HarnessPermissionRouteObserver {
  let observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessPermissionRouteObserverPolicySet;
  }>;
  try {
    observerConfig = normalizeObserverInput(input);
  } catch {
    throw new HarnessPermissionRouteObserverError("invalid_observer");
  }
  const verifiedObservations = new WeakSet<object>();

  return Object.freeze({
    observerSessionId: observerConfig.observerSessionId,
    policySet: observerConfig.policySet,
    observe(
      task: TaskPlanRecord,
      nodeId: string | null,
      input: ObserveHarnessPermissionRouteInput,
    ): HarnessPermissionRouteObservation {
      const observation = buildObservationForTask(observerConfig, task, nodeId, input);
      verifiedObservations.add(observation);
      return observation;
    },
    isVerified(input: unknown): input is HarnessPermissionRouteObservation {
      return typeof input === "object" && input !== null && verifiedObservations.has(input);
    },
    isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessPermissionRouteObservation {
      if (typeof input !== "object" || input === null || !verifiedObservations.has(input)) {
        return false;
      }
      try {
        const observation = input as HarnessPermissionRouteObservation;
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
          permissionPlanInputFromObservation(observation),
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

export function decodeHarnessPermissionRouteObservation(
  input: unknown,
): HarnessPermissionRouteObservation {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessPermissionRouteObserverError("invalid_snapshot");
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
        "permissionPlanId",
        "permissionPlanSafetyReport",
        "policyVersion",
        "requests",
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
      throw new HarnessPermissionRouteObserverError("invalid_snapshot");
    }
    const policySet = normalizePolicySet(record.observerPolicySet, "invalid_snapshot");
    const permissionPlan = normalizePermissionPlanInput(
      {
        schemaVersion: record.schemaVersion,
        permissionPlanId: record.permissionPlanId,
        observedAtMs: record.observedAtMs,
        complete: record.complete,
        requests: record.requests,
      },
      "invalid_snapshot",
    );
    const expected = materializeObservation(
      requireUuid(record.observerSessionId, "invalid_snapshot"),
      policySet,
      taskFence,
      nodeId,
      permissionPlan,
    );
    if (
      record.schemaVersion !== 1 ||
      record.mode !== "shadow" ||
      record.executionAuthorized !== false ||
      record.policyVersion !== HARNESS_PERMISSION_ROUTE_OBSERVER_POLICY_VERSION ||
      typeof record.observationDigest !== "string" ||
      !SHA256_PATTERN.test(record.observationDigest) ||
      canonicalJson(input as JsonValue) !== canonicalJson(expected as unknown as JsonValue)
    ) {
      throw new HarnessPermissionRouteObserverError("invalid_snapshot");
    }
    return expected;
  } catch (error: unknown) {
    if (error instanceof HarnessPermissionRouteObserverError && error.code === "invalid_snapshot") {
      throw error;
    }
    throw new HarnessPermissionRouteObserverError("invalid_snapshot");
  }
}

function buildObservationForTask(
  observerConfig: Readonly<{
    observerSessionId: string;
    policySet: HarnessPermissionRouteObserverPolicySet;
  }>,
  task: TaskPlanRecord,
  nodeId: unknown,
  input: unknown,
): HarnessPermissionRouteObservation {
  try {
    const updatedAtMs = requireNonNegativeInteger(task.updatedAtMs, "invalid_task");
    const taskFence = cloneTaskFence(buildTaskRecoveryCapsule(task).fence);
    const normalizedNodeId = normalizeNodeId(task, nodeId);
    const permissionPlan = normalizePermissionPlanInput(input, "invalid_permission_plan");
    if (permissionPlan.observedAtMs < updatedAtMs) {
      throw new HarnessPermissionRouteObserverError("stale_observation");
    }
    return materializeObservation(
      observerConfig.observerSessionId,
      observerConfig.policySet,
      taskFence,
      normalizedNodeId,
      permissionPlan,
    );
  } catch (error: unknown) {
    if (error instanceof HarnessPermissionRouteObserverError) {
      throw error;
    }
    if (error instanceof TaskRecoveryContextError) {
      throw new HarnessPermissionRouteObserverError("invalid_task");
    }
    throw new HarnessPermissionRouteObserverError("invalid_task");
  }
}

type NormalizedPermissionPlan = Readonly<{
  permissionPlanId: string;
  observedAtMs: number;
  complete: true;
  requests: readonly HarnessPermissionRequest[];
}>;

function materializeObservation(
  observerSessionId: string,
  observerPolicySet: HarnessPermissionRouteObserverPolicySet,
  taskFence: TaskRecoveryFence,
  nodeId: string | null,
  permissionPlan: NormalizedPermissionPlan,
): HarnessPermissionRouteObservation {
  const permissionPlanSafetyReport = derivePermissionPlanSafetyReport(
    permissionPlan.requests,
    observerPolicySet.permissionPlan,
  );
  const core = Object.freeze({
    schemaVersion: 1 as const,
    mode: "shadow" as const,
    executionAuthorized: false as const,
    policyVersion: HARNESS_PERMISSION_ROUTE_OBSERVER_POLICY_VERSION,
    observerSessionId,
    observerPolicySet,
    permissionPlanId: permissionPlan.permissionPlanId,
    observedAtMs: permissionPlan.observedAtMs,
    complete: true as const,
    subject: Object.freeze({
      taskId: taskFence.taskId,
      taskVersion: taskFence.taskVersion,
      nodeId,
    }),
    taskFence,
    requests: permissionPlan.requests,
    permissionPlanSafetyReport,
  });
  if (!validateJsonValue(core).ok) {
    throw new HarnessPermissionRouteObserverError("invalid_snapshot");
  }
  const observationDigest = createHash("sha256")
    .update(canonicalJson(core as unknown as JsonValue), "utf8")
    .digest("hex");
  return Object.freeze({ ...core, observationDigest });
}

function normalizeObserverInput(input: unknown): Readonly<{
  observerSessionId: string;
  policySet: HarnessPermissionRouteObserverPolicySet;
}> {
  if (!validateJsonValue(input).ok) {
    throw new HarnessPermissionRouteObserverError("invalid_observer");
  }
  const record = requireExactRecord(
    input,
    ["observerSessionId", "policySet", "schemaVersion"],
    "invalid_observer",
  );
  if (record.schemaVersion !== 1) {
    throw new HarnessPermissionRouteObserverError("invalid_observer");
  }
  return Object.freeze({
    observerSessionId: requireUuid(record.observerSessionId, "invalid_observer"),
    policySet: normalizePolicySet(record.policySet, "invalid_observer"),
  });
}

function normalizePolicySet(
  input: unknown,
  errorCode: "invalid_observer" | "invalid_snapshot",
): HarnessPermissionRouteObserverPolicySet {
  const record = requireExactRecord(input, ["permissionPlan"], errorCode);
  return Object.freeze({
    permissionPlan: requirePolicyVersion(record.permissionPlan, errorCode),
  });
}

function normalizePermissionPlanInput(
  input: unknown,
  errorCode: "invalid_permission_plan" | "invalid_snapshot",
): NormalizedPermissionPlan {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessPermissionRouteObserverError(errorCode);
    }
    const record = requireExactRecord(
      input,
      ["complete", "observedAtMs", "permissionPlanId", "requests", "schemaVersion"],
      errorCode,
    );
    if (
      record.schemaVersion !== 1 ||
      record.complete !== true ||
      !Array.isArray(record.requests) ||
      record.requests.length > MAX_PERMISSION_REQUESTS
    ) {
      throw new HarnessPermissionRouteObserverError(errorCode);
    }
    const requests = record.requests.map((request) =>
      normalizePermissionRequest(request, errorCode),
    );
    if (new Set(requests.map((request) => request.permissionRequestId)).size !== requests.length) {
      throw new HarnessPermissionRouteObserverError(errorCode);
    }
    return Object.freeze({
      permissionPlanId: requireUuid(record.permissionPlanId, errorCode),
      observedAtMs: requireNonNegativeInteger(record.observedAtMs, errorCode),
      complete: true as const,
      requests: Object.freeze(requests),
    });
  } catch (error: unknown) {
    if (error instanceof HarnessPermissionRouteObserverError && error.code === errorCode) {
      throw error;
    }
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
}

function normalizePermissionRequest(
  input: unknown,
  errorCode: "invalid_permission_plan" | "invalid_snapshot",
): HarnessPermissionRequest {
  const record = requireExactRecord(input, ["capability", "permissionRequestId"], errorCode);
  return Object.freeze({
    permissionRequestId: requireUuid(record.permissionRequestId, errorCode),
    capability: requirePermissionCapability(record.capability, errorCode),
  });
}

function derivePermissionPlanSafetyReport(
  requests: readonly HarnessPermissionRequest[],
  policyVersion: string,
): HarnessPermissionPlanSafetyReport {
  const capabilities = new Set(requests.map((request) => request.capability));
  const observations = Object.freeze(
    Object.fromEntries(
      HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES.permission_plan.map((signal) => [
        signal,
        PERMISSION_SIGNAL_CAPABILITIES[signal].some((capability) => capabilities.has(capability))
          ? "present"
          : "absent",
      ]),
    ) as HarnessRouteSafetyReport["observations"],
  );
  return Object.freeze({
    source: "permission_plan" as const,
    policyVersion,
    observations,
  });
}

const PERMISSION_SIGNAL_CAPABILITIES = Object.freeze({
  irreversibleOperation: Object.freeze([
    "irreversible_workspace_change",
    "irreversible_external_write",
  ]),
  permissionBoundaryChange: Object.freeze(["permission_boundary_change"]),
  securitySensitive: Object.freeze([
    "credential_access",
    "privileged_command_execution",
    "permission_boundary_change",
    "production_access",
  ]),
} as const satisfies Readonly<
  Record<
    (typeof HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES.permission_plan)[number],
    readonly HarnessPermissionCapability[]
  >
>);

function normalizeNodeId(task: TaskPlanRecord, input: unknown): string | null {
  if (input === null) {
    return null;
  }
  const nodeId = requireUuid(input, "node_not_found");
  if (task.activeGraph === null || !task.activeGraph.nodes.some((node) => node.nodeId === nodeId)) {
    throw new HarnessPermissionRouteObserverError("node_not_found");
  }
  return nodeId;
}

function permissionPlanInputFromObservation(
  observation: HarnessPermissionRouteObservation,
): ObserveHarnessPermissionRouteInput {
  return {
    schemaVersion: 1,
    permissionPlanId: observation.permissionPlanId,
    observedAtMs: observation.observedAtMs,
    complete: true,
    requests: observation.requests,
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
    throw new HarnessPermissionRouteObserverError("invalid_snapshot");
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
  errorCode: HarnessPermissionRouteObserverErrorCode,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown, errorCode: HarnessPermissionRouteObserverErrorCode): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
  return input;
}

function requireNullableUuid(
  input: unknown,
  errorCode: HarnessPermissionRouteObserverErrorCode,
): string | null {
  return input === null ? null : requireUuid(input, errorCode);
}

function requireNonNegativeInteger(
  input: unknown,
  errorCode: HarnessPermissionRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePositiveInteger(
  input: unknown,
  errorCode: HarnessPermissionRouteObserverErrorCode,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
  return input as number;
}

function requirePolicyVersion(
  input: unknown,
  errorCode: HarnessPermissionRouteObserverErrorCode,
): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_POLICY_VERSION_CHARACTERS ||
    !POLICY_VERSION_PATTERN.test(input)
  ) {
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
  return input;
}

function requirePermissionCapability(
  input: unknown,
  errorCode: HarnessPermissionRouteObserverErrorCode,
): HarnessPermissionCapability {
  if (
    typeof input !== "string" ||
    !HARNESS_PERMISSION_CAPABILITIES.includes(input as HarnessPermissionCapability)
  ) {
    throw new HarnessPermissionRouteObserverError(errorCode);
  }
  return input as HarnessPermissionCapability;
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
