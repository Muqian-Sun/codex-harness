export async function smokeHarnessOperationRouteObserver() {
  const { createHarnessOperationRouteObserver, decodeHarnessOperationRouteObservation } =
    await import("../apps/harnessd/dist/domain/harness-operation-route-observer.js");
  const observer = createHarnessOperationRouteObserver({
    schemaVersion: 1,
    observerSessionId: OBSERVER_ID,
    policySet: {
      taskClassifier: "task-classifier.v1",
      toolPlanner: "tool-planner.v1",
      operationPlan: "operation-plan.v1",
    },
  });
  const task = taskRecord();
  const observation = observer.observe(task, null, {
    schemaVersion: 1,
    manifestId: MANIFEST_ID,
    observedAtMs: 100,
    operations: [
      { operationId: OPERATION_ID_1, kind: "inspect_workspace" },
      { operationId: OPERATION_ID_2, kind: "database_migration" },
    ],
  });
  const decoded = decodeHarnessOperationRouteObservation(JSON.parse(JSON.stringify(observation)));
  const safety = observation.routeEvidence.operationPlanSafetyReport.observations;
  if (
    observation.routeEvidence.taskClassification.taskKind !== "code_change" ||
    observation.routeEvidence.toolPlan.complete !== true ||
    observation.routeEvidence.toolPlan.tools.join(",") !==
      "workspace_read,workspace_write,command_execution" ||
    safety.dataMigration !== "present" ||
    safety.productionImpact !== "absent" ||
    observation.executionAuthorized !== false ||
    !observer.isVerified(observation) ||
    !observer.isCurrent(task, observation) ||
    observer.isVerified(decoded) ||
    observer.isCurrent(task, decoded)
  ) {
    throw new Error("The compiled Harness operation route observation was invalid.");
  }
}

const OBSERVER_ID = "00000000-0000-4000-8000-000000000901";
const MANIFEST_ID = "00000000-0000-4000-8000-000000000902";
const OPERATION_ID_1 = "00000000-0000-4000-8000-000000000903";
const OPERATION_ID_2 = "00000000-0000-4000-8000-000000000904";
const TASK_ID = "00000000-0000-4000-8000-000000000905";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000906";

function taskRecord() {
  return {
    taskId: TASK_ID,
    title: "Compiled Harness operation route observer smoke",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe a complete, closed operation manifest.",
      objective: "Verify the compiled operation route observer contract.",
      constraints: ["The observation remains non-executable."],
      acceptanceCriteria: ["Decoded JSON remains unverified."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
  };
}
