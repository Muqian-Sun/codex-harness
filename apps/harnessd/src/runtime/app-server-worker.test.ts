import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppServerWorker,
  AppServerWorkerError,
  type AppServerWorkerConfig,
} from "./app-server-worker.js";

type FakeBehavior = Readonly<{
  versionOutput?: string;
  versionExitCode?: number;
  versionHang?: boolean;
  versionOversize?: boolean;
  deleteAfterVersion?: boolean;
  appMode?:
    | "duplicate_response"
    | "early_exit"
    | "event"
    | "happy"
    | "init_timeout"
    | "invalid_result"
    | "invalid_utf8"
    | "malformed_json"
    | "oversize_frame"
    | "request_error"
    | "request_timeout"
    | "server_request"
    | "stdout_end"
    | "truncated_frame"
    | "unknown_response";
  closeMode?: "graceful" | "sigkill" | "sigterm";
  lineEnding?: "lf" | "crlf";
  stderrText?: string;
}>;

type FakeCodex = Readonly<{ directory: string; executable: string; logPath: string }>;

const workers: AppServerWorker[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    workers.splice(0).map(async (worker) => {
      try {
        await worker.close();
      } catch {
        // A failure-path test may already have closed the worker.
      }
    }),
  );
  await Promise.all(
    directories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
  );
});

function workerConfig(
  executable: string,
  overrides: Partial<AppServerWorkerConfig> = {},
): AppServerWorkerConfig {
  return {
    codexExecutable: executable,
    clientIdentity: { name: "codex_harness", title: "Codex Harness", version: "0.0.0" },
    versionCheckTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    gracefulTimeoutMs: 200,
    sigtermTimeoutMs: 200,
    sigkillTimeoutMs: 200,
    ...overrides,
  };
}

async function startFakeWorker(
  behavior: FakeBehavior = {},
  overrides: Partial<AppServerWorkerConfig> = {},
): Promise<Readonly<{ fake: FakeCodex; worker: AppServerWorker }>> {
  const fake = await createFakeCodex(behavior);
  const worker = await AppServerWorker.start(workerConfig(fake.executable, overrides));
  workers.push(worker);
  return { fake, worker };
}

async function createFakeCodex(behavior: FakeBehavior = {}): Promise<FakeCodex> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-app-server-worker-"));
  directories.push(directory);
  const executable = join(directory, "fake-codex.mjs");
  const logPath = join(directory, "wire.log");
  const source = fakeCodexSource(behavior, logPath);
  await writeFile(executable, source, { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  return Object.freeze({ directory, executable, logPath });
}

function fakeCodexSource(behavior: FakeBehavior, logPath: string): string {
  return `#!${process.execPath}
import { appendFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const behavior = ${JSON.stringify({ appMode: "happy", closeMode: "graceful", lineEnding: "lf", ...behavior })};
const logPath = ${JSON.stringify(logPath)};
const log = (value) => appendFileSync(logPath, JSON.stringify(value) + "\\n", "utf8");
const args = process.argv.slice(2);
log({ type: "argv", args });

if (args.length === 1 && args[0] === "--version") {
  if (behavior.versionHang) {
    setInterval(() => undefined, 1000);
  } else {
    const output = behavior.versionOversize
      ? "v".repeat(5000)
      : (behavior.versionOutput ?? "codex-cli 0.146.0-alpha.9.2\\n");
    process.stdout.write(output, () => {
      if (behavior.deleteAfterVersion) {
        unlinkSync(fileURLToPath(import.meta.url));
      }
      process.exit(behavior.versionExitCode ?? 0);
    });
  }
} else if (JSON.stringify(args) !== JSON.stringify(["app-server", "--listen", "stdio://", "--strict-config"])) {
  process.exit(64);
} else {
  if (behavior.stderrText) {
    process.stderr.write(behavior.stderrText);
  }
  const ending = behavior.lineEnding === "crlf" ? "\\r\\n" : "\\n";
  const send = (value) => process.stdout.write(JSON.stringify(value) + ending);
  const keepAlive = () => setInterval(() => undefined, 1000);
  let initialized = false;

  if (behavior.closeMode === "sigterm") {
    process.on("SIGTERM", () => process.exit(0));
    process.stdin.on("end", keepAlive);
  } else if (behavior.closeMode === "sigkill") {
    process.on("SIGTERM", () => undefined);
    process.stdin.on("end", keepAlive);
  }

  if (behavior.appMode === "early_exit") {
    process.exit(7);
  }
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    log({ type: "input", message });
    if (message.method === "initialize") {
      if (behavior.appMode === "init_timeout") return;
      if (behavior.appMode === "malformed_json") {
        process.stdout.write("not-json\\n");
        return;
      }
      if (behavior.appMode === "invalid_utf8") {
        process.stdout.write(Buffer.from([0xff, 0x0a]));
        return;
      }
      if (behavior.appMode === "oversize_frame") {
        process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
        return;
      }
      if (behavior.appMode === "truncated_frame") {
        process.stdout.write('{"id":');
        process.exit(0);
      }
      send({
        id: message.id,
        result: {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos"
        }
      });
      return;
    }
    if (message.method === "initialized") {
      initialized = true;
      if (behavior.appMode === "server_request") {
        send({ id: 700, method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "u" } });
      } else if (behavior.appMode === "event") {
        send({ method: "warning", params: { message: "internal warning" } });
      } else if (behavior.appMode === "unknown_response") {
        send({ id: "unknown-id", result: {} });
      } else if (behavior.appMode === "stdout_end") {
        process.stdout.end();
        keepAlive();
      }
      return;
    }
    if (!initialized) {
      process.exit(65);
    }
    if (behavior.appMode === "request_timeout") return;
    if (behavior.appMode === "request_error") {
      send({ id: message.id, error: { code: 401, message: "TOP-SECRET-SERVER-MESSAGE" } });
      return;
    }
    if (message.method === "account/read") {
      if (behavior.appMode === "invalid_result") {
        send({ id: message.id, result: { account: { type: "future" }, requiresOpenaiAuth: true } });
        return;
      }
      send({
        id: message.id,
        result: {
          account: {
            type: "chatgpt",
            email: "private@example.com",
            planType: "plus",
            accessToken: "must-not-survive"
          },
          requiresOpenaiAuth: true,
          futureSecret: "must-not-survive"
        }
      });
      return;
    }
    if (message.method !== "model/list") {
      process.exit(65);
    }
    if (behavior.appMode === "invalid_result") {
      send({ id: message.id, result: { data: "invalid", nextCursor: null } });
      return;
    }
    const cursor = message.params?.cursor ?? null;
    const response = { id: message.id, result: { data: [{ id: "id-" + (cursor ?? "root"), model: "model-" + (cursor ?? "root") }], nextCursor: null } };
    const delay = cursor === "slow" ? 30 : cursor === "fast" ? 1 : 0;
    setTimeout(() => {
      send(response);
      if (behavior.appMode === "duplicate_response") send(response);
    }, delay);
  });
}
`;
}

async function readWireLog(fake: FakeCodex): Promise<readonly unknown[]> {
  let content: string;
  try {
    content = await readFile(fake.logPath, "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe("Codex App Server worker", () => {
  it("verifies the pinned CLI, performs the handshake, lists models, and closes on EOF", async () => {
    const { fake, worker } = await startFakeWorker({ lineEnding: "crlf" });
    const result = await worker.listModels({ includeHidden: true });
    const account = await worker.readAccount();

    expect(worker.state).toBe("ready");
    expect(worker.supportedCodexCliVersion).toBe("0.146.0-alpha.9.2");
    expect(result).toEqual({
      data: [{ id: "id-root", model: "model-root" }],
      nextCursor: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(account).toEqual({
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    expect(JSON.stringify(account)).not.toContain("private@example.com");
    expect(JSON.stringify(account)).not.toContain("must-not-survive");
    expect(Object.isFrozen(account)).toBe(true);
    const log = await readWireLog(fake);
    expect(log).toEqual(
      expect.arrayContaining([
        { type: "argv", args: ["--version"] },
        {
          type: "argv",
          args: ["app-server", "--listen", "stdio://", "--strict-config"],
        },
      ]),
    );
    const inputs = log
      .filter((entry): entry is { type: string; message: { method: string } } =>
        Boolean(entry && typeof entry === "object" && "message" in entry),
      )
      .map((entry) => entry.message.method);
    expect(inputs.slice(0, 4)).toEqual(["initialize", "initialized", "model/list", "account/read"]);

    const closed = await worker.close();
    expect(closed).toMatchObject({
      reason: "requested",
      containment: "graceful",
      exitCode: 0,
      stderrObserved: false,
    });
    expect(worker.state).toBe("closed");
    await expect(worker.close()).resolves.toEqual(closed);
  });

  it("correlates concurrent model requests even when responses arrive out of order", async () => {
    const { worker } = await startFakeWorker();
    const slow = worker.listModels({ cursor: "slow", limit: 1, includeHidden: true });
    const fast = worker.listModels({ cursor: "fast", limit: 1, includeHidden: true });

    await expect(fast).resolves.toMatchObject({ data: [{ model: "model-fast" }] });
    await expect(slow).resolves.toMatchObject({ data: [{ model: "model-slow" }] });
  });

  it("rejects unsupported, failing, hanging, and oversized version checks before app-server spawn", async () => {
    const cases: readonly [FakeBehavior, string][] = [
      [{ versionOutput: "codex-cli 0.0.0\n" }, "unsupported_version"],
      [{ versionExitCode: 2 }, "version_check_failed"],
      [{ versionHang: true }, "version_check_failed"],
      [{ versionOversize: true }, "version_check_failed"],
    ];
    for (const [behavior, code] of cases) {
      const fake = await createFakeCodex(behavior);
      await expect(
        AppServerWorker.start(
          workerConfig(fake.executable, {
            versionCheckTimeoutMs: behavior.versionHang === true ? 100 : 10_000,
          }),
        ),
      ).rejects.toMatchObject({ code });
      const log = await readWireLog(fake);
      expect(log).not.toContainEqual({
        type: "argv",
        args: ["app-server", "--listen", "stdio://", "--strict-config"],
      });
      expect(log.every((entry) => JSON.stringify(entry).includes("--version"))).toBe(true);
    }
  });

  it("strictly rejects invalid configuration without leaking local paths", async () => {
    const fake = await createFakeCodex();
    await chmod(fake.executable, 0o600);
    const invalid = [
      workerConfig("relative-codex"),
      workerConfig(fake.executable, { startupTimeoutMs: 0 }),
      workerConfig(fake.executable, {
        clientIdentity: { name: "", title: "Codex Harness", version: "0.0.0" },
      }),
    ];
    for (const config of invalid) {
      await expect(AppServerWorker.start(config)).rejects.toEqual(
        expect.objectContaining({ code: "invalid_configuration" }),
      );
    }
    await expect(AppServerWorker.start(workerConfig(fake.executable))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppServerWorkerError &&
        error.code === "invalid_configuration" &&
        !error.message.includes(fake.executable),
    );
  });

  it("reports spawn failure and conservative initialization failures", async () => {
    const removed = await createFakeCodex({ deleteAfterVersion: true });
    await expect(AppServerWorker.start(workerConfig(removed.executable))).rejects.toMatchObject({
      code: "spawn_failed",
    });

    const timeout = await createFakeCodex({ appMode: "init_timeout" });
    await expect(
      AppServerWorker.start(workerConfig(timeout.executable, { startupTimeoutMs: 50 })),
    ).rejects.toMatchObject({ code: "startup_timeout" });

    const exited = await createFakeCodex({ appMode: "early_exit" });
    await expect(AppServerWorker.start(workerConfig(exited.executable))).rejects.toMatchObject({
      code: "worker_exited",
    });
  });

  it("fails closed on malformed, invalid UTF-8, oversized, and truncated frames", async () => {
    for (const appMode of [
      "malformed_json",
      "invalid_utf8",
      "oversize_frame",
      "truncated_frame",
    ] as const) {
      const fake = await createFakeCodex({ appMode });
      await expect(AppServerWorker.start(workerConfig(fake.executable))).rejects.toMatchObject({
        code: "protocol_failure",
      });
    }
  });

  it("keeps server failures safe and closes on malformed or duplicate responses", async () => {
    const secret = await startFakeWorker({ appMode: "request_error", stderrText: "STDERR-SECRET" });
    await expect(secret.worker.listModels({ includeHidden: true })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppServerWorkerError &&
        error.code === "request_failed" &&
        !error.message.includes("TOP-SECRET") &&
        !error.message.includes("STDERR-SECRET"),
    );
    expect(secret.worker.state).toBe("ready");
    expect(secret.worker.stderrObserved).toBe(true);

    const invalid = await startFakeWorker({ appMode: "invalid_result" });
    await expect(invalid.worker.listModels({})).rejects.toMatchObject({ code: "protocol_failure" });
    await expect(invalid.worker.closed).resolves.toMatchObject({ reason: "protocol_failure" });

    const invalidAccount = await startFakeWorker({ appMode: "invalid_result" });
    await expect(invalidAccount.worker.readAccount()).rejects.toMatchObject({
      code: "protocol_failure",
    });
    await expect(invalidAccount.worker.closed).resolves.toMatchObject({
      reason: "protocol_failure",
    });

    const duplicate = await startFakeWorker({ appMode: "duplicate_response" });
    await expect(duplicate.worker.listModels({})).resolves.toMatchObject({
      data: [{ model: "model-root" }],
    });
    await expect(duplicate.worker.closed).resolves.toMatchObject({ reason: "protocol_failure" });
  });

  it("closes the worker on request timeout and never replays the request", async () => {
    const { fake, worker } = await startFakeWorker(
      { appMode: "request_timeout" },
      { requestTimeoutMs: 50 },
    );
    await expect(worker.listModels({ includeHidden: true })).rejects.toMatchObject({
      code: "request_timeout",
    });
    await expect(worker.closed).resolves.toMatchObject({ reason: "request_timeout" });
    const log = await readWireLog(fake);
    const modelRequests = log.filter(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        "message" in entry &&
        (entry as { message?: { method?: string } }).message?.method === "model/list",
    );
    expect(modelRequests).toHaveLength(1);
  });

  it("fails closed on every server-initiated request without sending an approval", async () => {
    const { fake, worker } = await startFakeWorker({ appMode: "server_request" });
    await expect(worker.closed).resolves.toMatchObject({ reason: "unsupported_server_request" });
    const log = await readWireLog(fake);
    const inputs = log.filter(
      (entry) => entry !== null && typeof entry === "object" && "message" in entry,
    );
    expect(inputs).toHaveLength(2);
  });

  it("closes on a clean stdout EOF and on an unknown response", async () => {
    const ended = await startFakeWorker({ appMode: "stdout_end" });
    await expect(ended.worker.closed).resolves.toMatchObject({ reason: "worker_exited" });

    const unknown = await startFakeWorker({ appMode: "unknown_response" });
    await expect(unknown.worker.closed).resolves.toMatchObject({ reason: "protocol_failure" });
  });

  it("forwards internal notifications and treats event-handler failure as fatal", async () => {
    const events: unknown[] = [];
    const observed = await startFakeWorker(
      { appMode: "event" },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toMatchObject([{ type: "notification", method: "warning" }]);
    expect(observed.worker.state).toBe("ready");

    const failing = await startFakeWorker(
      { appMode: "event" },
      {
        onEvent: async () => {
          await Promise.resolve();
          throw new Error("consumer failed");
        },
      },
    );
    await expect(failing.worker.closed).resolves.toMatchObject({
      reason: "event_handler_failure",
    });
  });

  it("escalates an uncooperative worker from SIGTERM to SIGKILL", async () => {
    const sigterm = await startFakeWorker(
      { closeMode: "sigterm" },
      { gracefulTimeoutMs: 30, sigtermTimeoutMs: 200 },
    );
    await expect(sigterm.worker.close()).resolves.toMatchObject({ containment: "sigterm" });

    const sigkill = await startFakeWorker(
      { closeMode: "sigkill" },
      { gracefulTimeoutMs: 30, sigtermTimeoutMs: 30, sigkillTimeoutMs: 200 },
    );
    await expect(sigkill.worker.close()).resolves.toMatchObject({ containment: "sigkill" });
  });
});
