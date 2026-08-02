import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fakeCodexSource } from "./smoke-app-server-worker-manager.mjs";

export async function smokeDaemonRuntime() {
  if (process.platform !== "darwin") {
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "ch-smoke-"));
  await chmod(directory, 0o700);
  const endpoint = join(directory, "harnessd.sock");
  const codexExecutable = join(directory, "fake-codex.mjs");
  const cliPath = fileURLToPath(new URL("../apps/harnessd/dist/cli.js", import.meta.url));
  let supervisor;

  try {
    await writeFile(codexExecutable, fakeCodexSource(), { encoding: "utf8", mode: 0o700 });
    await chmod(codexExecutable, 0o700);
    const { DaemonProcessSupervisor } = await import("../apps/desktop/dist/main/index.js");
    let resolveAccountEvent;
    const accountEventPromise = new Promise((resolve) => {
      resolveAccountEvent = resolve;
    });
    supervisor = await DaemonProcessSupervisor.start({
      command: process.execPath,
      codexExecutable,
      args: [cliPath],
      runtimeRoot: directory,
      clientVersion: "0.0.0",
      onAccountStatusChanged: resolveAccountEvent,
    });
    const health = await supervisor.client.health();
    if (health.status !== "ok") {
      throw new Error("The supervised daemon health smoke response was invalid.");
    }
    const account = await supervisor.readAccountStatus();
    if (
      account.status !== "authenticated" ||
      account.credentialKind !== "chatgpt" ||
      account.planType !== "pro" ||
      JSON.stringify(account).includes("private@example.com") ||
      JSON.stringify(account).includes("must-not-survive")
    ) {
      throw new Error("The supervised daemon account status response was invalid.");
    }
    const accountEvent = await Promise.race([
      accountEventPromise,
      delay(5_000).then(() => {
        throw new Error("The supervised daemon account event timed out.");
      }),
    ]);
    if (
      accountEvent.sequence !== 1 ||
      accountEvent.account.status !== "authenticated" ||
      accountEvent.account.credentialKind !== "chatgpt" ||
      accountEvent.account.planType !== "pro" ||
      accountEvent.account.snapshotId === account.snapshotId ||
      JSON.stringify(accountEvent).includes("private@example.com") ||
      JSON.stringify(accountEvent).includes("must-not-survive")
    ) {
      throw new Error("The supervised daemon account event was invalid.");
    }
    const stopped = await supervisor.stop();
    if (
      !stopped.expected ||
      stopped.exitCode !== 0 ||
      stopped.signal !== null ||
      stopped.containment !== "graceful" ||
      stopped.runtimeDirectoryCleanup !== "removed"
    ) {
      throw new Error("The supervised daemon did not stop cleanly.");
    }
    await smokeSupervisorRpcLoss(DaemonProcessSupervisor, cliPath, codexExecutable, directory);
    await smokeParentWatchdog(cliPath, endpoint, codexExecutable);
    await smokeInvalidCapability(cliPath, endpoint, codexExecutable);
    await smokeUnsupportedCodex(cliPath, endpoint);
  } finally {
    if (supervisor && supervisor.state !== "closed") {
      await supervisor.stop();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function smokeSupervisorRpcLoss(
  DaemonProcessSupervisor,
  cliPath,
  codexExecutable,
  runtimeRoot,
) {
  const supervisor = await DaemonProcessSupervisor.start({
    command: process.execPath,
    codexExecutable,
    args: [cliPath],
    runtimeRoot,
    clientVersion: "0.0.0",
  });
  supervisor.client.close();
  const closed = await supervisor.closed;
  if (
    closed.expected ||
    closed.containment === "containment_unknown" ||
    closed.runtimeDirectoryCleanup !== "removed"
  ) {
    throw new Error("The supervisor did not contain an unexpected RPC disconnect.");
  }
}

async function smokeInvalidCapability(cliPath, endpoint, codexExecutable) {
  const invalidCapability = `${"A".repeat(42)}B`;
  const child = spawn(
    process.execPath,
    [cliPath, "--endpoint", endpoint, "--codex-executable", codexExecutable],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  try {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const capabilityPipe = child.stdio[3];
    const watchdogPipe = child.stdio[4];
    if (!capabilityPipe || !watchdogPipe || !("write" in capabilityPipe)) {
      throw new Error("The daemon inherited pipes were not created.");
    }
    capabilityPipe.on("error", () => undefined);
    watchdogPipe.on("error", () => undefined);
    capabilityPipe.end(invalidCapability);
    const [exitCode, signal] = await waitForExit(child, 5_000);
    if (exitCode !== 1 || signal !== null) {
      throw new Error("The daemon accepted an invalid startup capability.");
    }
    if (
      stderr !== "harnessd startup failed (invalid_capability).\n" ||
      stderr.includes(invalidCapability)
    ) {
      throw new Error("The daemon exposed unsafe startup diagnostics.");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}

async function smokeParentWatchdog(cliPath, endpoint, codexExecutable) {
  const capability = randomBytes(32).toString("base64url");
  const child = spawn(
    process.execPath,
    [cliPath, "--endpoint", endpoint, "--codex-executable", codexExecutable],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  try {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const capabilityPipe = child.stdio[3];
    const watchdogPipe = child.stdio[4];
    if (
      !capabilityPipe ||
      !watchdogPipe ||
      !("write" in capabilityPipe) ||
      !("end" in watchdogPipe)
    ) {
      throw new Error("The daemon inherited pipes were not created.");
    }
    capabilityPipe.on("error", () => undefined);
    watchdogPipe.on("error", () => undefined);
    capabilityPipe.end(capability);
    await waitForSocket(endpoint, child);
    watchdogPipe.end();
    const [exitCode, signal] = await waitForExit(child, 5_000);
    if (exitCode !== 0 || signal !== null) {
      throw new Error(`The daemon parent-watchdog smoke failed: ${stderr.trim()}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  }
}

async function smokeUnsupportedCodex(cliPath, endpoint) {
  const capability = randomBytes(32).toString("base64url");
  const child = spawn(
    process.execPath,
    [cliPath, "--endpoint", endpoint, "--codex-executable", process.execPath],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  try {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const capabilityPipe = child.stdio[3];
    const watchdogPipe = child.stdio[4];
    if (!capabilityPipe || !watchdogPipe || !("write" in capabilityPipe)) {
      throw new Error("The daemon inherited pipes were not created.");
    }
    capabilityPipe.on("error", () => undefined);
    watchdogPipe.on("error", () => undefined);
    capabilityPipe.end(capability);
    const [exitCode, signal] = await waitForExit(child, 10_000);
    if (exitCode !== 1 || signal !== null) {
      throw new Error("The daemon accepted an unsupported Codex executable.");
    }
    if (
      stderr !== "harnessd startup failed (worker_start_failed).\n" ||
      stderr.includes(process.execPath)
    ) {
      throw new Error("The daemon exposed unsafe Codex startup diagnostics.");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}

async function waitForSocket(endpoint, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The daemon exited before creating its local endpoint.");
    }
    try {
      if ((await lstat(endpoint)).isSocket()) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error("The daemon did not create its local endpoint in time.");
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("The daemon did not exit in time."));
    }, timeoutMs);
    const onExit = (exitCode, signal) => {
      clearTimeout(timeout);
      resolve([exitCode, signal]);
    };
    child.once("exit", onExit);
  });
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
