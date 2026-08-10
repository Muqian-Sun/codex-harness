import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  const runtimeRoot = join(directory, "runtime");
  const stateRoot = join(directory, "state");
  const stateDatabasePath = join(stateRoot, "harness.db");
  const endpoint = join(directory, "harnessd.sock");
  const codexExecutable = join(directory, "fake-codex.mjs");
  const cliPath = fileURLToPath(new URL("../apps/harnessd/dist/cli.js", import.meta.url));
  let supervisor;

  try {
    await Promise.all([mkdir(runtimeRoot, { mode: 0o700 }), mkdir(stateRoot, { mode: 0o700 })]);
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
      runtimeRoot,
      stateDatabasePath,
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
    const catalog = await supervisor.readModelCatalogPage({ cursor: null, limit: 12 });
    if (
      catalog.provider !== "openai" ||
      catalog.totalVisibleModels !== 2 ||
      catalog.models.map((model) => model.model).join(",") !== "smoke-a,smoke-b" ||
      catalog.nextCursor !== null ||
      JSON.stringify(catalog).includes("id-smoke") ||
      JSON.stringify(catalog).includes("snapshotId") ||
      JSON.stringify(catalog).includes("workerSessionId")
    ) {
      throw new Error("The supervised daemon public model catalog response was invalid.");
    }
    const unconfiguredRouting = await supervisor.readRoutingConfiguration();
    if (
      unconfiguredRouting.configured ||
      unconfiguredRouting.profileVersion !== 0 ||
      unconfiguredRouting.configurationRevisionId !== null
    ) {
      throw new Error("The supervised daemon initial routing configuration was invalid.");
    }
    const initialProjects = await supervisor.readProjectCatalogPage({ cursor: null, limit: 12 });
    if (initialProjects.projects.length !== 0 || initialProjects.nextCursor !== null) {
      throw new Error("The supervised daemon initial Project catalog was invalid.");
    }
    const projectPath = join(directory, "workspace");
    await mkdir(projectPath, { mode: 0o700 });
    const projectId = "00000000-0000-4000-8000-000000000951";
    const projectCommandId = "00000000-0000-4000-8000-000000000952";
    const registeredProject = await supervisor.registerProject({
      commandId: projectCommandId,
      projectId,
      displayName: "workspace",
      workspace: { platform: "macos", absolutePath: projectPath },
    });
    const persistedProjects = await supervisor.readProjectCatalogPage({ cursor: null, limit: 12 });
    if (
      registeredProject.status !== "registered" ||
      registeredProject.project.projectId !== projectId ||
      registeredProject.project.workspace.identityStatus !== "unverified" ||
      persistedProjects.projects.length !== 1 ||
      persistedProjects.projects[0]?.projectId !== projectId ||
      JSON.stringify(persistedProjects).includes("createdAtMs")
    ) {
      throw new Error("The supervised daemon did not persist a valid Project.");
    }
    const initialBindings = await supervisor.readProjectRoutingBindingStatuses({
      projectIds: [projectId],
    });
    if (
      initialBindings.statuses.length !== 1 ||
      initialBindings.statuses[0]?.status !== "unbound" ||
      initialBindings.statuses[0]?.binding !== null
    ) {
      throw new Error("The supervised daemon initial Project routing binding was invalid.");
    }
    const routingRevisionId = "00000000-0000-4000-8000-000000000941";
    const savedRouting = await supervisor.setRoutingConfiguration({
      commandId: routingRevisionId,
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: {
        fast: { provider: "openai", model: "smoke-a", reasoningEffort: "low" },
        standard: { provider: "openai", model: "smoke-b", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "smoke-b", reasoningEffort: "medium" },
      },
    });
    if (
      !savedRouting.configured ||
      savedRouting.profileVersion !== 1 ||
      savedRouting.configurationRevisionId !== routingRevisionId ||
      Object.values(savedRouting.availability ?? {}).some(
        (status) => status !== "observed_available",
      )
    ) {
      throw new Error("The supervised daemon did not persist a valid routing configuration.");
    }
    const bindingCommandId = "00000000-0000-4000-8000-000000000953";
    const bound = await supervisor.bindProjectDefaultRouting({
      commandId: bindingCommandId,
      projectId,
      expectedBindingVersion: 0,
      previousProfileId: null,
      expectedProfileVersion: savedRouting.profileVersion,
      expectedConfigurationRevisionId: routingRevisionId,
    });
    if (
      bound.status !== "bound" ||
      bound.binding.projectId !== projectId ||
      bound.binding.bindingVersion !== 1 ||
      bound.binding.profileVersionAtBinding !== 1 ||
      bound.binding.configurationRevisionIdAtBinding !== routingRevisionId
    ) {
      throw new Error("The supervised daemon did not persist a valid Project routing binding.");
    }
    const updatedRoutingRevisionId = "00000000-0000-4000-8000-000000000942";
    const updatedRouting = await supervisor.setRoutingConfiguration({
      commandId: updatedRoutingRevisionId,
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: routingRevisionId,
      tiers: savedRouting.tiers,
    });
    const bindingAfterUpdate = await supervisor.readProjectRoutingBindingStatuses({
      projectIds: [projectId],
    });
    if (
      updatedRouting.profileVersion !== 2 ||
      updatedRouting.configurationRevisionId !== updatedRoutingRevisionId ||
      bindingAfterUpdate.statuses[0]?.status !== "default_bound" ||
      bindingAfterUpdate.statuses[0]?.binding?.profileVersionAtBinding !== 1
    ) {
      throw new Error("A routing update changed the Project profile binding semantics.");
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
    const firstStateIdentity = await verifyStateDatabase(stateRoot);
    await smokeSupervisorRpcLoss(
      DaemonProcessSupervisor,
      cliPath,
      codexExecutable,
      runtimeRoot,
      stateDatabasePath,
      updatedRoutingRevisionId,
      projectId,
    );
    const recoveredStateIdentity = await verifyStateDatabase(stateRoot);
    if (
      recoveredStateIdentity.device !== firstStateIdentity.device ||
      recoveredStateIdentity.inode !== firstStateIdentity.inode
    ) {
      throw new Error("The supervised daemon replaced its persistent state database on restart.");
    }
    await smokeParentWatchdog(cliPath, endpoint, codexExecutable, stateDatabasePath);
    await smokeInvalidCapability(cliPath, endpoint, codexExecutable, stateDatabasePath);
    await smokeUnsupportedCodex(cliPath, endpoint, stateDatabasePath);
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
  stateDatabasePath,
  routingRevisionId,
  projectId,
) {
  const supervisor = await DaemonProcessSupervisor.start({
    command: process.execPath,
    codexExecutable,
    args: [cliPath],
    runtimeRoot,
    stateDatabasePath,
    clientVersion: "0.0.0",
  });
  const recoveredRouting = await supervisor.readRoutingConfiguration();
  if (
    recoveredRouting.profileVersion !== 2 ||
    recoveredRouting.configurationRevisionId !== routingRevisionId ||
    recoveredRouting.tiers?.fast.model !== "smoke-a" ||
    recoveredRouting.tiers?.deep.model !== "smoke-b"
  ) {
    throw new Error("The supervised daemon did not recover its routing configuration.");
  }
  const recoveredProjects = await supervisor.readProjectCatalogPage({ cursor: null, limit: 12 });
  if (
    recoveredProjects.projects.length !== 1 ||
    recoveredProjects.projects[0]?.projectId !== projectId ||
    recoveredProjects.projects[0]?.workspace.identityStatus !== "unverified"
  ) {
    throw new Error("The supervised daemon did not recover its Project registry.");
  }
  const recoveredBindings = await supervisor.readProjectRoutingBindingStatuses({
    projectIds: [projectId],
  });
  if (
    recoveredBindings.statuses[0]?.status !== "default_bound" ||
    recoveredBindings.statuses[0]?.binding?.bindingVersion !== 1 ||
    recoveredBindings.statuses[0]?.binding?.profileVersionAtBinding !== 1
  ) {
    throw new Error("The supervised daemon did not recover its Project routing binding.");
  }
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

async function smokeInvalidCapability(cliPath, endpoint, codexExecutable, stateDatabasePath) {
  const invalidCapability = `${"A".repeat(42)}B`;
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--endpoint",
      endpoint,
      "--codex-executable",
      codexExecutable,
      "--state-database",
      stateDatabasePath,
    ],
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
      throw new Error(`The daemon exposed unsafe startup diagnostics: ${stderr.trim()}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}

async function smokeParentWatchdog(cliPath, endpoint, codexExecutable, stateDatabasePath) {
  const capability = randomBytes(32).toString("base64url");
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--endpoint",
      endpoint,
      "--codex-executable",
      codexExecutable,
      "--state-database",
      stateDatabasePath,
    ],
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
    try {
      await waitForSocket(endpoint, child);
    } catch (error) {
      throw new Error(`The daemon parent-watchdog endpoint failed: ${stderr.trim()}`, {
        cause: error,
      });
    }
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

async function smokeUnsupportedCodex(cliPath, endpoint, stateDatabasePath) {
  const capability = randomBytes(32).toString("base64url");
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--endpoint",
      endpoint,
      "--codex-executable",
      process.execPath,
      "--state-database",
      stateDatabasePath,
    ],
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

async function verifyStateDatabase(stateRoot) {
  const entries = (await readdir(stateRoot)).sort();
  if (entries.length !== 1 || entries[0] !== "harness.db") {
    throw new Error("The supervised daemon left an invalid persistent state layout.");
  }
  const metadata = await lstat(join(stateRoot, "harness.db"));
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("The supervised daemon created an insecure persistent state database.");
  }
  return { device: metadata.dev, inode: metadata.ino };
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
