import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaTarget = join(
  repositoryRoot,
  "packages/app-server-adapter/schema/codex-app-server.schema.json",
);
const manifestTarget = join(
  repositoryRoot,
  "packages/app-server-adapter/src/generated/schema-manifest.json",
);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim()}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

const codexBinary = argumentValue("--codex") ?? "codex";
const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-harness-app-server-schema-"));

try {
  const versionResult = await run(codexBinary, ["--version"]);
  const codexVersionOutput = versionResult.stdout.trim();
  const versionMatch = /^codex-cli (\S+)$/.exec(codexVersionOutput);
  if (versionMatch?.[1] === undefined) {
    throw new Error("Codex CLI returned an unsupported version string");
  }

  const generatedDirectory = join(temporaryRoot, "schemas");
  await run(codexBinary, ["app-server", "generate-json-schema", "--out", generatedDirectory]);

  const generatedSchema = await readFile(
    join(generatedDirectory, "codex_app_server_protocol.schemas.json"),
  );
  const sha256 = createHash("sha256").update(generatedSchema).digest("hex");
  const manifest = {
    codexCliVersion: versionMatch[1],
    codexVersionOutput,
    experimentalApi: false,
    generatorCommand: "codex app-server generate-json-schema",
    schemaFile: "schema/codex-app-server.schema.json",
    sha256,
  };

  await mkdir(dirname(schemaTarget), { recursive: true });
  await mkdir(dirname(manifestTarget), { recursive: true });
  await writeFile(schemaTarget, generatedSchema);
  await writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Pinned App Server schema for Codex CLI ${manifest.codexCliVersion} (${sha256})\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
