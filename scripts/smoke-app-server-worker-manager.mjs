import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeAppServerWorkerManager() {
  const directory = await mkdtemp(join(tmpdir(), "ch-worker-manager-smoke-"));
  const executable = join(directory, "fake-codex.mjs");
  let manager;
  try {
    await writeFile(executable, fakeCodexSource(), { encoding: "utf8", mode: 0o700 });
    await chmod(executable, 0o700);
    const { AppServerWorkerManager } =
      await import("../apps/harnessd/dist/runtime/app-server-worker-manager.js");
    manager = await AppServerWorkerManager.start({
      provider: "openai",
      worker: {
        codexExecutable: executable,
        clientIdentity: {
          name: "codex_harness_manager_smoke",
          title: "Codex Harness Manager Smoke",
          version: "0.0.0",
        },
        versionCheckTimeoutMs: 5_000,
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 5_000,
        gracefulTimeoutMs: 2_000,
        sigtermTimeoutMs: 2_000,
        sigkillTimeoutMs: 2_000,
      },
    });

    const first = manager.catalog;
    const account = manager.accountStatus;
    if (
      first === null ||
      account === null ||
      !manager.isCatalogCurrent(first) ||
      !manager.isAccountStatusCurrent(account) ||
      account.status !== "authenticated" ||
      account.credentialKind !== "chatgpt" ||
      account.planType !== "pro" ||
      JSON.stringify(account).includes("private@example.com") ||
      first.models.map((model) => model.model).join(",") !== "smoke-a,smoke-b"
    ) {
      throw new Error("The compiled worker manager initial snapshots were invalid.");
    }
    const refreshed = await manager.refreshCatalog();
    if (
      manager.state !== "ready" ||
      manager.catalog !== refreshed ||
      manager.isCatalogCurrent(first) ||
      !manager.isCatalogCurrent(refreshed) ||
      manager.accountStatus !== account ||
      !manager.isAccountStatusCurrent(account) ||
      refreshed.workerSessionId !== first.workerSessionId ||
      refreshed.snapshotId === first.snapshotId
    ) {
      throw new Error("The compiled worker manager freshness result was invalid.");
    }
    const publishedAccounts = [];
    const unsubscribeAccountStatus = manager.subscribeAccountStatusChanges((snapshot) => {
      publishedAccounts.push(snapshot);
    });
    const refreshedAccount = await manager.refreshAccountStatus();
    if (
      manager.state !== "ready" ||
      manager.accountStatus !== refreshedAccount ||
      manager.isAccountStatusCurrent(account) ||
      !manager.isAccountStatusCurrent(refreshedAccount) ||
      manager.catalog !== refreshed ||
      !manager.isCatalogCurrent(refreshed) ||
      refreshedAccount.workerSessionId !== account.workerSessionId ||
      refreshedAccount.snapshotId === account.snapshotId
    ) {
      throw new Error("The compiled worker manager account freshness result was invalid.");
    }
    if (publishedAccounts.length !== 1 || publishedAccounts[0] !== refreshedAccount) {
      throw new Error("The compiled worker manager account event was invalid.");
    }
    unsubscribeAccountStatus();

    const closed = await manager.close();
    if (
      manager.state !== "closed" ||
      manager.catalog !== null ||
      manager.accountStatus !== null ||
      closed.reason !== "requested" ||
      closed.containment !== "graceful" ||
      closed.exitCode !== 0 ||
      closed.signal !== null ||
      !closed.stderrObserved
    ) {
      throw new Error("The compiled worker manager close result was invalid.");
    }
  } finally {
    if (manager && manager.state !== "closed") {
      await manager.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export function fakeCodexSource() {
  return `#!${process.execPath}
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.146.0-alpha.9.2\\n", () => process.exit(0));
} else if (JSON.stringify(args) !== JSON.stringify(["app-server", "--listen", "stdio://", "--strict-config"])) {
  process.exit(64);
} else {
  process.stderr.write("fake manager app-server diagnostic\\n");
  let initialized = false;
  const input = createInterface({ input: process.stdin });
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  const model = (name, effort) => ({
    id: "id-" + name,
    model: name,
    hidden: false,
    defaultReasoningEffort: effort,
    supportedReasoningEfforts: [{ reasoningEffort: effort }],
    inputModalities: ["text"]
  });
  let clientName = "";
  let accountReadCount = 0;
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      clientName = message.params.clientInfo.name;
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
      const cursor = message.params.cursor;
      send({
        id: message.id,
        result: cursor === null
          ? { data: [model("smoke-b", "medium")], nextCursor: "page-2" }
          : cursor === "page-2"
            ? { data: [model("smoke-a", "low")], nextCursor: null }
            : { data: [], nextCursor: null }
      });
    } else if (message.method === "account/read" && initialized && message.params.refreshToken === false) {
      accountReadCount += 1;
      if (accountReadCount === 1) {
        send({
          method: "account/updated",
          params: {
            authMode: "chatgpt",
            planType: "pro",
            accessToken: "must-not-survive"
          }
        });
      }
      send({
        id: message.id,
        result: {
          account: {
            type: "chatgpt",
            email: "private@example.com",
            planType: accountReadCount === 1 ? "plus" : "pro",
            accessToken: "must-not-survive"
          },
          requiresOpenaiAuth: true,
          futureSecret: "must-not-survive"
        }
      });
      if (accountReadCount === 2 && clientName === "codex_harness_daemon") {
        setInterval(() => {
          send({
            method: "account/updated",
            params: { authMode: "chatgpt", planType: "pro" }
          });
        }, 1000).unref();
      }
    } else {
      process.exit(65);
    }
  });
}
`;
}
