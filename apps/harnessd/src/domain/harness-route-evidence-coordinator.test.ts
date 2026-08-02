import { describe, expect, it } from "vitest";

import {
  decodeHarnessOperationRouteObservation,
  type HarnessRouteOperationKind,
} from "./harness-operation-route-observer.js";
import type { HarnessPermissionCapability } from "./harness-permission-route-observer.js";
import {
  decodeHarnessRouteEvidenceSnapshot,
  type HarnessRouteEvidenceAuthorityPolicySet,
} from "./harness-route-evidence.js";
import {
  HARNESS_ROUTE_EVIDENCE_COORDINATOR_POLICY_VERSION,
  HarnessRouteEvidenceCoordinatorError,
  createHarnessRouteEvidenceCoordinator,
  type HarnessRouteEvidenceCoordinator,
  type IssueHarnessCoordinatedRouteEvidenceInput,
} from "./harness-route-evidence-coordinator.js";
import type { HarnessRuntimeEnvironmentClass } from "./harness-runtime-target-route-observer.js";
import type { HarnessWorkspaceFindingKind } from "./harness-workspace-route-observer.js";
import type { TaskPlanRecord } from "./task-plan-store.js";

const COORDINATOR_ID = uuid(1);
const OTHER_COORDINATOR_ID = uuid(2);
const TASK_ID = uuid(10);
const REQUIREMENT_ID = uuid(11);
const PLAN_ID = uuid(12);
const GRAPH_ID = uuid(13);
const NODE_ID = uuid(30);

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function requirementsTask(): TaskPlanRecord {
  return {
    taskId: TASK_ID,
    title: "Harness route evidence coordinator",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Coordinate four branded route observations.",
      objective: "Issue one complete shadow route evidence snapshot.",
      constraints: ["Completeness does not authorize execution or lower the deep floor."],
      acceptanceCriteria: ["Only current observations from this coordinator are accepted."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
  };
}

function graphTask(): TaskPlanRecord {
  const step = {
    stepId: uuid(20),
    title: "Coordinate evidence",
    description: "Validate and combine four branded observations.",
    acceptanceCriteria: ["The result remains shadow-only."],
  };
  const plan = {
    revisionId: PLAN_ID,
    revisionNumber: 1,
    status: "confirmed" as const,
    basedOnRequirementRevisionId: REQUIREMENT_ID,
    steps: [step],
  };
  return {
    ...requirementsTask(),
    taskVersion: 3,
    updatedAtMs: 300,
    latestPlan: plan,
    confirmedPlan: plan,
    activeGraph: {
      revisionId: GRAPH_ID,
      revisionNumber: 1,
      basedOnPlanRevisionId: PLAN_ID,
      nodes: [
        {
          nodeId: NODE_ID,
          sourcePlanStepId: step.stepId,
          title: step.title,
          description: step.description,
          acceptanceCriteria: step.acceptanceCriteria,
          dependsOnNodeIds: [],
          status: "pending" as const,
        },
      ],
      topologicalOrder: [NODE_ID],
    },
    lastGraphRevisionNumber: 1,
  };
}

const POLICY_SET: HarnessRouteEvidenceAuthorityPolicySet = {
  taskClassifier: "task-classifier.v1",
  toolPlanner: "tool-planner.v1",
  safetyObservers: {
    operation_plan: "operation-plan.v1",
    permission_plan: "permission-plan.v1",
    workspace_analysis: "workspace-analysis.v1",
    runtime_target: "runtime-target.v1",
  },
};

function createCoordinator(coordinatorSessionId = COORDINATOR_ID) {
  return createHarnessRouteEvidenceCoordinator({
    schemaVersion: 1,
    coordinatorSessionId,
    policySet: POLICY_SET,
  });
}

type BundleOptions = Readonly<{
  evidenceId?: string;
  times?: Partial<Readonly<Record<"operation" | "permission" | "workspace" | "runtime", number>>>;
  operations?: readonly HarnessRouteOperationKind[];
  permissionCapabilities?: readonly HarnessPermissionCapability[];
  workspaceFindings?: readonly HarnessWorkspaceFindingKind[];
  runtimeClasses?: readonly HarnessRuntimeEnvironmentClass[];
}>;

function makeBundle(
  coordinator: HarnessRouteEvidenceCoordinator,
  task: TaskPlanRecord,
  nodeId: string | null,
  options: BundleOptions = {},
): IssueHarnessCoordinatedRouteEvidenceInput {
  const times = {
    operation: options.times?.operation ?? 301,
    permission: options.times?.permission ?? 302,
    workspace: options.times?.workspace ?? 303,
    runtime: options.times?.runtime ?? 304,
  };
  const operationObservation = coordinator.observers.operationPlan.observe(task, nodeId, {
    schemaVersion: 1,
    manifestId: uuid(40),
    observedAtMs: times.operation,
    operations: (options.operations ?? ["answer"]).map((kind, index) => ({
      operationId: uuid(400 + index),
      kind,
    })),
  });
  const permissionObservation = coordinator.observers.permissionPlan.observe(task, nodeId, {
    schemaVersion: 1,
    permissionPlanId: uuid(41),
    observedAtMs: times.permission,
    complete: true,
    requests: (options.permissionCapabilities ?? []).map((capability, index) => ({
      permissionRequestId: uuid(500 + index),
      capability,
    })),
  });
  const workspaceObservation = coordinator.observers.workspaceAnalysis.observe(task, nodeId, {
    schemaVersion: 1,
    analysisId: uuid(42),
    workspaceSnapshotId: uuid(43),
    workspaceDigest: "a".repeat(64),
    observedAtMs: times.workspace,
    complete: true,
    findings: (options.workspaceFindings ?? []).map((kind, index) => ({
      findingId: uuid(600 + index),
      kind,
    })),
  });
  const runtimeTargetObservation = coordinator.observers.runtimeTarget.observe(task, nodeId, {
    schemaVersion: 1,
    runtimeTargetPlanId: uuid(44),
    runtimeInventorySnapshotId: uuid(45),
    runtimeInventoryDigest: "b".repeat(64),
    observedAtMs: times.runtime,
    complete: true,
    targets: (options.runtimeClasses ?? ["local"]).map((environmentClass, index) => ({
      runtimeTargetId: uuid(700 + index),
      environmentClass,
    })),
  });
  return {
    schemaVersion: 1,
    evidenceId: options.evidenceId ?? uuid(90),
    operationObservation,
    permissionObservation,
    workspaceObservation,
    runtimeTargetObservation,
  };
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

describe("Harness route evidence coordinator", () => {
  it("owns consistently configured observers and issues complete all-absent evidence", () => {
    const coordinator = createCoordinator();
    const task = graphTask();
    const snapshot = coordinator.issue(task, NODE_ID, makeBundle(coordinator, task, NODE_ID));

    expect(coordinator).toMatchObject({
      policyVersion: HARNESS_ROUTE_EVIDENCE_COORDINATOR_POLICY_VERSION,
      coordinatorSessionId: COORDINATOR_ID,
      policySet: POLICY_SET,
    });
    expect(coordinator.observers.operationPlan.policySet).toEqual({
      taskClassifier: POLICY_SET.taskClassifier,
      toolPlanner: POLICY_SET.toolPlanner,
      operationPlan: POLICY_SET.safetyObservers.operation_plan,
    });
    expect(coordinator.observers.permissionPlan.policySet).toEqual({
      permissionPlan: POLICY_SET.safetyObservers.permission_plan,
    });
    expect(coordinator.observers.workspaceAnalysis.policySet).toEqual({
      workspaceAnalysis: POLICY_SET.safetyObservers.workspace_analysis,
    });
    expect(coordinator.observers.runtimeTarget.policySet).toEqual({
      runtimeTarget: POLICY_SET.safetyObservers.runtime_target,
    });
    expect(snapshot).toMatchObject({
      mode: "shadow",
      executionAuthorized: false,
      authoritySessionId: COORDINATOR_ID,
      observedAtMs: 304,
      subject: { taskId: TASK_ID, taskVersion: 3, nodeId: NODE_ID },
      derived: {
        taskKind: { status: "observed", value: "simple" },
        toolBreadth: { status: "observed", value: "none", toolCount: 0 },
        completeForRouting: true,
      },
    });
    expect(Object.values(snapshot.derived.safety).every((item) => item.status === "absent")).toBe(
      true,
    );
    expect(coordinator.isVerified(snapshot)).toBe(true);
    expect(coordinator.isCurrent(task, snapshot)).toBe(true);
    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(Object.isFrozen(coordinator.observers)).toBe(true);
  });

  it("delegates multi-source present risk aggregation to the central authority", () => {
    const coordinator = createCoordinator();
    const task = graphTask();
    const snapshot = coordinator.issue(
      task,
      null,
      makeBundle(coordinator, task, null, {
        operations: [
          "architecture_decision",
          "database_migration",
          "irreversible_action",
          "permission_boundary_change",
          "public_api_change",
          "concurrent_change",
          "production_change",
        ],
        permissionCapabilities: ["credential_access"],
        workspaceFindings: ["security_boundary_change"],
        runtimeClasses: ["production_control_plane"],
      }),
    );

    expect(snapshot.derived.taskKind.value).toBe("architecture");
    expect(snapshot.derived.completeForRouting).toBe(true);
    for (const evidence of Object.values(snapshot.derived.safety)) {
      expect(evidence.status).toBe("present");
      expect(evidence.value).toBe(true);
    }
  });

  it("derives evidence time from the latest observation and normalizes report order", () => {
    const coordinator = createCoordinator();
    const task = graphTask();
    const snapshot = coordinator.issue(
      task,
      null,
      makeBundle(coordinator, task, null, {
        times: { operation: 330, permission: 310, workspace: 340, runtime: 320 },
      }),
    );

    expect(snapshot.observedAtMs).toBe(340);
    expect(snapshot.observations.safetyReports.map((report) => report.source)).toEqual([
      "operation_plan",
      "permission_plan",
      "workspace_analysis",
      "runtime_target",
    ]);
  });

  it("rejects observations from another coordinator even with identical session and policy", () => {
    const coordinator = createCoordinator();
    const other = createCoordinator();
    const task = graphTask();
    const input = makeBundle(coordinator, task, null);
    const foreign = makeBundle(other, task, null);

    expect(() =>
      coordinator.issue(task, null, {
        ...input,
        permissionObservation: foreign.permissionObservation,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_evidence_bundle" }));
  });

  it("rejects cloned and strictly decoded observations because they have no observer brand", () => {
    const coordinator = createCoordinator();
    const task = graphTask();
    const input = makeBundle(coordinator, task, null);
    const cloned = clone(input.operationObservation);
    const decoded = decodeHarnessOperationRouteObservation(cloned);

    for (const operationObservation of [cloned, decoded]) {
      expect(() => coordinator.issue(task, null, { ...input, operationObservation })).toThrowError(
        expect.objectContaining({ code: "invalid_evidence_bundle" }),
      );
    }
  });

  it("rejects cross-node subjects and mixed observation subjects", () => {
    const coordinator = createCoordinator();
    const task = graphTask();
    const nodeBundle = makeBundle(coordinator, task, NODE_ID);
    const taskBundle = makeBundle(coordinator, task, null);

    expect(() => coordinator.issue(task, null, nodeBundle)).toThrowError(
      expect.objectContaining({ code: "invalid_evidence_bundle" }),
    );
    expect(() =>
      coordinator.issue(task, NODE_ID, {
        ...nodeBundle,
        permissionObservation: taskBundle.permissionObservation,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_evidence_bundle" }));
  });

  it("rejects an old bundle after authoritative Task content or version changes", () => {
    const coordinator = createCoordinator();
    const task = graphTask();
    const input = makeBundle(coordinator, task, null);
    const changedContent = {
      ...task,
      activeRequirement: { ...task.activeRequirement, objective: "Changed without version bump." },
    };

    expect(() => coordinator.issue(changedContent, null, input)).toThrowError(
      expect.objectContaining({ code: "invalid_evidence_bundle" }),
    );
    expect(() => coordinator.issue({ ...task, taskVersion: 4 }, null, input)).toThrowError(
      expect.objectContaining({ code: "invalid_evidence_bundle" }),
    );
  });

  it("strictly validates issue input and never accepts caller-supplied derived fields", () => {
    const coordinator = createCoordinator();
    const task = graphTask();
    const valid = makeBundle(coordinator, task, null);
    const missing = { ...valid } as Partial<Record<keyof typeof valid, unknown>>;
    delete missing.workspaceObservation;
    const invalid = [
      null,
      { ...valid, schemaVersion: 2 },
      { ...valid, evidenceId: "invalid" },
      { ...valid, observedAtMs: 0 },
      missing,
    ];

    for (const candidate of invalid) {
      expect(() => coordinator.issue(task, null, candidate as never)).toThrowError(
        expect.objectContaining({ code: "invalid_evidence_bundle" }),
      );
    }
  });

  it("keeps final evidence authority local and never rebrands decoded JSON", () => {
    const coordinator = createCoordinator();
    const other = createCoordinator(OTHER_COORDINATOR_ID);
    const task = graphTask();
    const snapshot = coordinator.issue(task, null, makeBundle(coordinator, task, null));
    const decoded = decodeHarnessRouteEvidenceSnapshot(clone(snapshot));

    expect(decoded).toEqual(snapshot);
    expect(coordinator.isVerified(decoded)).toBe(false);
    expect(coordinator.isCurrent(task, decoded)).toBe(false);
    expect(other.isVerified(snapshot)).toBe(false);
    expect(other.isCurrent(task, snapshot)).toBe(false);
    expect(coordinator.isCurrent({ ...task, taskVersion: 4 }, snapshot)).toBe(false);
  });

  it("strictly validates coordinator configuration and exposes stable errors", () => {
    const invalidConfigs = [
      null,
      {},
      { schemaVersion: 2, coordinatorSessionId: COORDINATOR_ID, policySet: POLICY_SET },
      { schemaVersion: 1, coordinatorSessionId: "invalid", policySet: POLICY_SET },
      {
        schemaVersion: 1,
        coordinatorSessionId: COORDINATOR_ID,
        policySet: { ...POLICY_SET, extra: true },
      },
      {
        schemaVersion: 1,
        coordinatorSessionId: COORDINATOR_ID,
        policySet: {
          ...POLICY_SET,
          safetyObservers: { ...POLICY_SET.safetyObservers, runtime_target: "INVALID POLICY" },
        },
      },
    ];

    for (const candidate of invalidConfigs) {
      expect(() => createHarnessRouteEvidenceCoordinator(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_coordinator" }),
      );
    }

    const error = new HarnessRouteEvidenceCoordinatorError("invalid_evidence_bundle");
    expect(error.name).toBe("HarnessRouteEvidenceCoordinatorError");
    expect(error.code).toBe("invalid_evidence_bundle");
    expect(error.message).toBe("The Harness route evidence bundle is invalid.");
  });
});
