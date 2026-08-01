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

const { smokeDaemonRuntime } = await import("./smoke-daemon-runtime.mjs");
await smokeDaemonRuntime();
