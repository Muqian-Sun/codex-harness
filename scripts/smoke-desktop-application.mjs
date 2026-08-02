import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { fakeCodexSource } from "./smoke-app-server-worker-manager.mjs";

const MAX_CAPTURE_BYTES = 64 * 1024;

export async function smokeDesktopApplication() {
  if (process.platform !== "darwin") {
    return;
  }

  const directory = await mkdtemp("/tmp/ch-el-");
  await chmod(directory, 0o700);
  const validCodex = join(directory, "valid-codex.mjs");
  const invalidCodex = join(directory, "invalid-codex.mjs");
  const requireFromDesktop = createRequire(
    new URL("../apps/desktop/package.json", import.meta.url),
  );
  const electronExecutable = requireFromDesktop("electron");
  const desktopEntry = fileURLToPath(
    new URL("../apps/desktop/dist/electron/main.js", import.meta.url),
  );

  try {
    await writeFile(validCodex, fakeCodexSource(), { encoding: "utf8", mode: 0o700 });
    await writeFile(invalidCodex, unsupportedCodexSource(), { encoding: "utf8", mode: 0o700 });
    await Promise.all([chmod(validCodex, 0o700), chmod(invalidCodex, 0o700)]);

    await runScenario({
      directory: join(directory, "ready"),
      electronExecutable,
      desktopEntry,
      codexExecutable: validCodex,
      expected: "ready",
    });
    await runScenario({
      directory: join(directory, "failed"),
      electronExecutable,
      desktopEntry,
      codexExecutable: invalidCodex,
      expected: "failed",
      expectedCode: "daemon_startup_failed",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function runScenario({
  directory,
  electronExecutable,
  desktopEntry,
  codexExecutable,
  expected,
  expectedCode,
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const child = spawn(electronExecutable, [desktopEntry], {
    env: {
      ...process.env,
      CODEX_HARNESS_CODEX_EXECUTABLE: codexExecutable,
      CODEX_HARNESS_DESKTOP_SMOKE_EXPECTED: expected,
      CODEX_HARNESS_DESKTOP_SMOKE_USER_DATA: directory,
      ELECTRON_ENABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });

  try {
    const [exitCode, signal] = await waitForExit(child, 60_000);
    if (exitCode !== 0 || signal !== null) {
      throw new Error(
        `The Electron desktop ${expected} smoke exited unexpectedly (${String(exitCode)}/${String(signal)}): ${stderr.trim()}`,
      );
    }
    const smokeLines = stdout.split("\n").filter((line) => line.startsWith("desktop-smoke:"));
    if (smokeLines.length !== 1) {
      throw new Error(`The Electron desktop ${expected} smoke output was invalid.`);
    }
    const result = JSON.parse(smokeLines[0].slice("desktop-smoke:".length));
    if (result.phase !== expected || (expectedCode !== undefined && result.code !== expectedCode)) {
      throw new Error(`The Electron desktop ${expected} rendered state was invalid.`);
    }
    const runtimeEntries = await readdir(join(directory, "runtime"));
    if (runtimeEntries.length !== 0) {
      throw new Error(`The Electron desktop ${expected} smoke left daemon runtime entries.`);
    }
    if (/Electron Security Warning/i.test(stderr)) {
      throw new Error(`The Electron desktop ${expected} smoke emitted a security warning.`);
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

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("The Electron desktop smoke did not exit in time."));
    }, timeoutMs);
    const onExit = (exitCode, signal) => {
      clearTimeout(timeout);
      resolve([exitCode, signal]);
    };
    child.once("exit", onExit);
  });
}

function appendBounded(existing, chunk) {
  const value = existing + String(chunk);
  return value.length <= MAX_CAPTURE_BYTES ? value : value.slice(-MAX_CAPTURE_BYTES);
}

function unsupportedCodexSource() {
  return `#!${process.execPath}
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("codex-cli unsupported\\n", () => process.exit(0));
} else {
  process.exit(64);
}
`;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
