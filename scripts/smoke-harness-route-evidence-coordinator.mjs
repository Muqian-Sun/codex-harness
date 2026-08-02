export async function smokeHarnessRouteEvidenceCoordinator() {
  const { createHarnessRouteEvidenceCoordinator } =
    await import("../apps/harnessd/dist/domain/harness-route-evidence-coordinator.js");
  const { decodeHarnessRouteEvidenceSnapshot } =
    await import("../apps/harnessd/dist/domain/harness-route-evidence.js");
  const coordinator = createHarnessRouteEvidenceCoordinator({
    schemaVersion: 1,
    coordinatorSessionId: COORDINATOR_ID,
    policySet: {
      taskClassifier: "task-classifier.v1",
      toolPlanner: "tool-planner.v1",
      safetyObservers: {
        operation_plan: "operation-plan.v1",
        permission_plan: "permission-plan.v1",
        workspace_analysis: "workspace-analysis.v1",
        runtime_target: "runtime-target.v1",
      },
    },
  });
  const task = taskRecord();
  const nodeId = null;
  const operationObservation = coordinator.observers.operationPlan.observe(task, nodeId, {
    schemaVersion: 1,
    manifestId: MANIFEST_ID,
    observedAtMs: 101,
    operations: [{ operationId: OPERATION_ID, kind: "inspect_workspace" }],
  });
  const permissionObservation = coordinator.observers.permissionPlan.observe(task, nodeId, {
    schemaVersion: 1,
    permissionPlanId: PERMISSION_PLAN_ID,
    observedAtMs: 102,
    complete: true,
    requests: [],
  });
  const workspaceObservation = coordinator.observers.workspaceAnalysis.observe(task, nodeId, {
    schemaVersion: 1,
    analysisId: ANALYSIS_ID,
    workspaceSnapshotId: WORKSPACE_SNAPSHOT_ID,
    workspaceDigest: "a".repeat(64),
    observedAtMs: 103,
    complete: true,
    findings: [],
  });
  const runtimeTargetObservation = coordinator.observers.runtimeTarget.observe(task, nodeId, {
    schemaVersion: 1,
    runtimeTargetPlanId: RUNTIME_TARGET_PLAN_ID,
    runtimeInventorySnapshotId: RUNTIME_INVENTORY_SNAPSHOT_ID,
    runtimeInventoryDigest: "b".repeat(64),
    observedAtMs: 104,
    complete: true,
    targets: [{ runtimeTargetId: RUNTIME_TARGET_ID, environmentClass: "local" }],
  });
  const evidence = coordinator.issue(task, nodeId, {
    schemaVersion: 1,
    evidenceId: EVIDENCE_ID,
    operationObservation,
    permissionObservation,
    workspaceObservation,
    runtimeTargetObservation,
  });
  const decoded = decodeHarnessRouteEvidenceSnapshot(JSON.parse(JSON.stringify(evidence)));
  if (
    evidence.observedAtMs !== 104 ||
    evidence.derived.completeForRouting !== true ||
    Object.values(evidence.derived.safety).some((item) => item.status === "unresolved") ||
    evidence.executionAuthorized !== false ||
    !coordinator.isVerified(evidence) ||
    !coordinator.isCurrent(task, evidence) ||
    coordinator.isVerified(decoded) ||
    coordinator.isCurrent(task, decoded)
  ) {
    throw new Error("The compiled Harness route evidence coordinator result was invalid.");
  }
}

const COORDINATOR_ID = "00000000-0000-4000-8000-000000000d01";
const MANIFEST_ID = "00000000-0000-4000-8000-000000000d02";
const OPERATION_ID = "00000000-0000-4000-8000-000000000d03";
const PERMISSION_PLAN_ID = "00000000-0000-4000-8000-000000000d04";
const ANALYSIS_ID = "00000000-0000-4000-8000-000000000d05";
const WORKSPACE_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000d06";
const RUNTIME_TARGET_PLAN_ID = "00000000-0000-4000-8000-000000000d07";
const RUNTIME_INVENTORY_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000d08";
const RUNTIME_TARGET_ID = "00000000-0000-4000-8000-000000000d09";
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000d0a";
const TASK_ID = "00000000-0000-4000-8000-000000000d0b";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000d0c";

function taskRecord() {
  return {
    taskId: TASK_ID,
    title: "Compiled Harness route evidence coordinator smoke",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Coordinate four branded observations.",
      objective: "Verify the compiled route evidence coordinator contract.",
      constraints: ["The coordinated evidence remains non-executable."],
      acceptanceCriteria: ["Decoded JSON remains unverified."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
  };
}
