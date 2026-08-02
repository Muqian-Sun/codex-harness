export async function smokeHarnessRuntimeTargetRouteObserver() {
  const { createHarnessRuntimeTargetRouteObserver, decodeHarnessRuntimeTargetRouteObservation } =
    await import("../apps/harnessd/dist/domain/harness-runtime-target-route-observer.js");
  const observer = createHarnessRuntimeTargetRouteObserver({
    schemaVersion: 1,
    observerSessionId: OBSERVER_ID,
    policySet: { runtimeTarget: "runtime-target.v1" },
  });
  const task = taskRecord();
  const observation = observer.observe(task, null, {
    schemaVersion: 1,
    runtimeTargetPlanId: RUNTIME_TARGET_PLAN_ID,
    runtimeInventorySnapshotId: RUNTIME_INVENTORY_SNAPSHOT_ID,
    runtimeInventoryDigest: "c".repeat(64),
    observedAtMs: 100,
    complete: true,
    targets: [
      {
        runtimeTargetId: RUNTIME_TARGET_ID,
        environmentClass: "production_control_plane",
      },
    ],
  });
  const decoded = decodeHarnessRuntimeTargetRouteObservation(
    JSON.parse(JSON.stringify(observation)),
  );
  if (
    observation.runtimeTargetSafetyReport.observations.productionImpact !== "present" ||
    observation.executionAuthorized !== false ||
    observation.complete !== true ||
    !observer.isVerified(observation) ||
    !observer.isCurrent(task, observation) ||
    observer.isVerified(decoded) ||
    observer.isCurrent(task, decoded)
  ) {
    throw new Error("The compiled Harness runtime target route observation was invalid.");
  }
}

const OBSERVER_ID = "00000000-0000-4000-8000-000000000c01";
const RUNTIME_TARGET_PLAN_ID = "00000000-0000-4000-8000-000000000c02";
const RUNTIME_INVENTORY_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000c03";
const RUNTIME_TARGET_ID = "00000000-0000-4000-8000-000000000c04";
const TASK_ID = "00000000-0000-4000-8000-000000000c05";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000c06";

function taskRecord() {
  return {
    taskId: TASK_ID,
    title: "Compiled Harness runtime target route observer smoke",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe a complete runtime target plan.",
      objective: "Verify the compiled runtime target route observer contract.",
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
