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
import type {
  AppServerWorkerCloseResult,
  AppServerWorkerConfig,
  AppServerWorkerState,
} from "./app-server-worker.js";
import {
  AppServerWorkerManager,
  type AppServerWorkerManagerDependencies,
  type ManagedAppServerWorker,
} from "./app-server-worker-manager.js";
import { monitorParentWatchdog } from "./parent-watchdog.js";

const STARTUP_CAPABILITY = "A".repeat(43);
const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000611";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000612";
const temporaryDirectories: string[] = [];
const runtimes: DaemonRuntime[] = [];
const sockets: Socket[] = [];

async function createRuntime(options?: {
  drainTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  workerManager?: AppServerWorkerManager;
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
    ...(options?.workerManager === undefined ? {} : { workerManager: options.workerManager }),
  });
  runtimes.push(runtime);
  return { endpoint, runtime };
}

class RuntimeFakeWorker implements ManagedAppServerWorker {
  state: AppServerWorkerState = "ready";
  readonly closed: Promise<AppServerWorkerCloseResult>;
  readonly #closeResult: AppServerWorkerCloseResult;
  readonly #closeGate: Promise<void> | undefined;
  #resolveClosed!: (result: AppServerWorkerCloseResult) => void;
  closeCalls = 0;

  constructor(
    closeResult: AppServerWorkerCloseResult = runtimeWorkerClose(),
    closeGate?: Promise<void>,
  ) {
    this.#closeResult = closeResult;
    this.#closeGate = closeGate;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async listModels(): Promise<JsonValue> {
    return {
      data: [
        {
          id: "id-runtime",
          model: "runtime",
          hidden: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          inputModalities: ["text"],
        },
      ],
      nextCursor: null,
    };
  }

  async close(): Promise<AppServerWorkerCloseResult> {
    this.closeCalls += 1;
    if (this.state === "closed") {
      return this.#closeResult;
    }
    this.state = "closing";
    await this.#closeGate;
    this.state = "closed";
    this.#resolveClosed(this.#closeResult);
    return this.#closeResult;
  }

  fail(): void {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    this.#resolveClosed(runtimeWorkerClose("already_exited", "worker_exited"));
  }
}

function runtimeWorkerClose(
  containment: AppServerWorkerCloseResult["containment"] = "graceful",
  reason: AppServerWorkerCloseResult["reason"] = "requested",
): AppServerWorkerCloseResult {
  return Object.freeze({
    reason,
    containment,
    exitCode: containment === "graceful" ? 0 : null,
    signal: null,
    stderrObserved: false,
  });
}

async function createWorkerManager(worker: RuntimeFakeWorker): Promise<AppServerWorkerManager> {
  const ids = [WORKER_SESSION_ID, SNAPSHOT_ID];
  const dependencies: AppServerWorkerManagerDependencies = Object.freeze({
    startWorker: async () => worker,
    newId: () => ids.shift() ?? "missing-id",
    now: () => 1_750_000_000_200,
  });
  return await AppServerWorkerManager.start(
    { provider: "openai", worker: {} as AppServerWorkerConfig },
    dependencies,
  );
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

  it("waits for its worker manager before completing requested quiesce", async () => {
    const closeGate = deferred<void>();
    const worker = new RuntimeFakeWorker(runtimeWorkerClose(), closeGate.promise);
    const workerManager = await createWorkerManager(worker);
    const { runtime } = await createRuntime({ workerManager });
    let runtimeClosed = false;
    void runtime.closed.then(() => {
      runtimeClosed = true;
    });

    expect(runtime.requestQuiesce("requested")).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(worker.closeCalls).toBe(1);
    expect(runtimeClosed).toBe(false);

    closeGate.resolve(undefined);
    await expect(runtime.closed).resolves.toEqual({
      reason: "requested",
      endpointCleanup: "removed",
    });
    expect(runtime.state).toBe("closed");
  });

  it("quiesces with a stable failure when the managed worker exits", async () => {
    const worker = new RuntimeFakeWorker();
    const workerManager = await createWorkerManager(worker);
    const { runtime } = await createRuntime({ workerManager });

    worker.fail();
    await expect(runtime.closed).resolves.toEqual({
      reason: "worker_failure",
      endpointCleanup: "removed",
      errorCode: "worker_failure",
    });
    expect(workerManager.catalog).toBeNull();
  });

  it("reports unknown worker containment during requested shutdown", async () => {
    const worker = new RuntimeFakeWorker(runtimeWorkerClose("containment_unknown"));
    const workerManager = await createWorkerManager(worker);
    const { runtime } = await createRuntime({ workerManager });

    runtime.requestQuiesce("requested");
    await expect(runtime.closed).resolves.toEqual({
      reason: "requested",
      endpointCleanup: "removed",
      errorCode: "worker_shutdown_failed",
    });
  });

  it("fails startup and removes the endpoint if the manager closes before listen is ready", async () => {
    const worker = new RuntimeFakeWorker();
    const workerManager = await createWorkerManager(worker);
    const directory = await mkdtemp(join(tmpdir(), "codex-harness-runtime-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const endpoint = join(directory, "harnessd.sock");

    const starting = DaemonRuntime.start({
      endpoint,
      startupCapability: STARTUP_CAPABILITY,
      serverVersion: "0.0.0",
      platform: "posix",
      drainTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      workerManager,
    });
    worker.fail();

    await expect(starting).rejects.toMatchObject({ code: "worker_unavailable" });
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(workerManager.closed).resolves.toMatchObject({ reason: "worker_failure" });
  });
});

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return Object.freeze({ promise, resolve });
}
