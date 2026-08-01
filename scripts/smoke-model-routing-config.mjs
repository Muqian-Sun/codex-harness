export async function smokeModelRoutingConfiguration() {
  const { normalizeModelRoutingConfiguration, resolveModelTier } =
    await import("../apps/harnessd/dist/domain/model-routing-config.js");
  const configuration = normalizeModelRoutingConfiguration({
    schemaVersion: 1,
    revisionId: "00000000-0000-4000-8000-000000000101",
    revisionNumber: 1,
    tiers: {
      fast: { provider: "local", model: "cheap", reasoningEffort: "low" },
      standard: { provider: "local", model: "code", reasoningEffort: "medium" },
      deep: { provider: "remote", model: "advanced", reasoningEffort: "high" },
    },
  });
  const resolved = resolveModelTier(configuration, "deep");
  if (
    resolved.tier !== "deep" ||
    resolved.configurationRevisionNumber !== 1 ||
    resolved.provider !== "remote" ||
    resolved.model !== "advanced" ||
    resolved.reasoningEffort !== "high" ||
    !Object.isFrozen(resolved)
  ) {
    throw new Error("The compiled model routing configuration smoke result was invalid.");
  }
}
