import { describe, expect, it } from "vitest";

import { assertSupportedProtocolVersion, UnsupportedProtocolVersionError } from "./version.js";

describe("assertSupportedProtocolVersion", () => {
  it("accepts the supported version", () => {
    expect(() => assertSupportedProtocolVersion("1.0")).not.toThrow();
  });

  it("rejects unsupported versions without echoing untrusted input", () => {
    const sentinel = "sentinel-secret-version";
    expect(() => assertSupportedProtocolVersion(sentinel)).toThrow(UnsupportedProtocolVersionError);
    try {
      assertSupportedProtocolVersion(sentinel);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });
});
