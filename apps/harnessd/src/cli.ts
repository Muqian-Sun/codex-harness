#!/usr/bin/env node

import { closeSync, createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AppServerWorkerManager,
  AppServerWorkerManagerError,
} from "./runtime/app-server-worker-manager.js";
import { DaemonRuntime, DaemonRuntimeStartError } from "./runtime/daemon-runtime.js";
import { LocalEndpointError } from "./runtime/local-endpoint.js";
import { monitorParentWatchdog, type ParentLossReason } from "./runtime/parent-watchdog.js";
import {
  StartupCapabilityInputError,
  readStartupCapability,
} from "./runtime/startup-capability.js";
import { HARNESS_DAEMON_VERSION } from "./version.js";

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
}> {
  if (
    args.length !== 4 ||
    args[0] !== "--endpoint" ||
    !args[1] ||
    args[1].includes("\0") ||
    args[2] !== "--codex-executable" ||
    !args[3] ||
    args[3].includes("\0") ||
    !isAbsolute(args[3])
  ) {
    throw new DaemonCliError("invalid_arguments");
  }
  return Object.freeze({ endpoint: args[1], codexExecutable: args[3] });
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  let disposeWatchdog: (() => void) | undefined;
  let runtime: DaemonRuntime | undefined;
  let workerManager: AppServerWorkerManager | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  try {
    const { endpoint, codexExecutable } = parseDaemonArguments(args);
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

    runtime = await DaemonRuntime.start({
      endpoint,
      startupCapability,
      serverVersion: HARNESS_DAEMON_VERSION,
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
    process.stderr.write(`harnessd startup failed (${publicFailureCode(error)}).\n`);
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

function publicFailureCode(error: unknown): string {
  if (
    error instanceof DaemonCliError ||
    error instanceof AppServerWorkerManagerError ||
    error instanceof DaemonRuntimeStartError ||
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
