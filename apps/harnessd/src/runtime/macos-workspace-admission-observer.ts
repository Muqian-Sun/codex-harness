import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

import type { HarnessExecutionAdmissionRejectionReason } from "@codex-harness/protocol";

import type { ProjectWorkspace } from "../domain/project-registry-repository.js";

const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const GIT_HEAD_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_CHANGED_PATHS = 512;

export const MACOS_WORKSPACE_ADMISSION_POLICY_VERSION =
  "macos-workspace-admission-policy-v2" as const;

export type VerifiedMacosWorkspaceSnapshotV1 = Readonly<{
  schemaVersion: 1;
  policyVersion: "macos-workspace-admission-policy-v1";
  platform: "macos";
  canonicalPath: string;
  deviceId: string;
  inode: string;
  gitHead: string;
  statusDigest: string;
  workspaceDigest: string;
  observedAtMs: number;
}>;

export type VerifiedMacosWorkspaceSnapshotV2 = Readonly<{
  schemaVersion: 2;
  policyVersion: typeof MACOS_WORKSPACE_ADMISSION_POLICY_VERSION;
  platform: "macos";
  canonicalPath: string;
  deviceId: string;
  inode: string;
  gitHead: string;
  statusDigest: string;
  contentDigest: string;
  changedPaths: readonly string[];
  workspaceDigest: string;
  observedAtMs: number;
}>;

export type VerifiedMacosWorkspaceSnapshot =
  VerifiedMacosWorkspaceSnapshotV1 | VerifiedMacosWorkspaceSnapshotV2;

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

  async observe(
    workspace: ProjectWorkspace,
    options: Readonly<{ requireClean?: boolean }> = {},
  ): Promise<MacosWorkspaceAdmissionObservation> {
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
      const firstStatus = await readStatus(this.#dependencies, canonicalPath);
      if ((options.requireClean ?? true) && firstStatus.length !== 0) {
        return denied("workspace_dirty");
      }
      const firstState = await captureGitState(this.#dependencies, canonicalPath, firstStatus);
      const after = await this.#dependencies.stat(canonicalPath);
      const finalHead = (await this.#dependencies.runGit(canonicalPath, ["rev-parse", "HEAD"]))
        .trim()
        .toLowerCase();
      const finalState = await captureGitState(this.#dependencies, canonicalPath);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        gitHead !== finalHead ||
        firstState.contentDigest !== finalState.contentDigest
      ) {
        return denied("workspace_changed");
      }
      const statusDigest = sha256(finalState.status);
      const deviceId = before.dev.toString();
      const inode = before.ino.toString();
      const observedAtMs = this.#dependencies.now();
      const workspaceDigest = sha256(
        JSON.stringify({
          canonicalPath,
          changedPaths: finalState.changedPaths,
          contentDigest: finalState.contentDigest,
          deviceId,
          gitHead,
          inode,
          statusDigest,
        }),
      );
      return Object.freeze({
        status: "verified",
        snapshot: Object.freeze({
          schemaVersion: 2,
          policyVersion: MACOS_WORKSPACE_ADMISSION_POLICY_VERSION,
          platform: "macos",
          canonicalPath,
          deviceId,
          inode,
          gitHead,
          statusDigest,
          contentDigest: finalState.contentDigest,
          changedPaths: finalState.changedPaths,
          workspaceDigest,
          observedAtMs,
        }),
      });
    } catch {
      return denied("workspace_unavailable");
    }
  }
}

type GitState = Readonly<{
  status: string;
  contentDigest: string;
  changedPaths: readonly string[];
}>;

async function captureGitState(
  dependencies: MacosWorkspaceAdmissionObserverDependencies,
  canonicalPath: string,
  observedStatus?: string,
): Promise<GitState> {
  const status = observedStatus ?? (await readStatus(dependencies, canonicalPath));
  const trackedPaths = nulSeparated(
    await dependencies.runGit(canonicalPath, ["diff", "--name-only", "-z", "HEAD", "--"]),
  );
  const untrackedPaths = nulSeparated(
    await dependencies.runGit(canonicalPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const changedPaths = Object.freeze([...new Set([...trackedPaths, ...untrackedPaths])].sort());
  if (
    changedPaths.length > MAX_CHANGED_PATHS ||
    changedPaths.some((path) => !validRelativePath(path))
  ) {
    throw new Error("workspace_snapshot_budget_exceeded");
  }
  const trackedDiff = await dependencies.runGit(canonicalPath, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "HEAD",
    "--",
  ]);
  const untrackedHashes: string[] = [];
  for (const path of untrackedPaths) {
    const hash = (
      await dependencies.runGit(canonicalPath, ["hash-object", "--no-filters", "--", path])
    )
      .trim()
      .toLowerCase();
    if (!GIT_HEAD_PATTERN.test(hash)) throw new Error("invalid_untracked_hash");
    untrackedHashes.push(`${path}\0${hash}`);
  }
  return Object.freeze({
    status,
    changedPaths,
    contentDigest: sha256(`${status}\0${trackedDiff}\0${untrackedHashes.join("\0")}`),
  });
}

async function readStatus(
  dependencies: MacosWorkspaceAdmissionObserverDependencies,
  canonicalPath: string,
): Promise<string> {
  return await dependencies.runGit(canonicalPath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
}

function nulSeparated(value: string): readonly string[] {
  if (value.length === 0) return Object.freeze([]);
  if (!value.endsWith("\0")) throw new Error("invalid_git_output");
  return Object.freeze(value.slice(0, -1).split("\0"));
}

function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 16_384 &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.split("/").includes("..")
  );
}

function denied(
  rejectionReason: HarnessExecutionAdmissionRejectionReason,
): MacosWorkspaceAdmissionObservation {
  return Object.freeze({ status: "denied", rejectionReason });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
