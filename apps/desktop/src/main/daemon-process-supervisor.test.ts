import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DaemonProcessSupervisor } from "./daemon-process-supervisor.js";

const temporaryDirectories: string[] = [];

async function privateRuntimeRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-supervisor-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "darwin")("macOS daemon supervisor configuration", () => {
  it("rejects non-absolute commands before spawning", async () => {
    const runtimeRoot = await privateRuntimeRoot();
    await expect(
      DaemonProcessSupervisor.start({
        command: "node",
        codexExecutable: process.execPath,
        args: [],
        runtimeRoot,
        clientVersion: "0.0.0",
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("rejects non-absolute and non-executable Codex paths before spawning", async () => {
    const runtimeRoot = await privateRuntimeRoot();
    await expect(
      DaemonProcessSupervisor.start({
        command: process.execPath,
        codexExecutable: "codex",
        args: [],
        runtimeRoot,
        clientVersion: "0.0.0",
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    const nonExecutable = join(runtimeRoot, "not-executable");
    await writeFile(nonExecutable, "not executable", { mode: 0o600 });
    await expect(
      DaemonProcessSupervisor.start({
        command: process.execPath,
        codexExecutable: nonExecutable,
        args: [],
        runtimeRoot,
        clientVersion: "0.0.0",
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("rejects caller arguments that can override supervisor-owned paths", async () => {
    const runtimeRoot = await privateRuntimeRoot();
    for (const reservedArgument of [
      "--endpoint",
      "--endpoint=/tmp/other.sock",
      "--codex-executable",
      "--codex-executable=/tmp/other-codex",
    ]) {
      await expect(
        DaemonProcessSupervisor.start({
          command: process.execPath,
          codexExecutable: process.execPath,
          args: [reservedArgument],
          runtimeRoot,
          clientVersion: "0.0.0",
        }),
      ).rejects.toMatchObject({ code: "invalid_configuration" });
    }
  });

  it("rejects runtime roots accessible by other users", async () => {
    const runtimeRoot = await privateRuntimeRoot();
    await chmod(runtimeRoot, 0o755);
    await expect(
      DaemonProcessSupervisor.start({
        command: process.execPath,
        codexExecutable: process.execPath,
        args: [],
        runtimeRoot,
        clientVersion: "0.0.0",
      }),
    ).rejects.toMatchObject({ code: "runtime_root_insecure" });
  });

  it("normalizes malformed runtime input to a fixed configuration error", async () => {
    const startUnknown = DaemonProcessSupervisor.start as unknown as (
      config: unknown,
    ) => Promise<DaemonProcessSupervisor>;
    await expect(startUnknown(null)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      startUnknown({
        command: process.execPath,
        codexExecutable: process.execPath,
        args: [],
        runtimeRoot: await privateRuntimeRoot(),
        clientVersion: "0.0.0",
        electronRunAsNode: "yes",
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
