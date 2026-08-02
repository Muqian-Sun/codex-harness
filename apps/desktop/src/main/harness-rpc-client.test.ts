import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  JsonlFrameDecoder,
  type JsonValue,
} from "@codex-harness/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonRuntime } from "../../../harnessd/src/runtime/daemon-runtime.js";
import { HarnessRpcClient, HarnessRpcClientError } from "./harness-rpc-client.js";

const STARTUP_CAPABILITY = "A".repeat(43);
const OTHER_STARTUP_CAPABILITY = `${"B".repeat(42)}A`;
const STREAM_ID = "A".repeat(22);
const temporaryDirectories: string[] = [];
const clients: HarnessRpcClient[] = [];
const runtimes: DaemonRuntime[] = [];
const servers: Server[] = [];
const serverSockets: Socket[] = [];

type FrameHandler = (value: JsonValue, socket: Socket) => void;

async function createPrivateEndpoint(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harnessd.sock");
}

async function createScriptedServer(onFrame: FrameHandler): Promise<string> {
  const endpoint = await createPrivateEndpoint("codex-harness-client-");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    serverSockets.push(socket);
    const decoder = new JsonlFrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      const decoded = decoder.push(chunk);
      if (!decoded.ok) {
        socket.destroy();
        return;
      }
      for (const frame of decoded.frames) {
        onFrame(JSON.parse(Buffer.from(frame).toString("utf8")) as JsonValue, socket);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return endpoint;
}

async function createClient(
  endpoint: string,
  options?: Readonly<{
    startupCapability?: string;
    handshakeTimeoutMs?: number;
    requestTimeoutMs?: number;
    onEvent?: NonNullable<Parameters<typeof HarnessRpcClient.connect>[0]["onEvent"]>;
  }>,
): Promise<HarnessRpcClient> {
  const client = await HarnessRpcClient.connect({
    endpoint,
    startupCapability: options?.startupCapability ?? STARTUP_CAPABILITY,
    clientVersion: "0.0.0",
    handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 500,
    requestTimeoutMs: options?.requestTimeoutMs ?? 500,
    ...(options?.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  clients.push(client);
  return client;
}

function record(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object frame.");
  }
  return value;
}

function requestId(value: JsonValue): string {
  const id = record(value).id;
  if (typeof id !== "string") {
    throw new Error("Expected a request identifier.");
  }
  return id;
}

function writeFrame(socket: Socket, value: JsonValue): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function acceptHello(socket: Socket, value: JsonValue): void {
  expect(record(value).kind).toBe("bootstrap-request");
  writeFrame(socket, {
    kind: "bootstrap-response",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    id: requestId(value),
    result: {
      selectedProtocolVersion: APPLICATION_PROTOCOL_VERSION,
      server: { name: "harnessd", version: "0.0.0" },
      enabledCapabilities: [],
      stream: {
        id: STREAM_ID,
        nextSequence: 1,
        replayWindowStart: 1,
        resyncRequired: false,
      },
    },
  });
}

function healthResponse(id: string, uptimeMs: number): JsonValue {
  return {
    kind: "response",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id,
    result: { status: "ok", streamId: STREAM_ID, uptimeMs },
  };
}

function accountStatus(planType: "plus" | "pro" = "plus", snapshot = "831"): JsonValue {
  return {
    schemaVersion: 1,
    snapshotId: `00000000-0000-4000-8000-000000000${snapshot}`,
    workerSessionId: "00000000-0000-4000-8000-000000000832",
    observedAtMs: 1_750_000_000_001,
    status: "authenticated",
    credentialKind: "chatgpt",
    planType,
  };
}

function accountEvent(
  sequence: number,
  params: JsonValue = accountStatus("pro", "833"),
): JsonValue {
  return {
    kind: "event",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    streamId: STREAM_ID,
    sequence,
    method: "account.status_changed",
    params,
  };
}

function modelCatalogPage(): JsonValue {
  return {
    schemaVersion: 1,
    provider: "openai",
    totalVisibleModels: 1,
    models: [
      {
        model: "gpt-model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
        inputModalities: ["text"],
      },
    ],
    nextCursor: null,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  for (const runtime of runtimes) {
    runtime.requestQuiesce("requested");
  }
  for (const socket of serverSockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.closed));
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Harness RPC client configuration", () => {
  it("rejects invalid configuration before opening a socket", async () => {
    await expect(
      HarnessRpcClient.connect({
        endpoint: "relative.sock",
        startupCapability: STARTUP_CAPABILITY,
        clientVersion: "0.0.0",
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    const connectUnknown = HarnessRpcClient.connect as unknown as (
      config: unknown,
    ) => Promise<HarnessRpcClient>;
    await expect(connectUnknown(null)).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});

describe.skipIf(process.platform === "win32")("Harness RPC client over a local Unix socket", () => {
  it("performs hello, health, and graceful shutdown against the daemon runtime", async () => {
    const endpoint = await createPrivateEndpoint("codex-harness-client-runtime-");
    const runtime = await DaemonRuntime.start({
      endpoint,
      startupCapability: STARTUP_CAPABILITY,
      serverVersion: "0.0.0",
      platform: "posix",
      drainTimeoutMs: 100,
      handshakeTimeoutMs: 500,
    });
    runtimes.push(runtime);

    const client = await createClient(endpoint);
    await expect(client.health()).resolves.toMatchObject({
      status: "ok",
      streamId: expect.any(String),
      uptimeMs: expect.any(Number),
    });
    await expect(client.requestShutdown("desktop.requested")).resolves.toEqual({ accepted: true });
    await expect(runtime.closed).resolves.toEqual({
      reason: "rpc_shutdown",
      endpointCleanup: "removed",
    });
  });

  it("matches concurrent responses by request ID even when they arrive out of order", async () => {
    const requests: JsonValue[] = [];
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      requests.push(value);
      if (requests.length === 2) {
        writeFrame(socket, healthResponse(requestId(requests[1] as JsonValue), 2));
        writeFrame(socket, healthResponse(requestId(requests[0] as JsonValue), 1));
      }
    });
    const client = await createClient(endpoint);

    const first = client.health();
    const second = client.health();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "ok", streamId: STREAM_ID, uptimeMs: 1 },
      { status: "ok", streamId: STREAM_ID, uptimeMs: 2 },
    ]);
    expect(client.state).toBe("ready");
  });

  it("reads a strictly validated account status snapshot", async () => {
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      writeFrame(socket, {
        kind: "response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: requestId(value),
        result: {
          schemaVersion: 1,
          snapshotId: "00000000-0000-4000-8000-000000000831",
          workerSessionId: "00000000-0000-4000-8000-000000000832",
          observedAtMs: 1_750_000_000_001,
          status: "authenticated",
          credentialKind: "chatgpt",
          planType: "plus",
        },
      });
    });
    const client = await createClient(endpoint);

    await expect(client.accountStatus()).resolves.toMatchObject({
      status: "authenticated",
      credentialKind: "chatgpt",
      planType: "plus",
    });
    expect(client.state).toBe("ready");
  });

  it("reads a strictly validated bounded model catalog page", async () => {
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      expect(value).toMatchObject({
        kind: "request",
        method: "model.catalog_page",
        params: { cursor: null, limit: 12 },
      });
      writeFrame(socket, {
        kind: "response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: requestId(value),
        result: modelCatalogPage(),
      });
    });
    const client = await createClient(endpoint);

    await expect(client.modelCatalogPage({ cursor: null, limit: 12 })).resolves.toEqual(
      modelCatalogPage(),
    );
  });

  it("fails closed when a model catalog result contains private fields", async () => {
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      writeFrame(socket, {
        kind: "response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: requestId(value),
        result: { ...record(modelCatalogPage()), snapshotId: "private-snapshot" },
      });
    });
    const client = await createClient(endpoint);

    const error = await client
      .modelCatalogPage({ cursor: null, limit: 12 })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "protocol_violation" });
    expect(JSON.stringify(error)).not.toContain("private-snapshot");
    expect(client.state).toBe("closed");
  });

  it("captures the event sequence barrier at the exact account response position", async () => {
    const receivedSequences: number[] = [];
    let order: "event-first" | "response-first" = "event-first";
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      const response: JsonValue = {
        kind: "response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: requestId(value),
        result: accountStatus("plus", order === "event-first" ? "834" : "835"),
      };
      if (order === "event-first") {
        writeFrame(socket, accountEvent(1));
        writeFrame(socket, response);
      } else {
        writeFrame(socket, response);
        writeFrame(socket, accountEvent(2));
      }
    });
    const client = await createClient(endpoint, {
      onEvent: (event) => receivedSequences.push(event.sequence),
    });

    await expect(client.accountStatusObservation()).resolves.toMatchObject({
      observedThroughSequence: 1,
      account: { snapshotId: "00000000-0000-4000-8000-000000000834" },
    });
    order = "response-first";
    await expect(client.accountStatusObservation()).resolves.toMatchObject({
      observedThroughSequence: 1,
      account: { snapshotId: "00000000-0000-4000-8000-000000000835" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receivedSequences).toEqual([1, 2]);
  });

  it("fails closed when an account response contains an unapproved field", async () => {
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      writeFrame(socket, {
        kind: "response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: requestId(value),
        result: {
          schemaVersion: 1,
          snapshotId: "00000000-0000-4000-8000-000000000831",
          workerSessionId: "00000000-0000-4000-8000-000000000832",
          observedAtMs: 1,
          status: "authenticated",
          credentialKind: "chatgpt",
          planType: "plus",
          email: "private@example.com",
        },
      });
    });
    const client = await createClient(endpoint);

    const error = await client.accountStatus().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "protocol_violation" });
    expect(JSON.stringify(error)).not.toContain("private@example.com");
    expect(client.state).toBe("closed");
  });

  it("rejects one remote RPC error without invalidating the connection", async () => {
    let requestCount = 0;
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      requestCount += 1;
      if (requestCount === 1) {
        writeFrame(socket, {
          kind: "error",
          wireVersion: BOOTSTRAP_WIRE_VERSION,
          protocolVersion: APPLICATION_PROTOCOL_VERSION,
          id: requestId(value),
          error: { code: "service.unavailable", message: "Unavailable" },
        });
        return;
      }
      writeFrame(socket, healthResponse(requestId(value), 2));
    });
    const client = await createClient(endpoint);

    await expect(client.health()).rejects.toMatchObject({
      code: "rpc_error",
      remoteCode: "service.unavailable",
    });
    expect(client.state).toBe("ready");
    await expect(client.health()).resolves.toMatchObject({ uptimeMs: 2 });
  });

  it("fails all pending requests when a response result violates its method contract", async () => {
    const requests: JsonValue[] = [];
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      requests.push(value);
      if (requests.length === 2) {
        writeFrame(socket, {
          kind: "response",
          wireVersion: BOOTSTRAP_WIRE_VERSION,
          protocolVersion: APPLICATION_PROTOCOL_VERSION,
          id: requestId(requests[0] as JsonValue),
          result: { status: "not-ok" },
        });
      }
    });
    const client = await createClient(endpoint);

    const first = client.health();
    const second = client.health();
    await expect(first).rejects.toMatchObject({ code: "protocol_violation" });
    await expect(second).rejects.toMatchObject({ code: "protocol_violation" });
    expect(client.state).toBe("closed");
  });

  it("fails closed when the daemon sends a response for an unknown request ID", async () => {
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
        return;
      }
      writeFrame(socket, healthResponse("unknown-request", 1));
    });
    const client = await createClient(endpoint);

    await expect(client.health()).rejects.toMatchObject({ code: "protocol_violation" });
    await expect(client.closed).resolves.toMatchObject({ code: "protocol_violation" });
  });

  it("closes conservatively when a request times out with an unknown outcome", async () => {
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind === "bootstrap-request") {
        acceptHello(socket, value);
      }
    });
    const client = await createClient(endpoint, { requestTimeoutMs: 20 });

    await expect(client.health()).rejects.toMatchObject({ code: "request_timeout" });
    await expect(client.closed).resolves.toMatchObject({ code: "request_timeout" });
  });

  it("tracks event sequence, ignores duplicates, and closes on a gap", async () => {
    const receivedSequences: number[] = [];
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind !== "bootstrap-request") {
        return;
      }
      acceptHello(socket, value);
      setImmediate(() => {
        for (const sequence of [1, 1, 3]) {
          writeFrame(socket, accountEvent(sequence));
        }
      });
    });
    const client = await createClient(endpoint, {
      onEvent: (event) => receivedSequences.push(event.sequence),
    });

    await expect(client.closed).resolves.toMatchObject({ code: "resync_required" });
    expect(receivedSequences).toEqual([1]);
  });

  it("fails closed before dispatching an unknown or malformed account event", async () => {
    for (const event of [
      { ...record(accountEvent(1)), method: "future.event" },
      {
        ...record(accountEvent(1)),
        params: { ...record(accountStatus("pro", "836")), email: "private@example.com" },
      },
    ] satisfies JsonValue[]) {
      let handled = false;
      const endpoint = await createScriptedServer((value, socket) => {
        if (record(value).kind !== "bootstrap-request") {
          return;
        }
        acceptHello(socket, value);
        setImmediate(() => writeFrame(socket, event));
      });
      const client = await createClient(endpoint, {
        onEvent: () => {
          handled = true;
        },
      });

      await expect(client.closed).resolves.toMatchObject({ code: "protocol_violation" });
      expect(handled).toBe(false);
    }
  });

  it("fails closed when the account event stream changes or its handler throws", async () => {
    const wrongStreamEndpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind !== "bootstrap-request") {
        return;
      }
      acceptHello(socket, value);
      setImmediate(() =>
        writeFrame(socket, { ...record(accountEvent(1)), streamId: `${"B".repeat(21)}A` }),
      );
    });
    const wrongStreamClient = await createClient(wrongStreamEndpoint);
    await expect(wrongStreamClient.closed).resolves.toMatchObject({ code: "resync_required" });

    const throwingEndpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind !== "bootstrap-request") {
        return;
      }
      acceptHello(socket, value);
      setImmediate(() => writeFrame(socket, accountEvent(1)));
    });
    const throwingClient = await createClient(throwingEndpoint, {
      onEvent: () => {
        throw new Error("private desktop callback failure");
      },
    });
    const error = await throwingClient.closed;
    expect(error).toMatchObject({ code: "event_handler_failed" });
    expect(String(error)).not.toContain("private desktop callback failure");
  });

  it("rejects authentication failure without exposing the startup capability", async () => {
    const endpoint = await createPrivateEndpoint("codex-harness-client-auth-");
    const runtime = await DaemonRuntime.start({
      endpoint,
      startupCapability: STARTUP_CAPABILITY,
      serverVersion: "0.0.0",
      platform: "posix",
    });
    runtimes.push(runtime);

    let rejection: unknown;
    try {
      await createClient(endpoint, { startupCapability: OTHER_STARTUP_CAPABILITY });
    } catch (error: unknown) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(HarnessRpcClientError);
    expect(rejection).toMatchObject({
      code: "handshake_rejected",
      remoteCode: "auth.authentication_failed",
    });
    expect(JSON.stringify(rejection)).not.toContain(OTHER_STARTUP_CAPABILITY);
  });

  it("fails closed when the daemon does not answer the bootstrap handshake", async () => {
    const endpoint = await createScriptedServer(() => undefined);

    await expect(createClient(endpoint, { handshakeTimeoutMs: 20 })).rejects.toMatchObject({
      code: "handshake_timeout",
    });
  });

  it("detects a truncated final frame and does not parse it", async () => {
    const endpoint = await createScriptedServer((value, socket) => {
      if (record(value).kind !== "bootstrap-request") {
        return;
      }
      acceptHello(socket, value);
      setImmediate(() => socket.end('{"kind":'));
    });
    const client = await createClient(endpoint);

    await expect(client.closed).resolves.toMatchObject({ code: "truncated_frame" });
  });
});
