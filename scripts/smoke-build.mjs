const buildArtifacts = [
  "../packages/protocol/dist/index.js",
  "../packages/app-server-adapter/dist/index.js",
  "../apps/harnessd/dist/index.js",
  "../apps/desktop/dist/main/index.js",
];

for (const artifact of buildArtifacts) {
  await import(new URL(artifact, import.meta.url));
}

const { smokeEventStore } = await import("./smoke-event-store.mjs");
await smokeEventStore();

const { smokeTaskPlanStore } = await import("./smoke-task-plan-store.mjs");
await smokeTaskPlanStore();

const { smokeModelRoutingConfiguration } = await import("./smoke-model-routing-config.mjs");
await smokeModelRoutingConfiguration();

const { smokeModelRouteClassifier } = await import("./smoke-model-route-classifier.mjs");
await smokeModelRouteClassifier();

const { smokeModelCatalog } = await import("./smoke-model-catalog.mjs");
await smokeModelCatalog();

const { smokeModelRoutingProfileRepository } =
  await import("./smoke-model-routing-profile-repository.mjs");
await smokeModelRoutingProfileRepository();

const { smokeShadowRouteDecisionRepository } =
  await import("./smoke-shadow-route-decision-repository.mjs");
await smokeShadowRouteDecisionRepository();

const { smokeProjectRoutingProfileBinding } =
  await import("./smoke-project-routing-profile-binding.mjs");
await smokeProjectRoutingProfileBinding();

const { smokeDaemonRuntime } = await import("./smoke-daemon-runtime.mjs");
await smokeDaemonRuntime();
