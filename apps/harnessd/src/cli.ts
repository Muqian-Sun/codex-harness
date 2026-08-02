#!/usr/bin/env node

import { closeSync, createReadStream } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AppServerWorkerManager,
  AppServerWorkerManagerError,
} from "./runtime/app-server-worker-manager.js";
import { DaemonRuntime, DaemonRuntimeStartError } from "./runtime/daemon-runtime.js";
import type { DaemonStateStore, DaemonStateStoreError } from "./runtime/daemon-state-store.js";
import { LocalEndpointError } from "./runtime/local-endpoint.js";
import { monitorParentWatchdog, type ParentLossReason } from "./runtime/parent-watchdog.js";
import {
  StartupCapabilityInputError,
  readStartupCapability,
} from "./runtime/startup-capability.js";
import { HARNESS_DAEMON_VERSION } from "./version.js";

type DaemonStateStoreErrorConstructor = typeof DaemonStateStoreError;

export class DaemonCliError extends Error {
  readonly code: "invalid_arguments" | "parent_unavailable";

  constructor(code: "invalid_arguments" | "parent_unavailable") {
    super(
      code === "invalid_arguments"
        ? "The daemon command arguments are invalid."
        : "The daemon parent is unavailable.",
    );
    this.name = "DaemonCliError";
    this.code = code;
  }
}

export function parseDaemonArguments(args: readonly string[]): Readonly<{
  endpoint: string;
  codexExecutable: string;
  stateDatabasePath: string;
}> {
  if (
    args.length !== 6 ||
    args[0] !== "--endpoint" ||
    !args[1] ||
    args[1].includes("\0") ||
    args[2] !== "--codex-executable" ||
    !args[3] ||
    args[3].includes("\0") ||
    !isAbsolute(args[3]) ||
    args[4] !== "--state-database" ||
    !args[5] ||
    args[5].includes("\0") ||
    !isAbsolute(args[5]) ||
    basename(args[5]) !== "harness.db"
  ) {
    throw new DaemonCliError("invalid_arguments");
  }
  return Object.freeze({
    endpoint: args[1],
    codexExecutable: args[3],
    stateDatabasePath: args[5],
  });
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  let disposeWatchdog: (() => void) | undefined;
  let runtime: DaemonRuntime | undefined;
  let workerManager: AppServerWorkerManager | undefined;
  let stateStore: DaemonStateStore | undefined;
  let stateStoreErrorClass: DaemonStateStoreErrorConstructor | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  try {
    const { endpoint, codexExecutable, stateDatabasePath } = parseDaemonArguments(args);
    const capabilityInput = createReadStream("", { fd: 3, autoClose: true });
    const parentWatchdog = createReadStream("", { fd: 4, autoClose: true });
    let parentLoss: ParentLossReason | undefined;
    disposeWatchdog = monitorParentWatchdog(parentWatchdog, (reason) => {
      parentLoss = reason;
      runtime?.requestQuiesce(reason);
    });

    const startupCapability = await readStartupCapability(capabilityInput);
    if (parentLoss !== undefined) {
      throw new DaemonCliError("parent_unavailable");
    }

    workerManager = await AppServerWorkerManager.start({
      provider: "openai",
      worker: {
        codexExecutable,
        clientIdentity: {
          name: "codex_harness_daemon",
          title: "Codex Harness Daemon",
          version: HARNESS_DAEMON_VERSION,
        },
      },
    });
    if (parentLoss !== undefined) {
      throw new DaemonCliError("parent_unavailable");
    }

    const stateModule = await import("./runtime/daemon-state-store.js");
    stateStoreErrorClass = stateModule.DaemonStateStoreError;
    stateStore = await stateModule.DaemonStateStore.open({ databasePath: stateDatabasePath });
    if (parentLoss !== undefined) {
      throw new DaemonCliError("parent_unavailable");
    }

    runtime = await DaemonRuntime.start({
      endpoint,
      startupCapability,
      serverVersion: HARNESS_DAEMON_VERSION,
      stateStore,
      workerManager,
    });
    if (parentLoss !== undefined) {
      runtime.requestQuiesce(parentLoss);
    }

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        runtime?.requestQuiesce("signal");
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    const result = await runtime.closed;
    if (result.errorCode !== undefined) {
      process.stderr.write(`harnessd runtime failed (${result.errorCode}).\n`);
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    process.stderr.write(
      `harnessd startup failed (${publicFailureCode(error, stateStoreErrorClass)}).\n`,
    );
    process.exitCode = 1;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    runtime?.requestQuiesce("requested");
    if (runtime !== undefined) {
      await runtime.closed;
    }
    await workerManager?.close();
    try {
      stateStore?.close();
    } catch {
      if (process.exitCode !== 1) {
        process.stderr.write("harnessd runtime failed (state_shutdown_failed).\n");
        process.exitCode = 1;
      }
    }
    disposeWatchdog?.();
    closeInheritedDescriptor(4);
  }
}

function closeInheritedDescriptor(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // The stream may already have closed the inherited descriptor.
  }
}

function publicFailureCode(
  error: unknown,
  stateStoreErrorClass?: DaemonStateStoreErrorConstructor,
): string {
  if (
    error instanceof DaemonCliError ||
    error instanceof AppServerWorkerManagerError ||
    error instanceof DaemonRuntimeStartError ||
    (stateStoreErrorClass !== undefined && error instanceof stateStoreErrorClass) ||
    error instanceof LocalEndpointError ||
    error instanceof StartupCapabilityInputError
  ) {
    return error.code;
  }
  return "internal_error";
}

const directEntry = process.argv[1];
if (directEntry !== undefined && import.meta.url === pathToFileURL(directEntry).href) {
  await main();
}
