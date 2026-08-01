import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  parseServerBootstrapEnvelope,
  parseServerRpcEnvelope,
  type JsonValue,
} from "@codex-harness/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonRuntime } from "./daemon-runtime.js";
import { monitorParentWatchdog } from "./parent-watchdog.js";

const STARTUP_CAPABILITY = "A".repeat(43);
const temporaryDirectories: string[] = [];
const runtimes: DaemonRuntime[] = [];
const sockets: Socket[] = [];

async function createRuntime(options?: {
  drainTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}): Promise<{ endpoint: string; runtime: DaemonRuntime }> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-runtime-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  const endpoint = join(directory, "harnessd.sock");
  const runtime = await DaemonRuntime.start({
    endpoint,
    startupCapability: STARTUP_CAPABILITY,
    serverVersion: "0.0.0",
    platform: "posix",
    drainTimeoutMs: options?.drainTimeoutMs ?? 100,
    handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 100,
  });
  runtimes.push(runtime);
  return { endpoint, runtime };
}

async function connect(endpoint: string, allowHalfOpen = false): Promise<Socket> {
  const socket = createConnection({ path: endpoint, allowHalfOpen });
  sockets.push(socket);
  await once(socket, "connect");
  return socket;
}

function hello(capability = STARTUP_CAPABILITY): JsonValue {
  return {
    kind: "bootstrap-request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    id: "hello-1",
    method: "system.hello",
    params: {
      client: { name: "CodexHarnessDesktop", version: "0.0.0" },
      supportedProtocolVersions: [APPLICATION_PROTOCOL_VERSION],
      capabilities: { supported: [], required: [] },
      startupCapability: capability,
    },
  };
}

function rpc(id: string, method: string, params: JsonValue): JsonValue {
  return {
    kind: "request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id,
    method,
    params,
  };
}

function sendFrame(socket: Socket, value: JsonValue): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

async function readFrame(socket: Socket): Promise<JsonValue> {
  return await new Promise<JsonValue>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      cleanup();
      resolve(JSON.parse(buffered.subarray(0, newline).toString("utf8")) as JsonValue);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("socket closed before a frame was received"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function authenticate(socket: Socket): Promise<void> {
  const responsePromise = readFrame(socket);
  sendFrame(socket, hello());
  const response = await responsePromise;
  expect(parseServerBootstrapEnvelope(response).ok).toBe(true);
  expect(response).toMatchObject({ kind: "bootstrap-response", id: "hello-1" });
}

afterEach(async () => {
  const activeRuntimes = runtimes.splice(0);
  for (const runtime of activeRuntimes) {
    runtime.requestQuiesce("requested");
  }
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(activeRuntimes.map(async (runtime) => await runtime.closed));
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("daemon local runtime", () => {
  it("serves hello, health, and graceful shutdown over an owner-only Unix socket", async () => {
    const { endpoint, runtime } = await createRuntime();
    expect((await lstat(endpoint)).mode & 0o777).toBe(0o600);
    const socket = await connect(endpoint);
    await authenticate(socket);

    const healthPromise = readFrame(socket);
    sendFrame(socket, rpc("health-1", "system.health", {}));
    const health = await healthPromise;
    expect(parseServerRpcEnvelope(health).ok).toBe(true);
    expect(health).toMatchObject({
      kind: "response",
      id: "health-1",
      result: { status: "ok" },
    });

    const closePromise = once(socket, "close");
    const shutdownResponsePromise = readFrame(socket);
    sendFrame(socket, rpc("shutdown-1", "system.shutdown", { reason: "user.requested" }));
    await expect(shutdownResponsePromise).resolves.toMatchObject({
      kind: "response",
      id: "shutdown-1",
      result: { accepted: true },
    });
    await closePromise;
    await expect(runtime.closed).resolves.toEqual({
      reason: "rpc_shutdown",
      endpointCleanup: "removed",
    });
    expect(runtime.state).toBe("closed");
  });

  it("rejects concurrent clients while preserving the active connection", async () => {
    const { endpoint, runtime } = await createRuntime();
    const active = await connect(endpoint);
    const rejected = await connect(endpoint);
    await once(rejected, "close");
    await authenticate(active);
    expect(runtime.state).toBe("listening");
  });

  it("allows a fresh connection after failed authentication", async () => {
    const { endpoint } = await createRuntime();
    const rejected = await connect(endpoint);
    const responsePromise = readFrame(rejected);
    const closePromise = once(rejected, "close");
    sendFrame(rejected, hello(`${"B".repeat(42)}A`));
    await expect(responsePromise).resolves.toMatchObject({ kind: "bootstrap-error" });
    await closePromise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const accepted = await connect(endpoint);
    await authenticate(accepted);
  });

  it("releases an unauthenticated connection after the handshake timeout", async () => {
    const { endpoint } = await createRuntime({ handshakeTimeoutMs: 20 });
    const stalled = await connect(endpoint);
    await once(stalled, "close");
    const accepted = await connect(endpoint);
    await authenticate(accepted);
  });

  it("quiesces exactly once on parent EOF and enforces the drain timeout", async () => {
    const { endpoint, runtime } = await createRuntime({ drainTimeoutMs: 20 });
    const client = await connect(endpoint, true);
    await authenticate(client);
    const watchdog = new PassThrough();
    monitorParentWatchdog(watchdog, (reason) => runtime.requestQuiesce(reason));
    watchdog.end();

    await expect(runtime.closed).resolves.toEqual({
      reason: "parent_eof",
      endpointCleanup: "removed",
    });
    expect(runtime.requestQuiesce("requested")).toBe(false);
  });

  it("does not delete a regular file that replaces its socket path", async () => {
    const { endpoint, runtime } = await createRuntime();
    const directory = dirname(endpoint);
    await unlink(endpoint);
    await writeFile(endpoint, "sentinel");
    expect(runtime.requestQuiesce("requested")).toBe(true);
    await expect(runtime.closed).resolves.toEqual({
      reason: "requested",
      endpointCleanup: "replacement_preserved",
      errorCode: "endpoint_cleanup_failed",
    });
    const preservedName = (await readdir(directory)).find((name) =>
      name.startsWith("harnessd.sock.preserved-"),
    );
    expect(preservedName).toBeDefined();
    await expect(readFile(join(directory, preservedName ?? ""), "utf8")).resolves.toBe("sentinel");
  });
});
