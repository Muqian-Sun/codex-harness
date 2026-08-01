import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_WIRE_VERSION = "1";
const APPLICATION_PROTOCOL_VERSION = "1.0";

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
  let socket;
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
    socket = createConnection({ path: endpoint });
    await once(socket, "connect");

    const helloResponse = readFrame(socket);
    writeFrame(socket, {
      kind: "bootstrap-request",
      wireVersion: BOOTSTRAP_WIRE_VERSION,
      id: "smoke-hello",
      method: "system.hello",
      params: {
        client: { name: "CodexHarnessBuildSmoke", version: "0.0.0" },
        supportedProtocolVersions: [APPLICATION_PROTOCOL_VERSION],
        capabilities: { supported: [], required: [] },
        startupCapability: capability,
      },
    });
    const hello = await helloResponse;
    if (hello.kind !== "bootstrap-response" || hello.id !== "smoke-hello") {
      throw new Error("The daemon bootstrap smoke response was invalid.");
    }

    const shutdownResponse = readFrame(socket);
    writeFrame(socket, {
      kind: "request",
      wireVersion: BOOTSTRAP_WIRE_VERSION,
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      id: "smoke-shutdown",
      method: "system.shutdown",
      params: { reason: "build.smoke" },
    });
    const shutdown = await shutdownResponse;
    if (shutdown.kind !== "response" || shutdown.id !== "smoke-shutdown") {
      throw new Error("The daemon shutdown smoke response was invalid.");
    }

    const [exitCode, signal] = await waitForExit(child, 5_000);
    if (exitCode !== 0 || signal !== null) {
      throw new Error(`The daemon smoke process failed: ${stderr.trim()}`);
    }
    await smokeParentWatchdog(cliPath, endpoint);
    await smokeInvalidCapability(cliPath, endpoint);
  } finally {
    socket?.destroy();
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

function writeFrame(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

async function readFrame(socket) {
  return await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      cleanup();
      resolve(JSON.parse(buffered.subarray(0, newline).toString("utf8")));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("The daemon socket closed before returning a frame."));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
