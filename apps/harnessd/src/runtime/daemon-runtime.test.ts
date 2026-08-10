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
import { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";
import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
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
const ACCOUNT_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000613";
const SECOND_ACCOUNT_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000614";
const temporaryDirectories: string[] = [];
const runtimes: DaemonRuntime[] = [];
const sockets: Socket[] = [];

async function createRuntime(options?: {
  drainTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  stateStore?: DaemonStateStore;
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
    ...(options?.stateStore === undefined ? {} : { stateStore: options.stateStore }),
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
  readonly #accountResponses: JsonValue[];
  #resolveClosed!: (result: AppServerWorkerCloseResult) => void;
  closeCalls = 0;

  constructor(
    closeResult: AppServerWorkerCloseResult = runtimeWorkerClose(),
    closeGate?: Promise<void>,
    accountResponses: readonly JsonValue[] = [
      Object.freeze({ account: null, requiresOpenaiAuth: true }),
    ],
  ) {
    this.#closeResult = closeResult;
    this.#closeGate = closeGate;
    this.#accountResponses = [...accountResponses];
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

  async readAccount(): Promise<JsonValue> {
    const response = this.#accountResponses.shift();
    if (response === undefined) {
      throw new Error("missing fake account response");
    }
    return response;
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
  const ids = [WORKER_SESSION_ID, SNAPSHOT_ID, ACCOUNT_SNAPSHOT_ID, SECOND_ACCOUNT_SNAPSHOT_ID];
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

    const accountPromise = readFrame(socket);
    sendFrame(socket, rpc("account-1", "account.status", {}));
    await expect(accountPromise).resolves.toMatchObject({
      kind: "error",
      id: "account-1",
      error: { code: "service.unavailable" },
    });

    const catalogPromise = readFrame(socket);
    sendFrame(socket, rpc("catalog-1", "model.catalog_page", { cursor: null, limit: 12 }));
    await expect(catalogPromise).resolves.toMatchObject({
      kind: "error",
      id: "catalog-1",
      error: { code: "service.unavailable" },
    });

    const bindingStatusPromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("binding-status-1", "project.routing_binding.status_batch", {
        projectIds: ["00000000-0000-4000-8000-000000000941"],
      }),
    );
    await expect(bindingStatusPromise).resolves.toMatchObject({
      kind: "error",
      id: "binding-status-1",
      error: { code: "service.unavailable" },
    });

    const bindingWritePromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("binding-write-1", "project.routing_binding.bind_default", {
        commandId: "00000000-0000-4000-8000-000000000961",
        projectId: "00000000-0000-4000-8000-000000000941",
        expectedBindingVersion: 0,
        previousProfileId: null,
        expectedProfileVersion: 1,
        expectedConfigurationRevisionId: "00000000-0000-4000-8000-000000000951",
      }),
    );
    await expect(bindingWritePromise).resolves.toMatchObject({
      kind: "error",
      id: "binding-write-1",
      error: { code: "service.unavailable" },
    });

    const taskCatalogPromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("task-catalog-1", "task.catalog_page", {
        projectId: "00000000-0000-4000-8000-000000000941",
        cursor: null,
        limit: 12,
      }),
    );
    await expect(taskCatalogPromise).resolves.toMatchObject({
      kind: "error",
      id: "task-catalog-1",
      error: { code: "service.unavailable" },
    });

    const taskCreatePromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("task-create-1", "task.create", {
        commandId: "00000000-0000-4000-8000-000000000971",
        ownershipCommandId: "00000000-0000-4000-8000-000000000972",
        taskId: "00000000-0000-4000-8000-000000000973",
        projectId: "00000000-0000-4000-8000-000000000941",
        expectedProjectVersion: 1,
        expectedRoutingBindingVersion: 1,
        title: "Unavailable Task",
        sourceText: "No state store is present.",
      }),
    );
    await expect(taskCreatePromise).resolves.toMatchObject({
      kind: "error",
      id: "task-create-1",
      error: { code: "service.unavailable" },
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

  it("keeps recovered state open through readiness and closes it after listener shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-harness-runtime-state-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const stateStore = await DaemonStateStore.open({ databasePath: join(directory, "harness.db") });
    const runtime = await DaemonRuntime.start({
      endpoint: join(directory, "harnessd.sock"),
      startupCapability: STARTUP_CAPABILITY,
      serverVersion: "0.0.0",
      platform: "posix",
      drainTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      stateStore,
    });
    runtimes.push(runtime);

    expect(runtime.state).toBe("listening");
    expect(stateStore.state).toBe("ready");
    expect(stateStore.inspect()).toMatchObject({ eventCount: 0, projectionCount: 8 });
    runtime.requestQuiesce("requested");
    await expect(runtime.closed).resolves.toEqual({
      reason: "requested",
      endpointCleanup: "removed",
    });
    expect(stateStore.state).toBe("closed");
  });

  it("rejects and retains no closed state store during startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-harness-runtime-state-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const stateStore = await DaemonStateStore.open({ databasePath: join(directory, "harness.db") });
    stateStore.close();

    await expect(
      DaemonRuntime.start({
        endpoint: join(directory, "harnessd.sock"),
        startupCapability: STARTUP_CAPABILITY,
        serverVersion: "0.0.0",
        platform: "posix",
        stateStore,
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(lstat(join(directory, "harnessd.sock"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("serves only the current managed account snapshot", async () => {
    const worker = new RuntimeFakeWorker();
    const workerManager = await createWorkerManager(worker);
    const { endpoint } = await createRuntime({ workerManager });
    const socket = await connect(endpoint);
    await authenticate(socket);

    const responsePromise = readFrame(socket);
    sendFrame(socket, rpc("account-current", "account.status", {}));
    await expect(responsePromise).resolves.toMatchObject({
      kind: "response",
      id: "account-current",
      result: {
        schemaVersion: 1,
        snapshotId: ACCOUNT_SNAPSHOT_ID,
        workerSessionId: WORKER_SESSION_ID,
        status: "authentication_required",
        credentialKind: null,
        planType: null,
      },
    });
  });

  it("serves a bounded visible-only page from the current managed model catalog", async () => {
    const worker = new RuntimeFakeWorker();
    const workerManager = await createWorkerManager(worker);
    const { endpoint } = await createRuntime({ workerManager });
    const socket = await connect(endpoint);
    await authenticate(socket);

    const responsePromise = readFrame(socket);
    sendFrame(socket, rpc("catalog-current", "model.catalog_page", { cursor: null, limit: 12 }));
    const response = await responsePromise;
    expect(parseServerRpcEnvelope(response).ok).toBe(true);
    expect(response).toMatchObject({
      kind: "response",
      id: "catalog-current",
      result: {
        schemaVersion: 1,
        provider: "openai",
        totalVisibleModels: 1,
        models: [
          {
            model: "runtime",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium"],
            inputModalities: ["text"],
          },
        ],
        nextCursor: null,
      },
    });
    expect(JSON.stringify(response)).not.toContain("id-runtime");
    expect(JSON.stringify(response)).not.toContain(SNAPSHOT_ID);
    expect(JSON.stringify(response)).not.toContain(WORKER_SESSION_ID);
  });

  it("serves Project routing binding reads, writes, and conflicts through the real runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-harness-runtime-binding-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const stateStore = await DaemonStateStore.open({
      databasePath: join(directory, "harness.db"),
    });
    const projectId = "00000000-0000-4000-8000-000000000941";
    const configurationRevisionId = "00000000-0000-4000-8000-000000000951";
    new ProjectRegistryRepository(stateStore.events).registerProject({
      eventId: "00000000-0000-4000-8000-000000000943",
      projectId,
      displayName: "workspace",
      workspace: { platform: "macos", absolutePath: "/Users/example/workspace" },
      occurredAtMs: 1_750_000_000_001,
    });
    new ModelRoutingProfileRepository(stateStore.events).setConfiguration({
      profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      occurredAtMs: 1_750_000_000_002,
      configuration: {
        schemaVersion: 1,
        revisionId: configurationRevisionId,
        revisionNumber: 1,
        tiers: {
          fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
          standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
          deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
        },
      },
    });
    const { endpoint } = await createRuntime({ stateStore });
    const socket = await connect(endpoint);
    await authenticate(socket);

    const statusPromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("binding-status", "project.routing_binding.status_batch", { projectIds: [projectId] }),
    );
    await expect(statusPromise).resolves.toMatchObject({
      kind: "response",
      result: { statuses: [{ projectId, status: "unbound", binding: null }] },
    });

    const bindParams = {
      commandId: "00000000-0000-4000-8000-000000000961",
      projectId,
      expectedBindingVersion: 0,
      previousProfileId: null,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: configurationRevisionId,
    };
    const bindPromise = readFrame(socket);
    sendFrame(socket, rpc("binding-bind", "project.routing_binding.bind_default", bindParams));
    await expect(bindPromise).resolves.toMatchObject({
      kind: "response",
      result: { status: "bound", binding: { projectId, bindingVersion: 1 } },
    });

    const taskId = "00000000-0000-4000-8000-000000000971";
    const taskParams = {
      commandId: "00000000-0000-4000-8000-000000000972",
      ownershipCommandId: "00000000-0000-4000-8000-000000000973",
      taskId,
      projectId,
      expectedProjectVersion: 1,
      expectedRoutingBindingVersion: 1,
      title: "实现持久化 Task 目录",
      sourceText: "创建需求并在 daemon 重启后恢复。",
    };
    const createTaskPromise = readFrame(socket);
    sendFrame(socket, rpc("task-create", "task.create", taskParams));
    await expect(createTaskPromise).resolves.toMatchObject({
      kind: "response",
      result: { schemaVersion: 1, status: "created", taskId },
    });

    const listTasksPromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("task-catalog", "task.catalog_page", { projectId, cursor: null, limit: 12 }),
    );
    await expect(listTasksPromise).resolves.toMatchObject({
      kind: "response",
      result: {
        schemaVersion: 1,
        tasks: [
          {
            taskId,
            projectId,
            taskVersion: 1,
            title: taskParams.title,
            objective: taskParams.sourceText,
            stage: "requirements_only",
          },
        ],
        nextCursor: null,
      },
    });

    const retryTaskPromise = readFrame(socket);
    sendFrame(socket, rpc("task-retry", "task.create", taskParams));
    await expect(retryTaskPromise).resolves.toMatchObject({
      kind: "response",
      result: { schemaVersion: 1, status: "existing", taskId },
    });

    const missingTaskCatalogPromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("task-catalog-missing", "task.catalog_page", {
        projectId: "00000000-0000-4000-8000-000000000942",
        cursor: null,
        limit: 12,
      }),
    );
    await expect(missingTaskCatalogPromise).resolves.toMatchObject({
      kind: "error",
      error: { code: "rpc.conflict" },
    });

    const staleTaskPromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("task-create-stale", "task.create", {
        ...taskParams,
        commandId: "00000000-0000-4000-8000-000000000974",
        ownershipCommandId: "00000000-0000-4000-8000-000000000975",
        taskId: "00000000-0000-4000-8000-000000000976",
        expectedRoutingBindingVersion: 99,
      }),
    );
    await expect(staleTaskPromise).resolves.toMatchObject({
      kind: "error",
      error: { code: "rpc.conflict" },
    });

    const missingPromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("binding-missing", "project.routing_binding.status_batch", {
        projectIds: ["00000000-0000-4000-8000-000000000942"],
      }),
    );
    await expect(missingPromise).resolves.toMatchObject({
      kind: "error",
      error: { code: "rpc.conflict" },
    });

    const stalePromise = readFrame(socket);
    sendFrame(
      socket,
      rpc("binding-stale", "project.routing_binding.bind_default", {
        ...bindParams,
        commandId: "00000000-0000-4000-8000-000000000962",
      }),
    );
    await expect(stalePromise).resolves.toMatchObject({
      kind: "error",
      error: { code: "rpc.conflict" },
    });
  });

  it("publishes a strictly sequenced account event after the manager installs a new snapshot", async () => {
    const worker = new RuntimeFakeWorker(runtimeWorkerClose(), undefined, [
      Object.freeze({ account: null, requiresOpenaiAuth: true }),
      Object.freeze({
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      }),
    ]);
    const workerManager = await createWorkerManager(worker);
    const { endpoint } = await createRuntime({ workerManager });
    const socket = await connect(endpoint);
    await authenticate(socket);
    const eventPromise = readFrame(socket);

    const refreshed = await workerManager.refreshAccountStatus();
    const event = await eventPromise;

    expect(refreshed.snapshotId).toBe(SECOND_ACCOUNT_SNAPSHOT_ID);
    expect(parseServerRpcEnvelope(event).ok).toBe(true);
    expect(event).toMatchObject({
      kind: "event",
      streamId: expect.any(String),
      sequence: 1,
      method: "account.status_changed",
      params: {
        snapshotId: SECOND_ACCOUNT_SNAPSHOT_ID,
        workerSessionId: WORKER_SESSION_ID,
        status: "authenticated",
        credentialKind: "chatgpt",
        planType: "pro",
      },
    });
  });

  it("drops updates without an authenticated connection and serves the latest snapshot on pull", async () => {
    const worker = new RuntimeFakeWorker(runtimeWorkerClose(), undefined, [
      Object.freeze({ account: null, requiresOpenaiAuth: true }),
      Object.freeze({
        account: { type: "chatgpt", planType: "team" },
        requiresOpenaiAuth: true,
      }),
    ]);
    const workerManager = await createWorkerManager(worker);
    const { endpoint } = await createRuntime({ workerManager });
    const socket = await connect(endpoint);
    await workerManager.refreshAccountStatus();
    await authenticate(socket);
    const responsePromise = readFrame(socket);

    sendFrame(socket, rpc("account-latest", "account.status", {}));

    await expect(responsePromise).resolves.toMatchObject({
      kind: "response",
      id: "account-latest",
      result: {
        snapshotId: SECOND_ACCOUNT_SNAPSHOT_ID,
        status: "authenticated",
        planType: "team",
      },
    });
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
