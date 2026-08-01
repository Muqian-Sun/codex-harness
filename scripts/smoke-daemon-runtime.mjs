import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function smokeDaemonRuntime() {
  if (process.platform === "win32") {
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "ch-smoke-"));
  await chmod(directory, 0o700);
  const endpoint = join(directory, "harnessd.sock");
  const capability = randomBytes(32).toString("base64url");
  const cliPath = fileURLToPath(new URL("../apps/harnessd/dist/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cliPath, "--endpoint", endpoint], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  let client;
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

    await waitForSocket(endpoint, child);
    const { HarnessRpcClient } = await import("../apps/desktop/dist/main/index.js");
    client = await HarnessRpcClient.connect({
      endpoint,
      startupCapability: capability,
      clientVersion: "0.0.0",
      connectTimeoutMs: 5_000,
      handshakeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    const health = await client.health();
    if (health.status !== "ok") {
      throw new Error("The desktop RPC client health smoke response was invalid.");
    }
    const shutdown = await client.requestShutdown("build.smoke");
    if (!shutdown.accepted) {
      throw new Error("The desktop RPC client shutdown smoke response was invalid.");
    }

    const [exitCode, signal] = await waitForExit(child, 5_000);
    if (exitCode !== 0 || signal !== null) {
      throw new Error(`The daemon smoke process failed: ${stderr.trim()}`);
    }
    await smokeParentWatchdog(cliPath, endpoint);
    await smokeInvalidCapability(cliPath, endpoint);
  } finally {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function smokeInvalidCapability(cliPath, endpoint) {
  const invalidCapability = `${"A".repeat(42)}B`;
  const child = spawn(process.execPath, [cliPath, "--endpoint", endpoint], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
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

async function smokeParentWatchdog(cliPath, endpoint) {
  const capability = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [cliPath, "--endpoint", endpoint], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
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
