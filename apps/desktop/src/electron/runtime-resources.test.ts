import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopRuntimeResourceError,
  DesktopRuntimeRootError,
  ensurePrivateDesktopRuntimeRoot,
  resolveDesktopRuntimeResources,
} from "./runtime-resources.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-desktop-resources-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(path, 0o700);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("desktop runtime resources", () => {
  it("requires an explicit Codex executable only in development mode", async () => {
    const directory = await temporaryDirectory();
    const electronExecutable = join(directory, "electron");
    const daemonEntry = join(directory, "cli.js");
    await executable(electronExecutable);
    await writeFile(daemonEntry, "export {};\n", { mode: 0o600 });

    await expect(
      resolveDesktopRuntimeResources({
        isPackaged: false,
        resourcesPath: directory,
        electronExecutable,
        developmentDaemonEntry: daemonEntry,
      }),
    ).rejects.toBeInstanceOf(DesktopRuntimeResourceError);

    const codexExecutable = join(directory, "codex");
    await executable(codexExecutable);
    await expect(
      resolveDesktopRuntimeResources({
        isPackaged: false,
        resourcesPath: directory,
        electronExecutable,
        developmentDaemonEntry: daemonEntry,
        developmentCodexExecutable: codexExecutable,
      }),
    ).resolves.toEqual({ command: electronExecutable, daemonEntry, codexExecutable });
  });

  it("uses only the fixed packaged resource layout and ignores a development override", async () => {
    const directory = await temporaryDirectory();
    const electronExecutable = join(directory, "electron");
    const daemonEntry = join(directory, "harnessd", "cli.js");
    const codexExecutable = join(directory, "codex", "codex");
    await executable(electronExecutable);
    await ensureDirectoryAndFile(join(directory, "harnessd"), daemonEntry, false);
    await ensureDirectoryAndFile(join(directory, "codex"), codexExecutable, true);

    await expect(
      resolveDesktopRuntimeResources({
        isPackaged: true,
        resourcesPath: directory,
        electronExecutable,
        developmentDaemonEntry: join(directory, "ignored.js"),
        developmentCodexExecutable: join(directory, "ignored-codex"),
      }),
    ).resolves.toEqual({ command: electronExecutable, daemonEntry, codexExecutable });
  });

  it("rejects symbolic links and non-executable Codex resources", async () => {
    const directory = await temporaryDirectory();
    const electronExecutable = join(directory, "electron");
    const daemonEntry = join(directory, "cli.js");
    const codexTarget = join(directory, "codex-target");
    const codexLink = join(directory, "codex-link");
    await executable(electronExecutable);
    await writeFile(daemonEntry, "export {};\n", { mode: 0o600 });
    await executable(codexTarget);
    await symlink(codexTarget, codexLink);

    await expect(
      resolveDesktopRuntimeResources({
        isPackaged: false,
        resourcesPath: directory,
        electronExecutable,
        developmentDaemonEntry: daemonEntry,
        developmentCodexExecutable: codexLink,
      }),
    ).rejects.toMatchObject({ code: "resource_invalid" });
  });
});

describe("desktop runtime root", () => {
  it("creates and repairs an owner-private stable directory", async () => {
    const directory = await temporaryDirectory();
    const runtimeRoot = await ensurePrivateDesktopRuntimeRoot(directory);
    await chmod(runtimeRoot, 0o755);

    await expect(ensurePrivateDesktopRuntimeRoot(directory)).resolves.toBe(runtimeRoot);
  });

  it("rejects a symbolic-link runtime root", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target");
    await ensureDirectoryAndFile(target, join(target, "marker"), false);
    await symlink(target, join(directory, "runtime"));

    await expect(ensurePrivateDesktopRuntimeRoot(directory)).rejects.toBeInstanceOf(
      DesktopRuntimeRootError,
    );
  });
});

async function ensureDirectoryAndFile(
  directory: string,
  path: string,
  makeExecutable: boolean,
): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(path, makeExecutable ? "#!/bin/sh\nexit 0\n" : "export {};\n", {
    mode: makeExecutable ? 0o700 : 0o600,
  });
}
