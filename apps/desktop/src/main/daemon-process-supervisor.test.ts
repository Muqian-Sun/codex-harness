import { chmod, mkdtemp, rm } from "node:fs/promises";
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
        args: [],
        runtimeRoot,
        clientVersion: "0.0.0",
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("rejects runtime roots accessible by other users", async () => {
    const runtimeRoot = await privateRuntimeRoot();
    await chmod(runtimeRoot, 0o755);
    await expect(
      DaemonProcessSupervisor.start({
        command: process.execPath,
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
  });
});
