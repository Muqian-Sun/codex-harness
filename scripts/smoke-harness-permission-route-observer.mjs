export async function smokeHarnessPermissionRouteObserver() {
  const { createHarnessPermissionRouteObserver, decodeHarnessPermissionRouteObservation } =
    await import("../apps/harnessd/dist/domain/harness-permission-route-observer.js");
  const observer = createHarnessPermissionRouteObserver({
    schemaVersion: 1,
    observerSessionId: OBSERVER_ID,
    policySet: { permissionPlan: "permission-plan.v1" },
  });
  const task = taskRecord();
  const observation = observer.observe(task, null, {
    schemaVersion: 1,
    permissionPlanId: PERMISSION_PLAN_ID,
    observedAtMs: 100,
    complete: true,
    requests: [
      { permissionRequestId: REQUEST_ID_1, capability: "credential_access" },
      {
        permissionRequestId: REQUEST_ID_2,
        capability: "irreversible_external_write",
      },
    ],
  });
  const decoded = decodeHarnessPermissionRouteObservation(JSON.parse(JSON.stringify(observation)));
  const safety = observation.permissionPlanSafetyReport.observations;
  if (
    safety.securitySensitive !== "present" ||
    safety.irreversibleOperation !== "present" ||
    safety.permissionBoundaryChange !== "absent" ||
    observation.executionAuthorized !== false ||
    observation.complete !== true ||
    !observer.isVerified(observation) ||
    !observer.isCurrent(task, observation) ||
    observer.isVerified(decoded) ||
    observer.isCurrent(task, decoded)
  ) {
    throw new Error("The compiled Harness permission route observation was invalid.");
  }
}

const OBSERVER_ID = "00000000-0000-4000-8000-000000000a01";
const PERMISSION_PLAN_ID = "00000000-0000-4000-8000-000000000a02";
const REQUEST_ID_1 = "00000000-0000-4000-8000-000000000a03";
const REQUEST_ID_2 = "00000000-0000-4000-8000-000000000a04";
const TASK_ID = "00000000-0000-4000-8000-000000000a05";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000a06";

function taskRecord() {
  return {
    taskId: TASK_ID,
    title: "Compiled Harness permission route observer smoke",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe a complete permission request plan.",
      objective: "Verify the compiled permission route observer contract.",
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
