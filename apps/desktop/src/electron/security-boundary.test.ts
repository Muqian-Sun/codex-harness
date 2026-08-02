import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RENDERER_DOCUMENT_URL,
  createSecureWindowOptions,
  isTrustedRendererSender,
} from "./security-boundary.js";

describe("desktop security boundary", () => {
  it("creates an explicitly isolated and sandboxed window", () => {
    const preload = resolve("/tmp", "preload.cjs");
    const options = createSecureWindowOptions(preload);

    expect(options.webPreferences).toMatchObject({
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    });
  });

  it("accepts only the managed main frame at the exact local document URL", () => {
    const mainFrame = { url: RENDERER_DOCUMENT_URL };
    const contents = { mainFrame };

    expect(isTrustedRendererSender(mainFrame as never, contents as never)).toBe(true);
    expect(
      isTrustedRendererSender({ url: "app://harness/other.html" } as never, contents as never),
    ).toBe(false);
    expect(isTrustedRendererSender(null, contents as never)).toBe(false);
  });
});
