import { APPLICATION_PROTOCOL_VERSION } from "@codex-harness/protocol";

import { HARNESS_DAEMON_VERSION } from "./version.js";

export const harnessDaemonBootstrapMetadata = Object.freeze({
  name: "harnessd",
  version: HARNESS_DAEMON_VERSION,
  protocolVersion: APPLICATION_PROTOCOL_VERSION,
});

export * from "./connection/connection-session.js";
export * from "./version.js";
