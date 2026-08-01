export async function smokeShadowRouteFeatureSnapshot() {
  const {
    buildShadowRouteFeatureSnapshot,
    decodeShadowRouteFeatureSnapshot,
    isShadowRouteFeatureSnapshotCurrent,
  } = await import("../apps/harnessd/dist/domain/shadow-route-feature-snapshot.js");
  const task = taskRecord();
  const snapshot = buildShadowRouteFeatureSnapshot(task, null, {
    source: "model",
    features: advisoryFeatures(),
  });
  const decoded = decodeShadowRouteFeatureSnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (
    decoded.effectiveFeatures.taskKind !== "analysis" ||
    decoded.effectiveFeatures.ambiguity !== "high" ||
    decoded.effectiveFeatures.toolBreadth !== "multiple" ||
    decoded.routingFloorTier !== "deep" ||
    decoded.unresolvedSafetySignals.length !== 7 ||
    decoded.executionAuthorized !== false ||
    !isShadowRouteFeatureSnapshotCurrent(task, decoded)
  ) {
    throw new Error("The compiled shadow route feature snapshot result was invalid.");
  }
}

const TASK_ID = "00000000-0000-4000-8000-000000000751";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000752";

function taskRecord() {
  return {
    taskId: TASK_ID,
    title: "Compiled route feature provenance smoke",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Do not trust a model-provided low-risk route candidate.",
      objective: "Build a fresh conservative feature snapshot.",
      constraints: ["Unknown safety remains unresolved."],
      acceptanceCriteria: ["The snapshot remains non-executable."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
  };
}

function advisoryFeatures() {
  return {
    schemaVersion: 1,
    taskKind: "simple",
    complexity: "low",
    scope: "isolated",
    ambiguity: "low",
    estimatedSteps: 1,
    toolBreadth: "none",
    safety: {
      securitySensitive: false,
      dataMigration: false,
      concurrencySensitive: false,
      publicApiChange: false,
      productionImpact: false,
      irreversibleOperation: false,
      permissionBoundaryChange: false,
    },
  };
}
