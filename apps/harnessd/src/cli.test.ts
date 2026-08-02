import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DaemonCliError, parseDaemonArguments } from "./cli.js";

describe("harnessd command arguments", () => {
  const codexExecutable = resolve("fake-codex");
  const stateDatabasePath = resolve("state", "harness.db");

  it("accepts exactly one explicit endpoint, Codex executable, and state database", () => {
    expect(
      parseDaemonArguments([
        "--endpoint",
        "/private/runtime/harnessd.sock",
        "--codex-executable",
        codexExecutable,
        "--state-database",
        stateDatabasePath,
      ]),
    ).toEqual({
      endpoint: "/private/runtime/harnessd.sock",
      codexExecutable,
      stateDatabasePath,
    });
  });

  it("rejects missing, duplicate, reordered, unknown, and unsafe arguments with a fixed error", () => {
    const invalidArguments = [
      [],
      ["--endpoint"],
      ["--endpoint", ""],
      ["--endpoint", "/tmp/harnessd.sock", "--extra"],
      ["--secret", "sentinel-secret"],
      ["--endpoint", "/tmp/harnessd.sock", "--codex-executable"],
      ["--endpoint", "/tmp/harnessd.sock", "--codex-executable", "relative-codex"],
      ["--endpoint", "/tmp/harnessd.sock", "--codex-executable", ""],
      ["--endpoint", "/tmp/has\0sentinel-secret", "--codex-executable", codexExecutable],
      ["--endpoint", "/tmp/harnessd.sock", "--codex-executable", `${codexExecutable}\0x`],
      [
        "--endpoint",
        "/tmp/harnessd.sock",
        "--codex-executable",
        codexExecutable,
        "--state-database",
      ],
      [
        "--endpoint",
        "/tmp/harnessd.sock",
        "--codex-executable",
        codexExecutable,
        "--state-database",
        "relative/harness.db",
      ],
      [
        "--endpoint",
        "/tmp/harnessd.sock",
        "--codex-executable",
        codexExecutable,
        "--state-database",
        resolve("state", "other.db"),
      ],
      ["--codex-executable", codexExecutable, "--endpoint", "/tmp/harnessd.sock"],
      [
        "--endpoint",
        "/tmp/harnessd.sock",
        "--codex-executable",
        codexExecutable,
        "--state-database",
        stateDatabasePath,
        "--codex-executable",
        codexExecutable,
      ],
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
