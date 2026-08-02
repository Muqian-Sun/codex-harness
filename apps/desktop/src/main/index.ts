import { APPLICATION_PROTOCOL_VERSION } from "@codex-harness/protocol";

export const desktopBootstrapMetadata = Object.freeze({
  name: "codex-harness-desktop",
  version: "0.0.0",
  protocolVersion: APPLICATION_PROTOCOL_VERSION,
});

export * from "./harness-rpc-client.js";
export * from "./daemon-process-supervisor.js";
