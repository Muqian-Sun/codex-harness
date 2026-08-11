import { isAbsolute } from "node:path";

import type { BrowserWindowConstructorOptions, WebContents, WebFrameMain } from "electron";

export const RENDERER_DOCUMENT_URL = "app://harness/index.html";

export function createSecureWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  if (!isAbsolute(preloadPath) || preloadPath.includes("\0")) {
    throw new Error("The preload path is invalid.");
  }
  return {
    width: 1_160,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: "Codex Harness",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f7f5ef",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    },
  };
}

export function isTrustedRendererSender(
  senderFrame: WebFrameMain | null,
  contents: Pick<WebContents, "mainFrame">,
): boolean {
  return (
    senderFrame !== null &&
    senderFrame === contents.mainFrame &&
    senderFrame.url === RENDERER_DOCUMENT_URL
  );
}
