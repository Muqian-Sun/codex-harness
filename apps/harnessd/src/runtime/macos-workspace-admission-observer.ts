import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

import type { HarnessExecutionAdmissionRejectionReason } from "@codex-harness/protocol";

import type { ProjectWorkspace } from "../domain/project-registry-repository.js";

const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const GIT_HEAD_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const MACOS_WORKSPACE_ADMISSION_POLICY_VERSION =
  "macos-workspace-admission-policy-v1" as const;

export type VerifiedMacosWorkspaceSnapshot = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof MACOS_WORKSPACE_ADMISSION_POLICY_VERSION;
  platform: "macos";
  canonicalPath: string;
  deviceId: string;
  inode: string;
  gitHead: string;
  statusDigest: string;
  workspaceDigest: string;
  observedAtMs: number;
}>;

export type MacosWorkspaceAdmissionObservation =
  | Readonly<{ status: "verified"; snapshot: VerifiedMacosWorkspaceSnapshot }>
  | Readonly<{
      status: "denied";
      rejectionReason: HarnessExecutionAdmissionRejectionReason;
    }>;

type WorkspaceIdentity = Readonly<{
  isDirectory(): boolean;
  dev: bigint;
  ino: bigint;
}>;

export type MacosWorkspaceAdmissionObserverDependencies = Readonly<{
  platform(): NodeJS.Platform;
  now(): number;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<WorkspaceIdentity>;
  runGit(cwd: string, args: readonly string[]): Promise<string>;
}>;

const PRODUCTION_DEPENDENCIES: MacosWorkspaceAdmissionObserverDependencies = Object.freeze({
  platform: () => process.platform,
  now: () => Date.now(),
  realpath,
  stat: async (path) => await stat(path, { bigint: true }),
  runGit: async (cwd, args) =>
    await new Promise<string>((resolve, reject) => {
      execFile(
        GIT_EXECUTABLE,
        ["-C", cwd, ...args],
        {
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      );
    }),
});

export class MacosWorkspaceAdmissionObserver {
  readonly #dependencies: MacosWorkspaceAdmissionObserverDependencies;

  constructor(dependencies: MacosWorkspaceAdmissionObserverDependencies = PRODUCTION_DEPENDENCIES) {
    this.#dependencies = dependencies;
  }

  async observe(workspace: ProjectWorkspace): Promise<MacosWorkspaceAdmissionObservation> {
    if (workspace.platform !== "macos" || this.#dependencies.platform() !== "darwin") {
      return denied("unsupported_platform");
    }
    try {
      const canonicalPath = await this.#dependencies.realpath(workspace.absolutePath);
      if (canonicalPath !== workspace.absolutePath) {
        return denied("workspace_not_canonical");
      }
      const before = await this.#dependencies.stat(canonicalPath);
      if (!before.isDirectory()) {
        return denied("workspace_unavailable");
      }
      const gitRoot = (
        await this.#dependencies.runGit(canonicalPath, ["rev-parse", "--show-toplevel"])
      ).trim();
      if (gitRoot !== canonicalPath) {
        return denied("workspace_not_git_root");
      }
      const gitHead = (await this.#dependencies.runGit(canonicalPath, ["rev-parse", "HEAD"]))
        .trim()
        .toLowerCase();
      if (!GIT_HEAD_PATTERN.test(gitHead)) {
        return denied("workspace_unavailable");
      }
      const status = await this.#dependencies.runGit(canonicalPath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ]);
      if (status.length !== 0) {
        return denied("workspace_dirty");
      }
      const after = await this.#dependencies.stat(canonicalPath);
      const finalHead = (await this.#dependencies.runGit(canonicalPath, ["rev-parse", "HEAD"]))
        .trim()
        .toLowerCase();
      if (before.dev !== after.dev || before.ino !== after.ino || gitHead !== finalHead) {
        return denied("workspace_changed");
      }
      const statusDigest = sha256(status);
      const deviceId = before.dev.toString();
      const inode = before.ino.toString();
      const observedAtMs = this.#dependencies.now();
      const workspaceDigest = sha256(
        JSON.stringify({ canonicalPath, deviceId, gitHead, inode, statusDigest }),
      );
      return Object.freeze({
        status: "verified",
        snapshot: Object.freeze({
          schemaVersion: 1,
          policyVersion: MACOS_WORKSPACE_ADMISSION_POLICY_VERSION,
          platform: "macos",
          canonicalPath,
          deviceId,
          inode,
          gitHead,
          statusDigest,
          workspaceDigest,
          observedAtMs,
        }),
      });
    } catch {
      return denied("workspace_unavailable");
    }
  }
}

function denied(
  rejectionReason: HarnessExecutionAdmissionRejectionReason,
): MacosWorkspaceAdmissionObservation {
  return Object.freeze({ status: "denied", rejectionReason });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
