import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";

import { ProductVersionSchema } from "@codex-harness/protocol";

import {
  HarnessRpcClient,
  HarnessRpcClientError,
  type HarnessAccountStatusChangedEvent,
  type HarnessAccountStatusObservation,
  type HarnessAccountStatusResult,
  type HarnessRpcClientConfig,
} from "./harness-rpc-client.js";
import {
  terminateOwnedProcessGroup,
  waitForOwnedProcessGroupExit,
  type ProcessGroupEscalation,
} from "./owned-process-group.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000;
const DEFAULT_SIGTERM_TIMEOUT_MS = 2_000;
const DEFAULT_SIGKILL_TIMEOUT_MS = 2_000;
const MAX_LIFECYCLE_TIMEOUT_MS = 60_000;
const MAX_ARGUMENT_COUNT = 64;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_UNIX_ENDPOINT_BYTES = 100;
const ENDPOINT_POLL_INTERVAL_MS = 10;

export type DaemonProcessSupervisorState = "starting" | "ready" | "stopping" | "closed";

export type DaemonProcessSupervisorErrorCode =
  | "capability_pipe_failed"
  | "daemon_exited_early"
  | "endpoint_invalid"
  | "invalid_configuration"
  | "invalid_stdio"
  | "rpc_handshake_failed"
  | "runtime_root_insecure"
  | "spawn_failed"
  | "startup_timeout"
  | "unsupported_platform";

const ERROR_MESSAGES: Readonly<Record<DaemonProcessSupervisorErrorCode, string>> = Object.freeze({
  capability_pipe_failed: "The daemon startup capability pipe failed.",
  daemon_exited_early: "The daemon exited before startup completed.",
  endpoint_invalid: "The daemon local endpoint is invalid.",
  invalid_configuration: "The daemon supervisor configuration is invalid.",
  invalid_stdio: "The daemon inherited pipe layout is invalid.",
  rpc_handshake_failed: "The daemon RPC handshake failed.",
  runtime_root_insecure: "The daemon runtime root is not private to the current user.",
  spawn_failed: "The daemon process failed to spawn.",
  startup_timeout: "The daemon startup timed out.",
  unsupported_platform: "The daemon supervisor does not support this platform yet.",
});

export class DaemonProcessSupervisorError extends Error {
  readonly code: DaemonProcessSupervisorErrorCode;

  constructor(code: DaemonProcessSupervisorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "DaemonProcessSupervisorError";
    this.code = code;
  }
}

export type DaemonProcessSupervisorConfig = Readonly<{
  command: string;
  codexExecutable: string;
  args: readonly string[];
  runtimeRoot: string;
  clientVersion: string;
  electronRunAsNode?: boolean;
  startupTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  sigtermTimeoutMs?: number;
  sigkillTimeoutMs?: number;
  onAccountStatusChanged?: (event: HarnessAccountStatusChangedEvent) => void;
}>;

export type DaemonContainmentResult = "graceful" | "sigterm" | "sigkill" | "containment_unknown";

export type DaemonEndpointCleanup =
  "missing" | "preserved_active" | "replacement_preserved" | "removed";

export type DaemonRuntimeDirectoryCleanup =
  "directory_not_empty" | "directory_replaced" | "missing" | "preserved_active" | "removed";

export type DaemonProcessSupervisorCloseResult = Readonly<{
  expected: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  containment: DaemonContainmentResult;
  endpointCleanup: DaemonEndpointCleanup;
  runtimeDirectoryCleanup: DaemonRuntimeDirectoryCleanup;
}>;

type FileIdentity = Readonly<{ device: number; inode: number }>;
type ChildExit = Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>;

type NormalizedConfig = Readonly<{
  command: string;
  codexExecutable: string;
  args: readonly string[];
  runtimeRoot: string;
  clientVersion: string;
  electronRunAsNode: boolean;
  startupTimeoutMs: number;
  gracefulTimeoutMs: number;
  sigtermTimeoutMs: number;
  sigkillTimeoutMs: number;
  onAccountStatusChanged: ((event: HarnessAccountStatusChangedEvent) => void) | undefined;
}>;

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_LIFECYCLE_TIMEOUT_MS;
}

function normalizeConfig(config: DaemonProcessSupervisorConfig): NormalizedConfig {
  try {
    const command = config.command;
    const codexExecutable = config.codexExecutable;
    const args = [...config.args];
    const runtimeRoot = config.runtimeRoot;
    const clientVersion = config.clientVersion;
    const electronRunAsNode = config.electronRunAsNode ?? false;
    const startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const gracefulTimeoutMs = config.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
    const sigtermTimeoutMs = config.sigtermTimeoutMs ?? DEFAULT_SIGTERM_TIMEOUT_MS;
    const sigkillTimeoutMs = config.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS;
    const onAccountStatusChanged = config.onAccountStatusChanged;
    if (
      typeof command !== "string" ||
      !isAbsolute(command) ||
      command.includes("\0") ||
      typeof codexExecutable !== "string" ||
      !isAbsolute(codexExecutable) ||
      codexExecutable.includes("\0") ||
      typeof runtimeRoot !== "string" ||
      !isAbsolute(runtimeRoot) ||
      runtimeRoot.includes("\0") ||
      !ProductVersionSchema.safeParse(clientVersion).success ||
      (config.electronRunAsNode !== undefined && typeof config.electronRunAsNode !== "boolean") ||
      args.length > MAX_ARGUMENT_COUNT ||
      args.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.includes("\0") ||
          Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES,
      ) ||
      args.some(isReservedDaemonArgument) ||
      (onAccountStatusChanged !== undefined && typeof onAccountStatusChanged !== "function")
    ) {
      throw new DaemonProcessSupervisorError("invalid_configuration");
    }

    if (
      !validTimeout(startupTimeoutMs) ||
      !validTimeout(gracefulTimeoutMs) ||
      !validTimeout(sigtermTimeoutMs) ||
      !validTimeout(sigkillTimeoutMs)
    ) {
      throw new DaemonProcessSupervisorError("invalid_configuration");
    }

    return Object.freeze({
      command,
      codexExecutable,
      args: Object.freeze(args),
      runtimeRoot,
      clientVersion,
      electronRunAsNode,
      startupTimeoutMs,
      gracefulTimeoutMs,
      sigtermTimeoutMs,
      sigkillTimeoutMs,
      onAccountStatusChanged,
    });
  } catch (error: unknown) {
    if (error instanceof DaemonProcessSupervisorError) {
      throw error;
    }
    throw new DaemonProcessSupervisorError("invalid_configuration");
  }
}

function isReservedDaemonArgument(argument: string): boolean {
  return (
    argument === "--endpoint" ||
    argument.startsWith("--endpoint=") ||
    argument === "--codex-executable" ||
    argument.startsWith("--codex-executable=")
  );
}

export class DaemonProcessSupervisor {
  readonly #config: NormalizedConfig;
  readonly #child: ChildProcess;
  readonly #processGroupId: number;
  readonly #runtimeDirectory: string;
  readonly #runtimeDirectoryIdentity: FileIdentity;
  readonly #endpoint: string;
  readonly #watchdogPipe: Writable;
  readonly #childExit: Promise<ChildExit>;
  readonly closed: Promise<DaemonProcessSupervisorCloseResult>;
  #resolveClosed!: (result: DaemonProcessSupervisorCloseResult) => void;
  #lastChildExit: ChildExit | undefined;
  #childFailed = false;
  #watchdogFailed = false;
  #endpointIdentity: FileIdentity | undefined;
  #client: HarnessRpcClient | undefined;
  #state: DaemonProcessSupervisorState = "starting";
  #closePromise: Promise<DaemonProcessSupervisorCloseResult> | undefined;

  private constructor(
    config: NormalizedConfig,
    child: ChildProcess,
    processGroupId: number,
    childExit: Promise<ChildExit>,
    watchdogPipe: Writable,
    runtimeDirectory: string,
    runtimeDirectoryIdentity: FileIdentity,
    endpoint: string,
  ) {
    this.#config = config;
    this.#child = child;
    this.#processGroupId = processGroupId;
    this.#childExit = childExit;
    this.#watchdogPipe = watchdogPipe;
    this.#runtimeDirectory = runtimeDirectory;
    this.#runtimeDirectoryIdentity = runtimeDirectoryIdentity;
    this.#endpoint = endpoint;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    void childExit.then((exit) => {
      this.#lastChildExit = exit;
    });
    this.#child.on("error", () => {
      this.#childFailed = true;
      if (this.#state === "ready") {
        void this.#beginClose(false, false);
      }
    });
    this.#watchdogPipe.on("error", () => {
      this.#watchdogFailed = true;
      if (this.#state === "ready") {
        void this.#beginClose(false, false);
      }
    });
    this.#watchdogPipe.once("close", () => {
      if (this.#state === "ready") {
        void this.#beginClose(false, false);
      }
    });
  }

  static async start(config: DaemonProcessSupervisorConfig): Promise<DaemonProcessSupervisor> {
    if (process.platform !== "darwin") {
      throw new DaemonProcessSupervisorError("unsupported_platform");
    }
    const normalized = normalizeConfig(config);
    await validateRuntimeRoot(normalized.runtimeRoot);
    try {
      await Promise.all([
        access(normalized.command, fsConstants.X_OK),
        access(normalized.codexExecutable, fsConstants.X_OK),
      ]);
    } catch {
      throw new DaemonProcessSupervisorError("invalid_configuration");
    }

    const { runtimeDirectory, runtimeDirectoryIdentity } = await createRuntimeDirectory(
      normalized.runtimeRoot,
    );
    const endpoint = join(runtimeDirectory, "harnessd.sock");
    if (Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_ENDPOINT_BYTES) {
      await removeEmptyDirectory(runtimeDirectory);
      throw new DaemonProcessSupervisorError("invalid_configuration");
    }

    let child: ChildProcess;
    try {
      child = spawn(
        normalized.command,
        [
          ...normalized.args,
          "--endpoint",
          endpoint,
          "--codex-executable",
          normalized.codexExecutable,
        ],
        {
          cwd: runtimeDirectory,
          detached: true,
          env: normalized.electronRunAsNode
            ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
            : process.env,
          stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
        },
      );
    } catch {
      await removeEmptyDirectory(runtimeDirectory);
      throw new DaemonProcessSupervisorError("spawn_failed");
    }

    child.on("error", () => undefined);
    const childExit = observeChildExit(child);
    try {
      await waitForSpawn(child);
    } catch {
      await removeEmptyDirectory(runtimeDirectory);
      throw new DaemonProcessSupervisorError("spawn_failed");
    }

    const processGroupId = child.pid;
    const capabilityPipe = child.stdio[3];
    const watchdogPipe = child.stdio[4];
    if (
      processGroupId === undefined ||
      processGroupId <= 1 ||
      !(capabilityPipe instanceof Writable) ||
      !(watchdogPipe instanceof Writable)
    ) {
      if (processGroupId !== undefined && processGroupId > 1) {
        await terminateOwnedProcessGroup(processGroupId, {
          sigtermTimeoutMs: normalized.sigtermTimeoutMs,
          sigkillTimeoutMs: normalized.sigkillTimeoutMs,
        });
      }
      await removeEmptyDirectory(runtimeDirectory);
      throw new DaemonProcessSupervisorError("invalid_stdio");
    }
    capabilityPipe.on("error", () => undefined);
    watchdogPipe.on("error", () => undefined);

    const supervisor = new DaemonProcessSupervisor(
      normalized,
      child,
      processGroupId,
      childExit,
      watchdogPipe,
      runtimeDirectory,
      runtimeDirectoryIdentity,
      endpoint,
    );
    const startupCapability = randomBytes(32).toString("base64url");

    try {
      await writeStartupCapability(capabilityPipe, startupCapability);
      supervisor.#endpointIdentity = await supervisor.#waitForSecureEndpoint();
      const clientConfig: HarnessRpcClientConfig = {
        endpoint,
        startupCapability,
        clientVersion: normalized.clientVersion,
        connectTimeoutMs: normalized.startupTimeoutMs,
        handshakeTimeoutMs: normalized.startupTimeoutMs,
        requestTimeoutMs: normalized.gracefulTimeoutMs,
        onEvent: (event) => {
          if (event.method !== "account.status_changed") {
            throw new HarnessRpcClientError("protocol_violation");
          }
          normalized.onAccountStatusChanged?.(
            Object.freeze({
              sequence: event.sequence,
              account: event.params as HarnessAccountStatusResult,
            }),
          );
        },
      };
      supervisor.#client = await HarnessRpcClient.connect(clientConfig);
      if (supervisor.#client.state !== "ready") {
        throw new DaemonProcessSupervisorError("rpc_handshake_failed");
      }
      if (
        supervisor.#lastChildExit !== undefined ||
        supervisor.#childFailed ||
        supervisor.#watchdogFailed ||
        watchdogPipe.destroyed ||
        watchdogPipe.writableEnded
      ) {
        throw new DaemonProcessSupervisorError("daemon_exited_early");
      }
      supervisor.#state = "ready";
      void supervisor.#client.closed.then(() => {
        if (supervisor.#state === "ready") {
          void supervisor.#beginClose(false, false);
        }
      });
      void childExit.then(() => {
        if (supervisor.#state === "ready") {
          void supervisor.#beginClose(false, false);
        }
      });
      return supervisor;
    } catch (error: unknown) {
      await supervisor.#beginClose(false, false);
      if (error instanceof DaemonProcessSupervisorError) {
        throw error;
      }
      if (error instanceof HarnessRpcClientError) {
        throw new DaemonProcessSupervisorError("rpc_handshake_failed");
      }
      throw new DaemonProcessSupervisorError("capability_pipe_failed");
    }
  }

  get state(): DaemonProcessSupervisorState {
    return this.#state;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  get processGroupId(): number {
    return this.#processGroupId;
  }

  get client(): HarnessRpcClient {
    const client = this.#client;
    if (client === undefined) {
      throw new DaemonProcessSupervisorError("rpc_handshake_failed");
    }
    return client;
  }

  async readAccountStatus(): Promise<HarnessAccountStatusResult> {
    return await this.client.accountStatus();
  }

  async readAccountStatusObservation(): Promise<HarnessAccountStatusObservation> {
    return await this.client.accountStatusObservation();
  }

  async stop(): Promise<DaemonProcessSupervisorCloseResult> {
    return await this.#beginClose(true, true);
  }

  async #waitForSecureEndpoint(): Promise<FileIdentity> {
    const deadline = performance.now() + this.#config.startupTimeoutMs;
    while (performance.now() < deadline) {
      if (this.#lastChildExit !== undefined) {
        throw new DaemonProcessSupervisorError("daemon_exited_early");
      }
      try {
        const metadata = await lstat(this.#endpoint);
        const getuid = process.getuid;
        if (!metadata.isSocket() || getuid === undefined || metadata.uid !== getuid()) {
          throw new DaemonProcessSupervisorError("endpoint_invalid");
        }
        if ((metadata.mode & 0o777) === 0o600) {
          return Object.freeze({ device: metadata.dev, inode: metadata.ino });
        }
      } catch (error: unknown) {
        if (error instanceof DaemonProcessSupervisorError) {
          throw error;
        }
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw new DaemonProcessSupervisorError("endpoint_invalid");
        }
      }
      await delay(ENDPOINT_POLL_INTERVAL_MS);
    }
    throw new DaemonProcessSupervisorError("startup_timeout");
  }

  #beginClose(
    expected: boolean,
    requestGracefulShutdown: boolean,
  ): Promise<DaemonProcessSupervisorCloseResult> {
    const existing = this.#closePromise;
    if (existing !== undefined) {
      return existing;
    }
    this.#state = "stopping";
    const closing = this.#close(expected, requestGracefulShutdown);
    this.#closePromise = closing;
    return closing;
  }

  async #close(
    expected: boolean,
    requestGracefulShutdown: boolean,
  ): Promise<DaemonProcessSupervisorCloseResult> {
    if (requestGracefulShutdown && this.#client !== undefined) {
      await Promise.race([
        this.#client.requestShutdown("desktop.supervisor_stop").catch(() => undefined),
        delay(Math.min(250, this.#config.gracefulTimeoutMs)),
      ]);
    }
    endPipe(this.#watchdogPipe);

    let containment: DaemonContainmentResult = "graceful";
    let groupGone = await waitForOwnedProcessGroupExit(
      this.#processGroupId,
      this.#config.gracefulTimeoutMs,
    );
    if (!groupGone) {
      const escalation = await terminateOwnedProcessGroup(this.#processGroupId, {
        sigtermTimeoutMs: this.#config.sigtermTimeoutMs,
        sigkillTimeoutMs: this.#config.sigkillTimeoutMs,
      });
      containment = mapEscalation(escalation);
      groupGone = escalation !== "containment_unknown";
    }

    this.#client?.close();
    const childExit = groupGone
      ? await Promise.race([this.#childExit, delay(100).then(() => this.#lastChildExit)])
      : this.#lastChildExit;
    const endpointCleanup = groupGone ? await this.#cleanupEndpoint() : "preserved_active";
    const runtimeDirectoryCleanup = groupGone
      ? await this.#cleanupRuntimeDirectory()
      : "preserved_active";
    const result = Object.freeze({
      expected,
      exitCode: childExit?.exitCode ?? this.#child.exitCode,
      signal: childExit?.signal ?? this.#child.signalCode,
      containment,
      endpointCleanup,
      runtimeDirectoryCleanup,
    });
    this.#state = "closed";
    this.#resolveClosed(result);
    return result;
  }

  async #cleanupEndpoint(): Promise<DaemonEndpointCleanup> {
    try {
      const directoryMetadata = await lstat(this.#runtimeDirectory);
      if (
        !directoryMetadata.isDirectory() ||
        directoryMetadata.dev !== this.#runtimeDirectoryIdentity.device ||
        directoryMetadata.ino !== this.#runtimeDirectoryIdentity.inode
      ) {
        return "replacement_preserved";
      }
      const metadata = await lstat(this.#endpoint);
      const identity = this.#endpointIdentity;
      if (
        identity === undefined ||
        !metadata.isSocket() ||
        metadata.dev !== identity.device ||
        metadata.ino !== identity.inode
      ) {
        return "replacement_preserved";
      }
      await unlink(this.#endpoint);
      return "removed";
    } catch (error: unknown) {
      return isNodeError(error) && error.code === "ENOENT" ? "missing" : "replacement_preserved";
    }
  }

  async #cleanupRuntimeDirectory(): Promise<DaemonRuntimeDirectoryCleanup> {
    try {
      const metadata = await lstat(this.#runtimeDirectory);
      if (
        !metadata.isDirectory() ||
        metadata.dev !== this.#runtimeDirectoryIdentity.device ||
        metadata.ino !== this.#runtimeDirectoryIdentity.inode
      ) {
        return "directory_replaced";
      }
      await rmdir(this.#runtimeDirectory);
      return "removed";
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return "missing";
      }
      return "directory_not_empty";
    }
  }
}

async function validateRuntimeRoot(runtimeRoot: string): Promise<void> {
  try {
    const metadata = await lstat(runtimeRoot);
    const getuid = process.getuid;
    if (
      !metadata.isDirectory() ||
      getuid === undefined ||
      metadata.uid !== getuid() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new DaemonProcessSupervisorError("runtime_root_insecure");
    }
  } catch (error: unknown) {
    if (error instanceof DaemonProcessSupervisorError) {
      throw error;
    }
    throw new DaemonProcessSupervisorError("runtime_root_insecure");
  }
}

async function createRuntimeDirectory(
  runtimeRoot: string,
): Promise<Readonly<{ runtimeDirectory: string; runtimeDirectoryIdentity: FileIdentity }>> {
  let runtimeDirectory: string | undefined;
  try {
    runtimeDirectory = await mkdtemp(join(runtimeRoot, "daemon-"));
    await chmod(runtimeDirectory, 0o700);
    const metadata = await lstat(runtimeDirectory);
    const getuid = process.getuid;
    if (
      !metadata.isDirectory() ||
      getuid === undefined ||
      metadata.uid !== getuid() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new DaemonProcessSupervisorError("runtime_root_insecure");
    }
    return Object.freeze({
      runtimeDirectory,
      runtimeDirectoryIdentity: Object.freeze({ device: metadata.dev, inode: metadata.ino }),
    });
  } catch (error: unknown) {
    if (runtimeDirectory !== undefined) {
      await removeEmptyDirectory(runtimeDirectory);
    }
    if (error instanceof DaemonProcessSupervisorError) {
      throw error;
    }
    throw new DaemonProcessSupervisorError("runtime_root_insecure");
  }
}

function observeChildExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once("exit", (exitCode, signal) => {
      resolve(Object.freeze({ exitCode, signal }));
    });
  });
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (): void => {
      child.off("spawn", onSpawn);
      reject(new DaemonProcessSupervisorError("spawn_failed"));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function writeStartupCapability(pipe: Writable, capability: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (): void => {
      pipe.off("error", onError);
      reject(new DaemonProcessSupervisorError("capability_pipe_failed"));
    };
    pipe.once("error", onError);
    pipe.end(capability, () => {
      pipe.off("error", onError);
      resolve();
    });
  });
}

function endPipe(pipe: Writable): void {
  if (pipe.destroyed || pipe.writableEnded) {
    return;
  }
  try {
    pipe.end();
  } catch {
    pipe.destroy();
  }
}

function mapEscalation(escalation: ProcessGroupEscalation): DaemonContainmentResult {
  if (escalation === "sigterm" || escalation === "sigkill") {
    return escalation;
  }
  return escalation === "already_gone" ? "graceful" : "containment_unknown";
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch {
    // Startup errors preserve any unexpected directory contents for inspection.
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
