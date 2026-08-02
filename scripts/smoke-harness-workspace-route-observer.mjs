export async function smokeHarnessWorkspaceRouteObserver() {
  const { createHarnessWorkspaceRouteObserver, decodeHarnessWorkspaceRouteObservation } =
    await import("../apps/harnessd/dist/domain/harness-workspace-route-observer.js");
  const observer = createHarnessWorkspaceRouteObserver({
    schemaVersion: 1,
    observerSessionId: OBSERVER_ID,
    policySet: { workspaceAnalysis: "workspace-analysis.v1" },
  });
  const task = taskRecord();
  const observation = observer.observe(task, null, {
    schemaVersion: 1,
    analysisId: ANALYSIS_ID,
    workspaceSnapshotId: WORKSPACE_SNAPSHOT_ID,
    workspaceDigest: "a".repeat(64),
    observedAtMs: 100,
    complete: true,
    findings: [
      { findingId: FINDING_ID_1, kind: "shared_mutable_state_change" },
      { findingId: FINDING_ID_2, kind: "database_schema_change" },
      { findingId: FINDING_ID_3, kind: "protocol_contract_change" },
      { findingId: FINDING_ID_4, kind: "security_boundary_change" },
    ],
  });
  const decoded = decodeHarnessWorkspaceRouteObservation(JSON.parse(JSON.stringify(observation)));
  const safety = observation.workspaceAnalysisSafetyReport.observations;
  if (
    safety.concurrencySensitive !== "present" ||
    safety.dataMigration !== "present" ||
    safety.publicApiChange !== "present" ||
    safety.securitySensitive !== "present" ||
    observation.executionAuthorized !== false ||
    observation.complete !== true ||
    !observer.isVerified(observation) ||
    !observer.isCurrent(task, observation) ||
    observer.isVerified(decoded) ||
    observer.isCurrent(task, decoded)
  ) {
    throw new Error("The compiled Harness workspace route observation was invalid.");
  }
}

const OBSERVER_ID = "00000000-0000-4000-8000-000000000b01";
const ANALYSIS_ID = "00000000-0000-4000-8000-000000000b02";
const WORKSPACE_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000b03";
const FINDING_ID_1 = "00000000-0000-4000-8000-000000000b04";
const FINDING_ID_2 = "00000000-0000-4000-8000-000000000b05";
const FINDING_ID_3 = "00000000-0000-4000-8000-000000000b06";
const FINDING_ID_4 = "00000000-0000-4000-8000-000000000b07";
const TASK_ID = "00000000-0000-4000-8000-000000000b08";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000b09";

function taskRecord() {
  return {
    taskId: TASK_ID,
    title: "Compiled Harness workspace route observer smoke",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe a complete workspace analysis.",
      objective: "Verify the compiled workspace route observer contract.",
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
