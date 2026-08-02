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

const { smokeShadowRouteFeatureSnapshot } =
  await import("./smoke-shadow-route-feature-snapshot.mjs");
await smokeShadowRouteFeatureSnapshot();

const { smokeHarnessRouteEvidence } = await import("./smoke-harness-route-evidence.mjs");
await smokeHarnessRouteEvidence();

const { smokeHarnessOperationRouteObserver } =
  await import("./smoke-harness-operation-route-observer.mjs");
await smokeHarnessOperationRouteObserver();

const { smokeHarnessPermissionRouteObserver } =
  await import("./smoke-harness-permission-route-observer.mjs");
await smokeHarnessPermissionRouteObserver();

const { smokeHarnessWorkspaceRouteObserver } =
  await import("./smoke-harness-workspace-route-observer.mjs");
await smokeHarnessWorkspaceRouteObserver();

const { smokeHarnessRuntimeTargetRouteObserver } =
  await import("./smoke-harness-runtime-target-route-observer.mjs");
await smokeHarnessRuntimeTargetRouteObserver();

const { smokeHarnessRouteEvidenceCoordinator } =
  await import("./smoke-harness-route-evidence-coordinator.mjs");
await smokeHarnessRouteEvidenceCoordinator();

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

const { smokeSharedDomainRepositories } = await import("./smoke-shared-domain-repositories.mjs");
await smokeSharedDomainRepositories();

const { smokeAppServerWorker } = await import("./smoke-app-server-worker.mjs");
await smokeAppServerWorker();

const { smokeAppServerWorkerManager } = await import("./smoke-app-server-worker-manager.mjs");
await smokeAppServerWorkerManager();

const { smokeDaemonRuntime } = await import("./smoke-daemon-runtime.mjs");
await smokeDaemonRuntime();

const { smokeDesktopApplication } = await import("./smoke-desktop-application.mjs");
await smokeDesktopApplication();
