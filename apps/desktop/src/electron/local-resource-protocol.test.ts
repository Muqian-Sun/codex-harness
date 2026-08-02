import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RENDERER_CONTENT_SECURITY_POLICY,
  createLocalResourceHandler,
  resolveLocalRendererPath,
} from "./local-resource-protocol.js";

const temporaryDirectories: string[] = [];

async function rendererRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-renderer-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("local renderer resource protocol", () => {
  it("resolves only fixed-origin GET resources beneath the renderer root", async () => {
    const root = await rendererRoot();

    expect(resolveLocalRendererPath(root, "app://harness/index.html", "GET")).toBe(
      join(root, "index.html"),
    );
    expect(resolveLocalRendererPath(root, "app://other/index.html", "GET")).toBe(undefined);
    expect(resolveLocalRendererPath(root, "app://harness/index.html", "POST")).toBe(undefined);
    expect(resolveLocalRendererPath(root, "app://harness/index.html?debug=1", "GET")).toBe(
      undefined,
    );
    expect(resolveLocalRendererPath(root, "app://harness/%2e%2e/secret.txt", "GET")).toBe(
      undefined,
    );
  });

  it("serves regular files with a strict CSP and rejects symbolic links", async () => {
    const root = await rendererRoot();
    const externalRoot = await rendererRoot();
    const index = join(root, "index.html");
    const outside = join(root, "outside.html");
    const linked = join(root, "linked.html");
    const externalAsset = join(externalRoot, "outside.js");
    const linkedDirectory = join(root, "assets");
    await writeFile(index, "<html></html>");
    await writeFile(outside, "outside");
    await symlink(outside, linked);
    await mkdir(externalRoot, { recursive: true });
    await writeFile(externalAsset, "export {};\n");
    await symlink(externalRoot, linkedDirectory);
    const fetchFile = vi.fn(async () => new Response("<html></html>", { status: 200 }));
    const handler = createLocalResourceHandler(root, fetchFile);

    const response = await handler(new Request("app://harness/index.html"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
    expect(fetchFile).toHaveBeenCalledOnce();

    const rejected = await handler(new Request("app://harness/linked.html"));
    expect(rejected.status).toBe(404);
    expect(fetchFile).toHaveBeenCalledOnce();

    const escaped = await handler(new Request("app://harness/assets/outside.js"));
    expect(escaped.status).toBe(404);
    expect(fetchFile).toHaveBeenCalledOnce();
  });
});
