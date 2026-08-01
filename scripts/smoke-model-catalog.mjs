export async function smokeModelCatalog() {
  const { assessModelRoutingAvailability, createModelCatalogSnapshot } =
    await import("../apps/harnessd/dist/domain/model-catalog.js");
  const snapshot = createModelCatalogSnapshot({
    schemaVersion: 1,
    snapshotId: "00000000-0000-4000-8000-000000000501",
    workerSessionId: "00000000-0000-4000-8000-000000000511",
    provider: "openai",
    observedAtMs: 1_750_000_000_100,
    pages: [
      {
        requestCursor: null,
        includeHidden: true,
        response: {
          data: [
            catalogModel("cheap", ["low"]),
            catalogModel("code", ["medium"]),
            catalogModel("advanced", ["high"]),
          ],
          nextCursor: null,
        },
      },
    ],
  });
  const assessment = assessModelRoutingAvailability(
    {
      schemaVersion: 1,
      revisionId: "00000000-0000-4000-8000-000000000521",
      revisionNumber: 1,
      tiers: {
        fast: { provider: "openai", model: "cheap", reasoningEffort: "low" },
        standard: { provider: "openai", model: "code", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "advanced", reasoningEffort: "high" },
      },
    },
    [snapshot],
  );
  if (
    snapshot.models.length !== 3 ||
    !assessment.allObservedAvailable ||
    assessment.executionAuthorized ||
    assessment.tiers.deep.modelId !== "id-advanced"
  ) {
    throw new Error("The compiled model catalog smoke result was invalid.");
  }
}

function catalogModel(model, efforts) {
  return {
    id: `id-${model}`,
    model,
    hidden: false,
    defaultReasoningEffort: efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    inputModalities: ["text", "image"],
  };
}
