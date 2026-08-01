import { describe, expect, it } from "vitest";

import {
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  MAX_APPLICATION_VERSION_COUNT,
  MAX_CAPABILITY_COUNT,
  RPC_ERROR_CODES,
} from "./constants.js";
import { negotiateHello } from "./negotiation.js";
import { createHelloParams } from "./test-fixtures.js";

describe("negotiateHello", () => {
  it("uses server version and capability preference order", () => {
    const hello = createHelloParams();
    hello.supportedProtocolVersions = ["1.0", "2.0"];
    hello.capabilities.supported = ["feature.a.v1", "feature.b.v1"];

    const result = negotiateHello(hello, {
      supportedProtocolVersions: ["2.0", "1.0"],
      capabilities: ["feature.b.v1", "feature.a.v1"],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        selectedProtocolVersion: "2.0",
        enabledCapabilities: ["feature.b.v1", "feature.a.v1"],
      },
    });
  });

  it("ignores unknown optional capabilities and accepts empty sets", () => {
    const hello = createHelloParams();
    hello.capabilities = { supported: ["client.optional.v1"], required: [] };

    expect(
      negotiateHello(hello, {
        supportedProtocolVersions: ["1.0"],
        capabilities: [],
      }),
    ).toEqual({
      ok: true,
      value: { selectedProtocolVersion: "1.0", enabledCapabilities: [] },
    });
  });

  it("fails closed when no application version overlaps", () => {
    const result = negotiateHello(createHelloParams(), {
      supportedProtocolVersions: ["2.0"],
      capabilities: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RPC_ERROR_CODES.unsupportedProtocolVersion);
    }
  });

  it("rejects an unavailable required capability", () => {
    const hello = createHelloParams();
    hello.capabilities = {
      supported: ["feature.required.v1"],
      required: ["feature.required.v1"],
    };

    const result = negotiateHello(hello, {
      supportedProtocolVersions: ["1.0"],
      capabilities: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RPC_ERROR_CODES.unsupportedCapability);
    }
  });

  it("rejects duplicate or oversized client and server sets", () => {
    const duplicateClient = createHelloParams();
    duplicateClient.supportedProtocolVersions = ["1.0", "1.0"];
    const clientResult = negotiateHello(duplicateClient, {
      supportedProtocolVersions: ["1.0"],
      capabilities: [],
    });
    expect(clientResult.ok).toBe(false);
    if (!clientResult.ok) {
      expect(clientResult.error.code).toBe(RPC_ERROR_CODES.invalidMessage);
    }

    const invalidServerConfigs = [
      {
        supportedProtocolVersions: ["1.0", "1.0"],
        capabilities: [],
      },
      {
        supportedProtocolVersions: ["1.0"],
        capabilities: ["feature.a.v1", "feature.a.v1"],
      },
      {
        supportedProtocolVersions: Array.from(
          { length: MAX_APPLICATION_VERSION_COUNT + 1 },
          (_, index) => `1.${index}`,
        ),
        capabilities: [],
      },
      {
        supportedProtocolVersions: ["1.0"],
        capabilities: Array.from(
          { length: MAX_CAPABILITY_COUNT + 1 },
          (_, index) => `feature.f${index}`,
        ),
      },
    ];

    for (const serverConfig of invalidServerConfigs) {
      const serverResult = negotiateHello(createHelloParams(), serverConfig);
      expect(serverResult.ok).toBe(false);
      if (!serverResult.ok) {
        expect(serverResult.error).toEqual({
          code: RPC_ERROR_CODES.internalError,
          message: INTERNAL_ERROR_PUBLIC_MESSAGE,
        });
      }
    }
  });
});
