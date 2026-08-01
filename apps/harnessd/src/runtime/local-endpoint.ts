import { randomBytes } from "node:crypto";
import { chmod, lstat, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, basename, dirname } from "node:path";

const MAX_UNIX_ENDPOINT_BYTES = 100;
const WINDOWS_PIPE_PATTERN = /^\\\\\.\\pipe\\codex-harness-[A-Za-z0-9_-]{16,64}$/;

export type RuntimePlatform = "posix" | "win32";

export type LocalEndpoint =
  Readonly<{ kind: "unix"; path: string }> | Readonly<{ kind: "pipe"; path: string }>;

export type UnixEndpointIdentity = Readonly<{ device: number; inode: number }>;

export type UnixEndpointClosePreparation =
  "missing" | "not_applicable" | "original" | "replacement_preserved";

export type LocalEndpointErrorCode =
  "endpoint_changed" | "endpoint_exists" | "invalid_endpoint" | "private_directory_required";

const ERROR_MESSAGES: Readonly<Record<LocalEndpointErrorCode, string>> = Object.freeze({
  endpoint_changed: "The local endpoint changed unexpectedly.",
  endpoint_exists: "The local endpoint already exists.",
  invalid_endpoint: "The local endpoint is invalid.",
  private_directory_required: "The local endpoint requires a private owner directory.",
});

export class LocalEndpointError extends Error {
  readonly code: LocalEndpointErrorCode;

  constructor(code: LocalEndpointErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "LocalEndpointError";
    this.code = code;
  }
}

export async function validateLocalEndpoint(
  input: unknown,
  platform: RuntimePlatform = process.platform === "win32" ? "win32" : "posix",
): Promise<LocalEndpoint> {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new LocalEndpointError("invalid_endpoint");
  }

  if (platform === "win32") {
    if (!WINDOWS_PIPE_PATTERN.test(input)) {
      throw new LocalEndpointError("invalid_endpoint");
    }
    return Object.freeze({ kind: "pipe", path: input });
  }

  if (
    !isAbsolute(input) ||
    basename(input) !== "harnessd.sock" ||
    Buffer.byteLength(input, "utf8") > MAX_UNIX_ENDPOINT_BYTES
  ) {
    throw new LocalEndpointError("invalid_endpoint");
  }

  let parent;
  try {
    parent = await stat(dirname(input));
  } catch {
    throw new LocalEndpointError("private_directory_required");
  }

  const getuid = process.getuid;
  if (
    !parent.isDirectory() ||
    getuid === undefined ||
    parent.uid !== getuid() ||
    (parent.mode & 0o077) !== 0
  ) {
    throw new LocalEndpointError("private_directory_required");
  }

  try {
    await lstat(input);
    throw new LocalEndpointError("endpoint_exists");
  } catch (error: unknown) {
    if (error instanceof LocalEndpointError) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new LocalEndpointError("invalid_endpoint");
    }
  }

  return Object.freeze({ kind: "unix", path: input });
}

export async function secureCreatedUnixEndpoint(
  endpoint: LocalEndpoint,
): Promise<UnixEndpointIdentity | undefined> {
  if (endpoint.kind !== "unix") {
    return undefined;
  }
  try {
    const metadata = await lstat(endpoint.path);
    if (!metadata.isSocket()) {
      throw new LocalEndpointError("endpoint_changed");
    }
    await chmod(endpoint.path, 0o600);
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } catch (error: unknown) {
    if (error instanceof LocalEndpointError) {
      throw error;
    }
    throw new LocalEndpointError("endpoint_changed");
  }
}

export async function prepareUnixEndpointForClose(
  endpoint: LocalEndpoint,
  expectedIdentity: UnixEndpointIdentity | undefined,
): Promise<UnixEndpointClosePreparation> {
  if (endpoint.kind !== "unix") {
    return "not_applicable";
  }
  try {
    const metadata = await lstat(endpoint.path);
    if (
      metadata.isSocket() &&
      expectedIdentity !== undefined &&
      metadata.dev === expectedIdentity.device &&
      metadata.ino === expectedIdentity.inode
    ) {
      return "original";
    }
    const preservedPath = `${endpoint.path}.preserved-${randomBytes(8).toString("hex")}`;
    await rename(endpoint.path, preservedPath);
    return "replacement_preserved";
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }
    throw new LocalEndpointError("endpoint_changed");
  }
}

export async function removeCreatedUnixEndpoint(
  endpoint: LocalEndpoint,
): Promise<"missing" | "not_applicable" | "removed" | "unsafe_to_remove"> {
  if (endpoint.kind !== "unix") {
    return "not_applicable";
  }
  try {
    const metadata = await lstat(endpoint.path);
    if (!metadata.isSocket()) {
      return "unsafe_to_remove";
    }
    await unlink(endpoint.path);
    return "removed";
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }
    return "unsafe_to_remove";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
