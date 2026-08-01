import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateLocalEndpoint } from "./local-endpoint.js";

const temporaryDirectories: string[] = [];

async function privateEndpoint(): Promise<{ directory: string; endpoint: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-endpoint-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return { directory, endpoint: join(directory, "harnessd.sock") };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("local daemon endpoint", () => {
  it("accepts a fresh socket path inside an owner-only directory", async () => {
    const { endpoint } = await privateEndpoint();
    await expect(validateLocalEndpoint(endpoint, "posix")).resolves.toEqual({
      kind: "unix",
      path: endpoint,
    });
  });

  it("rejects shared directories and pre-existing endpoints without deleting them", async () => {
    const shared = await privateEndpoint();
    await chmod(shared.directory, 0o755);
    await expect(validateLocalEndpoint(shared.endpoint, "posix")).rejects.toMatchObject({
      code: "private_directory_required",
    });

    const existing = await privateEndpoint();
    await writeFile(existing.endpoint, "sentinel");
    await expect(validateLocalEndpoint(existing.endpoint, "posix")).rejects.toMatchObject({
      code: "endpoint_exists",
    });
  });

  it("requires a constrained absolute POSIX path", async () => {
    await expect(validateLocalEndpoint("relative/harnessd.sock", "posix")).rejects.toMatchObject({
      code: "invalid_endpoint",
    });
    const { directory } = await privateEndpoint();
    await expect(
      validateLocalEndpoint(join(directory, "other.sock"), "posix"),
    ).rejects.toMatchObject({
      code: "invalid_endpoint",
    });
  });

  it("accepts only namespaced Windows pipe names", async () => {
    await expect(
      validateLocalEndpoint("\\\\.\\pipe\\codex-harness-AbCdEf0123456789", "win32"),
    ).resolves.toMatchObject({ kind: "pipe" });
    await expect(validateLocalEndpoint("\\\\.\\pipe\\arbitrary", "win32")).rejects.toMatchObject({
      code: "invalid_endpoint",
    });
  });
});
