import { validateJsonValue } from "@codex-harness/protocol";

import {
  createHarnessOperationRouteObserver,
  type HarnessOperationRouteObservation,
  type HarnessOperationRouteObserver,
} from "./harness-operation-route-observer.js";
import {
  createHarnessPermissionRouteObserver,
  type HarnessPermissionRouteObservation,
  type HarnessPermissionRouteObserver,
} from "./harness-permission-route-observer.js";
import {
  createHarnessRouteEvidenceAuthority,
  type HarnessRouteEvidenceAuthorityPolicySet,
  type HarnessRouteEvidenceSnapshot,
} from "./harness-route-evidence.js";
import {
  createHarnessRuntimeTargetRouteObserver,
  type HarnessRuntimeTargetRouteObservation,
  type HarnessRuntimeTargetRouteObserver,
} from "./harness-runtime-target-route-observer.js";
import {
  createHarnessWorkspaceRouteObserver,
  type HarnessWorkspaceRouteObservation,
  type HarnessWorkspaceRouteObserver,
} from "./harness-workspace-route-observer.js";
import type { TaskPlanRecord } from "./task-plan-store.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const HARNESS_ROUTE_EVIDENCE_COORDINATOR_POLICY_VERSION =
  "harness-route-evidence-coordinator-policy-v1" as const;

export type CreateHarnessRouteEvidenceCoordinatorInput = Readonly<{
  schemaVersion: 1;
  coordinatorSessionId: string;
  policySet: HarnessRouteEvidenceAuthorityPolicySet;
}>;

export type IssueHarnessCoordinatedRouteEvidenceInput = Readonly<{
  schemaVersion: 1;
  evidenceId: string;
  operationObservation: HarnessOperationRouteObservation;
  permissionObservation: HarnessPermissionRouteObservation;
  workspaceObservation: HarnessWorkspaceRouteObservation;
  runtimeTargetObservation: HarnessRuntimeTargetRouteObservation;
}>;

export type HarnessRouteEvidenceCoordinatorObservers = Readonly<{
  operationPlan: HarnessOperationRouteObserver;
  permissionPlan: HarnessPermissionRouteObserver;
  workspaceAnalysis: HarnessWorkspaceRouteObserver;
  runtimeTarget: HarnessRuntimeTargetRouteObserver;
}>;

export type HarnessRouteEvidenceCoordinatorErrorCode =
  "invalid_coordinator" | "invalid_evidence_bundle";

const ERROR_MESSAGES: Readonly<Record<HarnessRouteEvidenceCoordinatorErrorCode, string>> =
  Object.freeze({
    invalid_coordinator: "The Harness route evidence coordinator is invalid.",
    invalid_evidence_bundle: "The Harness route evidence bundle is invalid.",
  });

export class HarnessRouteEvidenceCoordinatorError extends Error {
  readonly code: HarnessRouteEvidenceCoordinatorErrorCode;

  constructor(code: HarnessRouteEvidenceCoordinatorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HarnessRouteEvidenceCoordinatorError";
    this.code = code;
  }
}

export type HarnessRouteEvidenceCoordinator = Readonly<{
  policyVersion: typeof HARNESS_ROUTE_EVIDENCE_COORDINATOR_POLICY_VERSION;
  coordinatorSessionId: string;
  policySet: HarnessRouteEvidenceAuthorityPolicySet;
  observers: HarnessRouteEvidenceCoordinatorObservers;
  issue(
    task: TaskPlanRecord,
    nodeId: string | null,
    input: IssueHarnessCoordinatedRouteEvidenceInput,
  ): HarnessRouteEvidenceSnapshot;
  isVerified(input: unknown): input is HarnessRouteEvidenceSnapshot;
  isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessRouteEvidenceSnapshot;
}>;

export function createHarnessRouteEvidenceCoordinator(
  input: unknown,
): HarnessRouteEvidenceCoordinator {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessRouteEvidenceCoordinatorError("invalid_coordinator");
    }
    const record = requireExactRecord(
      input,
      ["coordinatorSessionId", "policySet", "schemaVersion"],
      "invalid_coordinator",
    );
    if (record.schemaVersion !== 1) {
      throw new HarnessRouteEvidenceCoordinatorError("invalid_coordinator");
    }
    const authority = createHarnessRouteEvidenceAuthority({
      schemaVersion: 1,
      authoritySessionId: record.coordinatorSessionId,
      policySet: record.policySet,
    });
    const coordinatorSessionId = authority.authoritySessionId;
    const policySet = authority.policySet;
    const observers = Object.freeze({
      operationPlan: createHarnessOperationRouteObserver({
        schemaVersion: 1,
        observerSessionId: coordinatorSessionId,
        policySet: {
          taskClassifier: policySet.taskClassifier,
          toolPlanner: policySet.toolPlanner,
          operationPlan: policySet.safetyObservers.operation_plan,
        },
      }),
      permissionPlan: createHarnessPermissionRouteObserver({
        schemaVersion: 1,
        observerSessionId: coordinatorSessionId,
        policySet: { permissionPlan: policySet.safetyObservers.permission_plan },
      }),
      workspaceAnalysis: createHarnessWorkspaceRouteObserver({
        schemaVersion: 1,
        observerSessionId: coordinatorSessionId,
        policySet: { workspaceAnalysis: policySet.safetyObservers.workspace_analysis },
      }),
      runtimeTarget: createHarnessRuntimeTargetRouteObserver({
        schemaVersion: 1,
        observerSessionId: coordinatorSessionId,
        policySet: { runtimeTarget: policySet.safetyObservers.runtime_target },
      }),
    });

    return Object.freeze({
      policyVersion: HARNESS_ROUTE_EVIDENCE_COORDINATOR_POLICY_VERSION,
      coordinatorSessionId,
      policySet,
      observers,
      issue(
        task: TaskPlanRecord,
        nodeId: string | null,
        input: IssueHarnessCoordinatedRouteEvidenceInput,
      ): HarnessRouteEvidenceSnapshot {
        return issueEvidenceBundle(authority.issue, observers, task, nodeId, input);
      },
      isVerified(input: unknown): input is HarnessRouteEvidenceSnapshot {
        return authority.isVerified(input);
      },
      isCurrent(task: TaskPlanRecord, input: unknown): input is HarnessRouteEvidenceSnapshot {
        return authority.isCurrent(task, input);
      },
    });
  } catch (error: unknown) {
    if (
      error instanceof HarnessRouteEvidenceCoordinatorError &&
      error.code === "invalid_coordinator"
    ) {
      throw error;
    }
    throw new HarnessRouteEvidenceCoordinatorError("invalid_coordinator");
  }
}

function issueEvidenceBundle(
  authorityIssue: (
    task: TaskPlanRecord,
    nodeId: string | null,
    input: Readonly<{
      schemaVersion: 1;
      evidenceId: string;
      observedAtMs: number;
      taskClassification: HarnessOperationRouteObservation["routeEvidence"]["taskClassification"];
      toolPlan: HarnessOperationRouteObservation["routeEvidence"]["toolPlan"];
      safetyReports: readonly [
        HarnessOperationRouteObservation["routeEvidence"]["operationPlanSafetyReport"],
        HarnessPermissionRouteObservation["permissionPlanSafetyReport"],
        HarnessWorkspaceRouteObservation["workspaceAnalysisSafetyReport"],
        HarnessRuntimeTargetRouteObservation["runtimeTargetSafetyReport"],
      ];
    }>,
  ) => HarnessRouteEvidenceSnapshot,
  observers: HarnessRouteEvidenceCoordinatorObservers,
  task: TaskPlanRecord,
  nodeId: string | null,
  input: unknown,
): HarnessRouteEvidenceSnapshot {
  try {
    if (!validateJsonValue(input).ok) {
      throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
    }
    const record = requireExactRecord(
      input,
      [
        "evidenceId",
        "operationObservation",
        "permissionObservation",
        "runtimeTargetObservation",
        "schemaVersion",
        "workspaceObservation",
      ],
      "invalid_evidence_bundle",
    );
    if (record.schemaVersion !== 1) {
      throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
    }

    const operationObservation = requireCurrentOperationObservation(
      observers.operationPlan,
      task,
      record.operationObservation,
    );
    const permissionObservation = requireCurrentPermissionObservation(
      observers.permissionPlan,
      task,
      record.permissionObservation,
    );
    const workspaceObservation = requireCurrentWorkspaceObservation(
      observers.workspaceAnalysis,
      task,
      record.workspaceObservation,
    );
    const runtimeTargetObservation = requireCurrentRuntimeTargetObservation(
      observers.runtimeTarget,
      task,
      record.runtimeTargetObservation,
    );
    const observations = [
      operationObservation,
      permissionObservation,
      workspaceObservation,
      runtimeTargetObservation,
    ] as const;
    if (
      observations.some(
        (observation) =>
          observation.subject.taskId !== task.taskId ||
          observation.subject.taskVersion !== task.taskVersion ||
          observation.subject.nodeId !== nodeId,
      ) ||
      new Set(observations.map((observation) => observation.taskFence.digest)).size !== 1
    ) {
      throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
    }

    return authorityIssue(task, nodeId, {
      schemaVersion: 1,
      evidenceId: requireUuid(record.evidenceId, "invalid_evidence_bundle"),
      observedAtMs: Math.max(...observations.map((observation) => observation.observedAtMs)),
      taskClassification: operationObservation.routeEvidence.taskClassification,
      toolPlan: operationObservation.routeEvidence.toolPlan,
      safetyReports: [
        operationObservation.routeEvidence.operationPlanSafetyReport,
        permissionObservation.permissionPlanSafetyReport,
        workspaceObservation.workspaceAnalysisSafetyReport,
        runtimeTargetObservation.runtimeTargetSafetyReport,
      ],
    });
  } catch (error: unknown) {
    if (
      error instanceof HarnessRouteEvidenceCoordinatorError &&
      error.code === "invalid_evidence_bundle"
    ) {
      throw error;
    }
    throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
  }
}

function requireCurrentOperationObservation(
  observer: HarnessOperationRouteObserver,
  task: TaskPlanRecord,
  input: unknown,
): HarnessOperationRouteObservation {
  if (!observer.isVerified(input) || !observer.isCurrent(task, input)) {
    throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
  }
  return input;
}

function requireCurrentPermissionObservation(
  observer: HarnessPermissionRouteObserver,
  task: TaskPlanRecord,
  input: unknown,
): HarnessPermissionRouteObservation {
  if (!observer.isVerified(input) || !observer.isCurrent(task, input)) {
    throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
  }
  return input;
}

function requireCurrentWorkspaceObservation(
  observer: HarnessWorkspaceRouteObserver,
  task: TaskPlanRecord,
  input: unknown,
): HarnessWorkspaceRouteObservation {
  if (!observer.isVerified(input) || !observer.isCurrent(task, input)) {
    throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
  }
  return input;
}

function requireCurrentRuntimeTargetObservation(
  observer: HarnessRuntimeTargetRouteObserver,
  task: TaskPlanRecord,
  input: unknown,
): HarnessRuntimeTargetRouteObservation {
  if (!observer.isVerified(input) || !observer.isCurrent(task, input)) {
    throw new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
  }
  return input;
}

function requireExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  errorCode: HarnessRouteEvidenceCoordinatorErrorCode,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessRouteEvidenceCoordinatorError(errorCode);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new HarnessRouteEvidenceCoordinatorError(errorCode);
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown, errorCode: HarnessRouteEvidenceCoordinatorErrorCode): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new HarnessRouteEvidenceCoordinatorError(errorCode);
  }
  return input;
}
