import { describe, expect, it } from "vitest";

import packageMetadata from "../package.json" with { type: "json" };
import { harnessDaemonBootstrapMetadata } from "./index.js";
import { HARNESS_DAEMON_VERSION } from "./version.js";

describe("harness daemon version", () => {
  it("uses one version for the executable and bootstrap metadata", () => {
    expect(HARNESS_DAEMON_VERSION).toBe(packageMetadata.version);
    expect(harnessDaemonBootstrapMetadata.version).toBe(HARNESS_DAEMON_VERSION);
  });
});
