import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeAppServerWorker() {
  const directory = await mkdtemp(join(tmpdir(), "ch-app-server-worker-smoke-"));
  const executable = join(directory, "fake-codex.mjs");
  let worker;
  try {
    await writeFile(executable, fakeCodexSource(), { encoding: "utf8", mode: 0o700 });
    await chmod(executable, 0o700);
    const { AppServerWorker } = await import("../apps/harnessd/dist/runtime/app-server-worker.js");
    worker = await AppServerWorker.start({
      codexExecutable: executable,
      clientIdentity: {
        name: "codex_harness_smoke",
        title: "Codex Harness Smoke",
        version: "0.0.0",
      },
      versionCheckTimeoutMs: 5_000,
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      gracefulTimeoutMs: 2_000,
      sigtermTimeoutMs: 2_000,
      sigkillTimeoutMs: 2_000,
    });
    const result = await worker.listModels({ includeHidden: true, limit: 1 });
    const account = await worker.readAccount();
    const closed = await worker.close();
    if (
      !Object.isFrozen(result) ||
      !Array.isArray(result.data) ||
      result.data[0]?.model !== "smoke-model" ||
      result.nextCursor !== null ||
      account.account?.type !== "chatgpt" ||
      account.account.planType !== "plus" ||
      "email" in account.account ||
      JSON.stringify(account).includes("private@example.com") ||
      worker.state !== "closed" ||
      closed.reason !== "requested" ||
      closed.containment !== "graceful" ||
      closed.exitCode !== 0 ||
      closed.signal !== null ||
      !closed.stderrObserved
    ) {
      throw new Error("The compiled Codex App Server worker smoke result was invalid.");
    }
  } finally {
    if (worker && worker.state !== "closed") {
      await worker.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeCodexSource() {
  return `#!${process.execPath}
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.146.0\\n", () => process.exit(0));
} else if (JSON.stringify(args) !== JSON.stringify(["app-server", "--listen", "stdio://"])) {
  process.exit(64);
} else {
  process.stderr.write("fake app-server diagnostic\\n");
  let initialized = false;
  const input = createInterface({ input: process.stdin });
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        id: message.id,
        result: {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos"
        }
      });
    } else if (message.method === "initialized") {
      initialized = true;
    } else if (message.method === "model/list" && initialized) {
      send({
        id: message.id,
        result: {
          data: [{ id: "smoke-model-id", model: "smoke-model" }],
          nextCursor: null
        }
      });
    } else if (message.method === "account/read" && initialized && message.params.refreshToken === false) {
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
    } else {
      process.exit(65);
    }
  });
}
`;
}
