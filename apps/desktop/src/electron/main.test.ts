import { describe, expect, it, vi } from "vitest";

import { readyBootstrapState, type BootstrapStateStore } from "../shared/bootstrap-state.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000891";

const harness = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
  const bindProjectToDefaultRouting = vi.fn(async (projectId: string): Promise<unknown> => ({
    status: projectId === PROJECT_ID ? "bound" : "unavailable",
  }));
  const appEvents = new Map<string, (...arguments_: unknown[]) => unknown>();
  const webContents = {
    executeJavaScript: vi.fn(async () => true),
    focus: vi.fn(),
    insertText: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const window = {
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    once: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    webContents,
  };
  return {
    appEvents,
    bindProjectToDefaultRouting,
    ipcHandlers,
    webContents,
    window,
  };
});

vi.mock("electron", () => ({
  app: {
    enableSandbox: vi.fn(),
    exit: vi.fn(),
    getPath: vi.fn(() => "/tmp/codex-harness-main-test"),
    isPackaged: true,
    on: vi.fn((event: string, listener: (...arguments_: unknown[]) => unknown) => {
      harness.appEvents.set(event, listener);
    }),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  },
  BrowserWindow: class {
    static fromWebContents(sender: unknown): typeof harness.window | undefined {
      return sender === harness.webContents ? harness.window : undefined;
    }

    constructor() {
      return harness.window;
    }
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) => {
      harness.ipcHandlers.set(channel, handler);
    }),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  session: {
    defaultSession: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    },
  },
}));

vi.mock("../main/daemon-process-supervisor.js", () => ({
  DaemonProcessSupervisor: { start: vi.fn() },
  DaemonProcessSupervisorError: class extends Error {},
}));

vi.mock("./local-resource-protocol.js", () => ({
  LOCAL_RESOURCE_SCHEME: "harness",
  createLocalResourceHandler: vi.fn(() => vi.fn()),
}));

vi.mock("./runtime-resources.js", () => ({
  ensurePrivateDesktopRuntimeRoot: vi.fn(),
  ensurePrivateDesktopStateDatabasePath: vi.fn(),
  resolveDesktopRuntimeResources: vi.fn(),
}));

vi.mock("./security-boundary.js", () => ({
  RENDERER_DOCUMENT_URL: "harness://app/index.html",
  createSecureWindowOptions: vi.fn(() => ({})),
  isTrustedRendererSender: vi.fn(() => true),
}));

vi.mock("./application-controller.js", () => {
  return {
    DesktopApplicationController: class {
      readonly #stateStore: BootstrapStateStore;

      constructor(options: { stateStore: BootstrapStateStore }) {
        this.#stateStore = options.stateStore;
      }

      async start(): Promise<void> {
        this.#stateStore.transition(
          readyBootstrapState(
            { status: "not_required", credentialKind: null, planType: null },
            { provider: "openai", totalVisibleModels: 0, models: [], hasMore: false },
            {
              configured: true,
              profileVersion: 1,
              configurationRevisionId: "00000000-0000-4000-8000-000000000881",
              tiers: {
                fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
                standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
                deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
              },
              availability: {
                fast: "observed_available",
                standard: "observed_available",
                deep: "observed_available",
              },
            },
            {
              projects: [
                {
                  projectId: PROJECT_ID,
                  projectVersion: 1,
                  displayName: "workspace",
                  workspace: {
                    platform: "macos",
                    absolutePath: "/Users/example/workspace",
                    identityStatus: "unverified",
                  },
                },
              ],
              hasMore: false,
            },
            {
              bindings: [{ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }],
            },
          ),
        );
      }

      async bindProjectToDefaultRouting(projectId: string): Promise<unknown> {
        return await harness.bindProjectToDefaultRouting(projectId);
      }

      async setRoutingConfiguration(): Promise<Readonly<{ status: "unavailable" }>> {
        return { status: "unavailable" };
      }

      async stop(): Promise<number> {
        return 0;
      }
    },
  };
});

describe("desktop Electron main Project routing binding IPC", () => {
  it("validates ownership and Project identity, serializes writes, and contains failures", async () => {
    await import("./main.js");
    await vi.waitFor(() => {
      expect(harness.ipcHandlers.has("desktop.project.routing.bind_default")).toBe(true);
    });
    const handler = harness.ipcHandlers.get("desktop.project.routing.bind_default")!;
    const event = { sender: harness.webContents, senderFrame: {} };

    await expect(handler({ sender: {}, senderFrame: {} }, PROJECT_ID)).rejects.toThrow(
      "not authorized",
    );
    await expect(handler(event, "not-a-project-id")).rejects.toThrow("request is invalid");

    let resolveBinding!: (result: Readonly<{ status: "bound" }>) => void;
    harness.bindProjectToDefaultRouting.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveBinding = resolve;
        }),
    );
    const first = handler(event, PROJECT_ID);
    await vi.waitFor(() => {
      expect(harness.bindProjectToDefaultRouting).toHaveBeenCalledWith(PROJECT_ID);
    });
    await expect(handler(event, PROJECT_ID)).resolves.toEqual({ status: "unavailable" });
    resolveBinding({ status: "bound" });
    await expect(first).resolves.toEqual({ status: "bound" });

    harness.bindProjectToDefaultRouting.mockRejectedValueOnce(new Error("contained"));
    await expect(handler(event, PROJECT_ID)).resolves.toEqual({ status: "unavailable" });
    harness.bindProjectToDefaultRouting.mockResolvedValueOnce({ status: "unexpected" });
    await expect(handler(event, PROJECT_ID)).resolves.toEqual({ status: "unavailable" });
  });
});
