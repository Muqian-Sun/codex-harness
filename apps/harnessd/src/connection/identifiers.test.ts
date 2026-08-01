import { STREAM_ID_PATTERN } from "@codex-harness/protocol";
import { describe, expect, it } from "vitest";

import { generateStreamId, startupCapabilitiesEqual } from "./identifiers.js";

describe("connection identifiers", () => {
  it("generates canonical stream identifiers at the required entropy size", () => {
    const streamId = generateStreamId();
    expect(streamId).toHaveLength(22);
    expect(streamId).toMatch(STREAM_ID_PATTERN);
    expect(Buffer.from(streamId, "base64url")).toHaveLength(16);
  });

  it("compares only valid canonical capabilities", () => {
    const expected = "A".repeat(43);
    const different = `${"B".repeat(42)}A`;
    expect(startupCapabilitiesEqual(expected, expected)).toBe(true);
    expect(startupCapabilitiesEqual(expected, different)).toBe(false);
    expect(startupCapabilitiesEqual(expected, "invalid-secret")).toBe(false);
  });
});
