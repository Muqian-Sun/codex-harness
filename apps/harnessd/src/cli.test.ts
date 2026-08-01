import { describe, expect, it } from "vitest";

import { DaemonCliError, parseDaemonArguments } from "./cli.js";

describe("harnessd command arguments", () => {
  it("accepts exactly one explicit endpoint", () => {
    expect(parseDaemonArguments(["--endpoint", "/private/runtime/harnessd.sock"])).toEqual({
      endpoint: "/private/runtime/harnessd.sock",
    });
  });

  it("rejects missing, duplicate, and unknown arguments with a fixed error", () => {
    const invalidArguments = [
      [],
      ["--endpoint"],
      ["--endpoint", ""],
      ["--endpoint", "/tmp/harnessd.sock", "--extra"],
      ["--secret", "sentinel-secret"],
    ];
    for (const args of invalidArguments) {
      expect(() => parseDaemonArguments(args)).toThrow(DaemonCliError);
      try {
        parseDaemonArguments(args);
      } catch (error: unknown) {
        expect(error).toMatchObject({
          code: "invalid_arguments",
          message: "The daemon command arguments are invalid.",
        });
        expect(String(error)).not.toContain("sentinel-secret");
      }
    }
  });
});
