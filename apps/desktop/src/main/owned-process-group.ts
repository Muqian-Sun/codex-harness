import { performance } from "node:perf_hooks";

const MAX_TERMINATION_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10;

export type ProcessGroupEscalation = "already_gone" | "sigterm" | "sigkill" | "containment_unknown";

export type ProcessGroupTerminationConfig = Readonly<{
  sigtermTimeoutMs: number;
  sigkillTimeoutMs: number;
  pollIntervalMs?: number;
}>;

function validPositiveInteger(value: number, maximum = MAX_TERMINATION_TIMEOUT_MS): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

export function ownedProcessGroupExists(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    return true;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error: unknown) {
    return !isNoSuchProcess(error);
  }
}

export async function waitForOwnedProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1 ||
    !validPositiveInteger(timeoutMs) ||
    !validPositiveInteger(pollIntervalMs, 1_000)
  ) {
    return false;
  }

  const deadline = performance.now() + timeoutMs;
  while (ownedProcessGroupExists(processGroupId)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }
  return true;
}

export async function terminateOwnedProcessGroup(
  processGroupId: number,
  config: ProcessGroupTerminationConfig,
): Promise<ProcessGroupEscalation> {
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1 ||
    !validPositiveInteger(config.sigtermTimeoutMs) ||
    !validPositiveInteger(config.sigkillTimeoutMs) ||
    !validPositiveInteger(pollIntervalMs, 1_000)
  ) {
    return "containment_unknown";
  }
  if (!ownedProcessGroupExists(processGroupId)) {
    return "already_gone";
  }

  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForOwnedProcessGroupExit(processGroupId, config.sigtermTimeoutMs, pollIntervalMs)) {
    return "sigterm";
  }

  signalProcessGroup(processGroupId, "SIGKILL");
  if (await waitForOwnedProcessGroupExit(processGroupId, config.sigkillTimeoutMs, pollIntervalMs)) {
    return "sigkill";
  }
  return "containment_unknown";
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The following existence check decides whether containment can be proven.
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
