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

const { smokeDaemonRuntime } = await import("./smoke-daemon-runtime.mjs");
await smokeDaemonRuntime();
