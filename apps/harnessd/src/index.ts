import { APPLICATION_PROTOCOL_VERSION } from "@codex-harness/protocol";

export const harnessDaemonBootstrapMetadata = Object.freeze({
  name: "harnessd",
  protocolVersion: APPLICATION_PROTOCOL_VERSION,
});

export * from "./connection/connection-session.js";
