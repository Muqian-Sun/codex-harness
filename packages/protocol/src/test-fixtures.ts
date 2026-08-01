import { APPLICATION_PROTOCOL_VERSION, BOOTSTRAP_WIRE_VERSION } from "./constants.js";
import type {
  BootstrapHelloRequest,
  BootstrapHelloResponse,
  RpcRequest,
  SystemHelloParams,
} from "./schemas.js";

export const TEST_STARTUP_CAPABILITY = "A".repeat(43);
export const TEST_STREAM_ID = "B".repeat(21) + "A";

export function createHelloParams(): SystemHelloParams {
  return {
    client: { name: "CodexHarnessDesktop", version: "0.0.0" },
    supportedProtocolVersions: [APPLICATION_PROTOCOL_VERSION],
    capabilities: {
      supported: ["harness.events.replay.v1"],
      required: [],
    },
    startupCapability: TEST_STARTUP_CAPABILITY,
  };
}

export function createBootstrapRequest(): BootstrapHelloRequest {
  return {
    kind: "bootstrap-request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    id: "hello-1",
    method: "system.hello",
    params: createHelloParams(),
  };
}

export function createBootstrapResponse(): BootstrapHelloResponse {
  return {
    kind: "bootstrap-response",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    id: "hello-1",
    result: {
      selectedProtocolVersion: APPLICATION_PROTOCOL_VERSION,
      server: { name: "harnessd", version: "0.0.0" },
      enabledCapabilities: [],
      stream: {
        id: TEST_STREAM_ID,
        nextSequence: 1,
        replayWindowStart: 1,
        resyncRequired: false,
      },
    },
  };
}

export function createRpcRequest(): RpcRequest {
  return {
    kind: "request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id: "request-1",
    method: "system.health",
    params: {},
  };
}
