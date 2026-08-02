const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const GET_BOOTSTRAP_STATE_CHANNEL = "desktop.bootstrap.get";
const BOOTSTRAP_STATE_CHANGED_CHANNEL = "desktop.bootstrap.changed";
const FAILURE_CODES = new Set([
  "unsupported_platform",
  "resource_configuration_missing",
  "resource_invalid",
  "runtime_root_insecure",
  "daemon_startup_failed",
  "daemon_unavailable",
  "internal_error",
]);

type PreloadBootstrapState =
  | Readonly<{ phase: "starting" | "ready" | "stopping" }>
  | Readonly<{ phase: "failed"; code: string }>;

function decodeBootstrapState(input: unknown): PreloadBootstrapState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("The desktop bootstrap state is invalid.");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    record.phase === "failed" &&
    keys.length === 2 &&
    keys.includes("phase") &&
    keys.includes("code") &&
    typeof record.code === "string" &&
    FAILURE_CODES.has(record.code)
  ) {
    return Object.freeze({ phase: "failed", code: record.code });
  }
  if (
    keys.length === 1 &&
    keys[0] === "phase" &&
    (record.phase === "starting" || record.phase === "ready" || record.phase === "stopping")
  ) {
    return Object.freeze({ phase: record.phase });
  }
  throw new Error("The desktop bootstrap state is invalid.");
}

const desktopApi = Object.freeze({
  async getBootstrapState(): Promise<PreloadBootstrapState> {
    return decodeBootstrapState(await ipcRenderer.invoke(GET_BOOTSTRAP_STATE_CHANNEL));
  },
  onBootstrapState(listener: (state: PreloadBootstrapState) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("A desktop bootstrap listener is required.");
    }
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(decodeBootstrapState(value));
      } catch {
        listener(Object.freeze({ phase: "failed", code: "internal_error" }));
      }
    };
    ipcRenderer.on(BOOTSTRAP_STATE_CHANGED_CHANNEL, handler);
    return (): void => {
      ipcRenderer.removeListener(BOOTSTRAP_STATE_CHANGED_CHANNEL, handler);
    };
  },
});

contextBridge.exposeInMainWorld("codexHarness", desktopApi);
