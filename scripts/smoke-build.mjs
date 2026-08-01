const buildArtifacts = [
  "../packages/protocol/dist/index.js",
  "../packages/app-server-adapter/dist/index.js",
  "../apps/harnessd/dist/index.js",
  "../apps/desktop/dist/main/index.js",
];

for (const artifact of buildArtifacts) {
  await import(new URL(artifact, import.meta.url));
}
