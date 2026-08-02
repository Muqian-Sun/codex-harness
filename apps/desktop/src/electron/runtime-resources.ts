import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type DesktopRuntimeResources = Readonly<{
  command: string;
  daemonEntry: string;
  codexExecutable: string;
}>;

export type DesktopRuntimeResourceConfig = Readonly<{
  isPackaged: boolean;
  resourcesPath: string;
  electronExecutable: string;
  developmentDaemonEntry: string;
  developmentCodexExecutable?: string;
}>;

export class DesktopRuntimeResourceError extends Error {
  readonly code: "resource_configuration_missing" | "resource_invalid";

  constructor(code: "resource_configuration_missing" | "resource_invalid") {
    super(
      code === "resource_configuration_missing"
        ? "The desktop runtime resource configuration is missing."
        : "A desktop runtime resource is invalid.",
    );
    this.name = "DesktopRuntimeResourceError";
    this.code = code;
  }
}

export class DesktopRuntimeRootError extends Error {
  readonly code = "runtime_root_insecure";

  constructor() {
    super("The desktop runtime root is insecure.");
    this.name = "DesktopRuntimeRootError";
  }
}

export async function resolveDesktopRuntimeResources(
  config: DesktopRuntimeResourceConfig,
): Promise<DesktopRuntimeResources> {
  if (
    !validAbsolutePath(config.resourcesPath) ||
    !validAbsolutePath(config.electronExecutable) ||
    !validAbsolutePath(config.developmentDaemonEntry)
  ) {
    throw new DesktopRuntimeResourceError("resource_invalid");
  }

  const daemonEntry = config.isPackaged
    ? join(config.resourcesPath, "harnessd", "cli.js")
    : config.developmentDaemonEntry;
  const codexExecutable = config.isPackaged
    ? join(config.resourcesPath, "codex", "codex")
    : config.developmentCodexExecutable;
  if (codexExecutable === undefined || codexExecutable.length === 0) {
    throw new DesktopRuntimeResourceError("resource_configuration_missing");
  }
  if (!validAbsolutePath(codexExecutable)) {
    throw new DesktopRuntimeResourceError("resource_invalid");
  }

  await Promise.all([
    validateRegularFile(config.electronExecutable, fsConstants.X_OK),
    validateRegularFile(daemonEntry, fsConstants.R_OK),
    validateRegularFile(codexExecutable, fsConstants.X_OK),
  ]);
  return Object.freeze({
    command: config.electronExecutable,
    daemonEntry,
    codexExecutable,
  });
}

export async function ensurePrivateDesktopRuntimeRoot(userDataPath: string): Promise<string> {
  return await ensurePrivateDesktopDirectory(userDataPath, "runtime");
}

export async function ensurePrivateDesktopStateDatabasePath(userDataPath: string): Promise<string> {
  return join(await ensurePrivateDesktopDirectory(userDataPath, "state"), "harness.db");
}

async function ensurePrivateDesktopDirectory(
  userDataPath: string,
  directoryName: "runtime" | "state",
): Promise<string> {
  if (!validAbsolutePath(userDataPath)) {
    throw new DesktopRuntimeRootError();
  }
  const runtimeRoot = join(userDataPath, directoryName);
  try {
    await mkdir(runtimeRoot, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new DesktopRuntimeRootError();
    }
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      runtimeRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    const getuid = process.getuid;
    if (!before.isDirectory() || getuid === undefined || before.uid !== getuid()) {
      throw new DesktopRuntimeRootError();
    }
    await handle.chmod(0o700);
    const after = await handle.stat();
    const pathMetadata = await lstat(runtimeRoot);
    if (
      !after.isDirectory() ||
      after.uid !== getuid() ||
      (after.mode & 0o777) !== 0o700 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !pathMetadata.isDirectory() ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.dev !== after.dev ||
      pathMetadata.ino !== after.ino
    ) {
      throw new DesktopRuntimeRootError();
    }
  } catch (error: unknown) {
    await closeRuntimeRootHandle(handle);
    if (error instanceof DesktopRuntimeRootError) {
      throw error;
    }
    throw new DesktopRuntimeRootError();
  }
  await closeRuntimeRootHandle(handle);
  return runtimeRoot;
}

async function validateRegularFile(path: string, mode: number): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new DesktopRuntimeResourceError("resource_invalid");
    }
    await access(path, mode);
  } catch (error: unknown) {
    if (error instanceof DesktopRuntimeResourceError) {
      throw error;
    }
    throw new DesktopRuntimeResourceError("resource_invalid");
  }
}

async function closeRuntimeRootHandle(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    throw new DesktopRuntimeRootError();
  }
}

function validAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
