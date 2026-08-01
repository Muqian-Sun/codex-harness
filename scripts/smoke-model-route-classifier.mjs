export async function smokeModelRouteClassifier() {
  const { normalizeModelRoutingConfiguration } =
    await import("../apps/harnessd/dist/domain/model-routing-config.js");
  const { classifyShadowModelRoute } =
    await import("../apps/harnessd/dist/domain/model-route-classifier.js");
  const configuration = normalizeModelRoutingConfiguration({
    schemaVersion: 1,
    revisionId: "00000000-0000-4000-8000-000000000201",
    revisionNumber: 1,
    tiers: {
      fast: { provider: "local", model: "cheap", reasoningEffort: "low" },
      standard: { provider: "local", model: "code", reasoningEffort: "medium" },
      deep: { provider: "remote", model: "advanced", reasoningEffort: "high" },
    },
  });
  const decision = classifyShadowModelRoute(
    {
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
        permissionBoundaryChange: true,
      },
    },
    configuration,
  );
  if (
    decision.mode !== "shadow" ||
    decision.executionAuthorized !== false ||
    decision.candidateTier !== "fast" ||
    decision.safetyFloorTier !== "deep" ||
    decision.selectedTier !== "deep" ||
    decision.resolvedTarget.model !== "advanced" ||
    decision.safetyReasons[0] !== "risk_permission_boundary_change"
  ) {
    throw new Error("The compiled shadow model route classifier smoke result was invalid.");
  }
}
