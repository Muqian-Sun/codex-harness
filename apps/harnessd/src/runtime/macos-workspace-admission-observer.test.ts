import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectWorkspace } from "../domain/project-registry-repository.js";
import {
  MACOS_WORKSPACE_ADMISSION_POLICY_VERSION,
  MacosWorkspaceAdmissionObserver,
  type MacosWorkspaceAdmissionObserverDependencies,
} from "./macos-workspace-admission-observer.js";

const PATH = "/Users/example/project";
const HEAD = "a".repeat(40);
const workspace: ProjectWorkspace = Object.freeze({
  platform: "macos",
  absolutePath: PATH,
  identityStatus: "unverified",
});

function dependencies(
  override: Partial<MacosWorkspaceAdmissionObserverDependencies> = {},
): MacosWorkspaceAdmissionObserverDependencies {
  return {
    platform: () => "darwin",
    now: () => 123,
    realpath: async () => PATH,
    stat: async () => ({ isDirectory: () => true, dev: 10n, ino: 20n }),
    runGit: async (_cwd, args) => {
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return `${PATH}\n`;
      if (command === "rev-parse HEAD") return `${HEAD}\n`;
      return "";
    },
    ...override,
  };
}

describe("macOS workspace admission observer", () => {
  it.skipIf(process.platform !== "darwin")(
    "uses the fixed production Git boundary for a real clean repository",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codex-harness-real-workspace-"));
      try {
        const canonicalPath = await realpath(directory);
        await runGit(canonicalPath, ["init", "--quiet"]);
        await writeFile(join(canonicalPath, "README.md"), "workspace\n");
        await runGit(canonicalPath, ["add", "README.md"]);
        await runGit(canonicalPath, [
          "-c",
          "user.name=Codex Harness",
          "-c",
          "user.email=harness@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "initial",
        ]);

        await expect(
          new MacosWorkspaceAdmissionObserver().observe({
            platform: "macos",
            absolutePath: canonicalPath,
            identityStatus: "unverified",
          }),
        ).resolves.toMatchObject({
          status: "verified",
          snapshot: { canonicalPath, gitHead: expect.stringMatching(/^[0-9a-f]{40}$/) },
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("captures a stable clean canonical Git root without exposing command output", async () => {
    const observer = new MacosWorkspaceAdmissionObserver(dependencies());

    await expect(observer.observe(workspace)).resolves.toMatchObject({
      status: "verified",
      snapshot: {
        policyVersion: MACOS_WORKSPACE_ADMISSION_POLICY_VERSION,
        platform: "macos",
        canonicalPath: PATH,
        deviceId: "10",
        inode: "20",
        gitHead: HEAD,
        observedAtMs: 123,
        statusDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        workspaceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("fails closed for unsupported platforms, aliases, non-directories and command failures", async () => {
    await expect(
      new MacosWorkspaceAdmissionObserver(dependencies({ platform: () => "linux" })).observe(
        workspace,
      ),
    ).resolves.toEqual({ status: "denied", rejectionReason: "unsupported_platform" });
    await expect(
      new MacosWorkspaceAdmissionObserver(dependencies()).observe({
        ...workspace,
        platform: "windows",
      }),
    ).resolves.toEqual({ status: "denied", rejectionReason: "unsupported_platform" });
    await expect(
      new MacosWorkspaceAdmissionObserver(
        dependencies({ realpath: async () => "/private/alias" }),
      ).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_not_canonical" });
    await expect(
      new MacosWorkspaceAdmissionObserver(
        dependencies({ stat: async () => ({ isDirectory: () => false, dev: 1n, ino: 2n }) }),
      ).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_unavailable" });
    await expect(
      new MacosWorkspaceAdmissionObserver(
        dependencies({ runGit: async () => Promise.reject(new Error("sensitive output")) }),
      ).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_unavailable" });
  });

  it("rejects subdirectories, malformed heads and dirty worktrees", async () => {
    await expect(
      new MacosWorkspaceAdmissionObserver(
        dependencies({
          runGit: async (_cwd, args) =>
            args.join(" ") === "rev-parse --show-toplevel" ? "/Users/example\n" : "",
        }),
      ).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_not_git_root" });
    await expect(
      new MacosWorkspaceAdmissionObserver(
        dependencies({
          runGit: async (_cwd, args) =>
            args.join(" ") === "rev-parse --show-toplevel" ? `${PATH}\n` : "not-a-head\n",
        }),
      ).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_unavailable" });
    await expect(
      new MacosWorkspaceAdmissionObserver(
        dependencies({
          runGit: async (_cwd, args) => {
            const command = args.join(" ");
            if (command === "rev-parse --show-toplevel") return `${PATH}\n`;
            if (command === "rev-parse HEAD") return `${HEAD}\n`;
            return "?? secret.txt\n";
          },
        }),
      ).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_dirty" });
  });

  it("detects identity and HEAD changes across the observation window", async () => {
    const statMock = vi
      .fn<MacosWorkspaceAdmissionObserverDependencies["stat"]>()
      .mockResolvedValueOnce({ isDirectory: () => true, dev: 1n, ino: 2n })
      .mockResolvedValueOnce({ isDirectory: () => true, dev: 1n, ino: 3n });
    await expect(
      new MacosWorkspaceAdmissionObserver(dependencies({ stat: statMock })).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_changed" });

    let headReads = 0;
    await expect(
      new MacosWorkspaceAdmissionObserver(
        dependencies({
          runGit: async (_cwd, args) => {
            const command = args.join(" ");
            if (command === "rev-parse --show-toplevel") return `${PATH}\n`;
            if (command === "rev-parse HEAD")
              return `${headReads++ === 0 ? HEAD : "b".repeat(40)}\n`;
            return "";
          },
        }),
      ).observe(workspace),
    ).resolves.toEqual({ status: "denied", rejectionReason: "workspace_changed" });
  });
});

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/git", ["-C", cwd, ...args], (error) =>
      error === null ? resolve() : reject(error),
    );
  });
}
