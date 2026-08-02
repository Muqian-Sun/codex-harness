export async function smokeHarnessRouteEvidence() {
  const { createHarnessRouteEvidenceAuthority, decodeHarnessRouteEvidenceSnapshot } =
    await import("../apps/harnessd/dist/domain/harness-route-evidence.js");
  const authority = createHarnessRouteEvidenceAuthority({
    schemaVersion: 1,
    authoritySessionId: AUTHORITY_ID,
    policySet: {
      taskClassifier: "task-classifier.v1",
      toolPlanner: "tool-planner.v1",
      safetyObservers: {
        operation_plan: "operation_plan.v1",
        permission_plan: "permission_plan.v1",
        workspace_analysis: "workspace_analysis.v1",
        runtime_target: "runtime_target.v1",
      },
    },
  });
  const task = taskRecord();
  const snapshot = authority.issue(task, null, evidenceInput());
  const decoded = decodeHarnessRouteEvidenceSnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (
    snapshot.derived.taskKind.value !== "code_change" ||
    snapshot.derived.toolBreadth.value !== "multiple" ||
    !snapshot.derived.completeForRouting ||
    Object.values(snapshot.derived.safety).some(
      (evidence) => evidence.status !== "absent" || evidence.value !== false,
    ) ||
    snapshot.executionAuthorized !== false ||
    !authority.isVerified(snapshot) ||
    !authority.isCurrent(task, snapshot) ||
    authority.isVerified(decoded) ||
    authority.isCurrent(task, decoded)
  ) {
    throw new Error("The compiled Harness route evidence result was invalid.");
  }
}

const AUTHORITY_ID = "00000000-0000-4000-8000-000000000801";
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000802";
const TASK_ID = "00000000-0000-4000-8000-000000000803";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000804";

function taskRecord() {
  return {
    taskId: TASK_ID,
    title: "Compiled Harness route evidence smoke",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Issue process-local route evidence from complete Harness observations.",
      objective: "Verify the compiled evidence authority contract.",
      constraints: ["Decoded JSON remains unverified."],
      acceptanceCriteria: ["All safety coverage is explicit."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
  };
}

function evidenceInput() {
  return {
    schemaVersion: 1,
    evidenceId: EVIDENCE_ID,
    observedAtMs: 100,
    taskClassification: {
      source: "harness_task_classifier",
      policyVersion: "task-classifier.v1",
      taskKind: "code_change",
    },
    toolPlan: {
      source: "harness_tool_planner",
      policyVersion: "tool-planner.v1",
      complete: true,
      tools: ["workspace_read", "workspace_write"],
    },
    safetyReports: [
      report("operation_plan", [
        "concurrencySensitive",
        "dataMigration",
        "irreversibleOperation",
        "permissionBoundaryChange",
        "productionImpact",
        "publicApiChange",
      ]),
      report("permission_plan", [
        "irreversibleOperation",
        "permissionBoundaryChange",
        "securitySensitive",
      ]),
      report("workspace_analysis", [
        "concurrencySensitive",
        "dataMigration",
        "publicApiChange",
        "securitySensitive",
      ]),
      report("runtime_target", ["productionImpact"]),
    ],
  };
}

function report(source, signals) {
  return {
    source,
    policyVersion: `${source}.v1`,
    observations: Object.fromEntries(signals.map((signal) => [signal, "absent"])),
  };
}
