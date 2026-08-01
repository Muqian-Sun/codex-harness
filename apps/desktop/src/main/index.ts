import { APPLICATION_PROTOCOL_VERSION } from "@codex-harness/protocol";

export const desktopBootstrapMetadata = Object.freeze({
  name: "codex-harness-desktop",
  protocolVersion: APPLICATION_PROTOCOL_VERSION,
});

export * from "./harness-rpc-client.js";
