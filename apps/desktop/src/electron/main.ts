import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from "electron";

import {
  DaemonProcessSupervisor,
  DaemonProcessSupervisorError,
} from "../main/daemon-process-supervisor.js";
import { desktopBootstrapMetadata } from "../main/index.js";
import {
  BootstrapStateStore,
  DESKTOP_ACCOUNT_PLAN_TYPES,
  failedBootstrapState,
  type DesktopBootstrapState,
} from "../shared/bootstrap-state.js";
import { DesktopApplicationController } from "./application-controller.js";
import { LOCAL_RESOURCE_SCHEME, createLocalResourceHandler } from "./local-resource-protocol.js";
import {
  ensurePrivateDesktopRuntimeRoot,
  resolveDesktopRuntimeResources,
} from "./runtime-resources.js";
import {
  RENDERER_DOCUMENT_URL,
  createSecureWindowOptions,
  isTrustedRendererSender,
} from "./security-boundary.js";

const GET_BOOTSTRAP_STATE_CHANNEL = "desktop.bootstrap.get";
const BOOTSTRAP_STATE_CHANGED_CHANNEL = "desktop.bootstrap.changed";
const DEVELOPMENT_CODEX_ENVIRONMENT = "CODEX_HARNESS_CODEX_EXECUTABLE";
const DEVELOPMENT_SMOKE_EXPECTED_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_EXPECTED";
const DEVELOPMENT_SMOKE_USER_DATA_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_USER_DATA";
const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const rendererRoot = fileURLToPath(new URL("../renderer", import.meta.url));
const developmentDaemonEntry = fileURLToPath(
  new URL("../../../harnessd/dist/cli.js", import.meta.url),
);
const desktopAccountPlanTypes = new Set<string>(DESKTOP_ACCOUNT_PLAN_TYPES);

protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_RESOURCE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
    },
  },
]);
app.enableSandbox();
app.setName("Codex Harness");
const startupSmokeExpected = process.env[DEVELOPMENT_SMOKE_EXPECTED_ENVIRONMENT];
if (!app.isPackaged && (startupSmokeExpected === "ready" || startupSmokeExpected === "failed")) {
  const smokeUserData = process.env[DEVELOPMENT_SMOKE_USER_DATA_ENVIRONMENT];
  if (
    smokeUserData === undefined ||
    !isAbsolute(smokeUserData) ||
    smokeUserData.includes("\0") ||
    normalize(smokeUserData) !== smokeUserData ||
    !smokeUserData.startsWith("/tmp/ch-el-")
  ) {
    throw new Error("The desktop smoke user-data path is invalid.");
  }
  app.setPath("userData", smokeUserData);
}

async function runDesktopApplication(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  const stateStore = new BootstrapStateStore();
  const windows = new Set<BrowserWindow>();
  let shutdownStarted = false;
  let allowExit = false;
  let smokeExitOverride = 0;

  protocol.handle(
    LOCAL_RESOURCE_SCHEME,
    createLocalResourceHandler(rendererRoot, async (url) => await net.fetch(url)),
  );
  denyRendererPermissions();
  denyWebViews();

  const controller = new DesktopApplicationController({
    stateStore,
    createSupervisor: async (onAccountStatusChanged) => {
      if (process.platform !== "darwin") {
        throw new DaemonProcessSupervisorError("unsupported_platform");
      }
      const developmentCodexExecutable = process.env[DEVELOPMENT_CODEX_ENVIRONMENT];
      const resources = await resolveDesktopRuntimeResources({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        electronExecutable: process.execPath,
        developmentDaemonEntry,
        ...(!app.isPackaged && developmentCodexExecutable !== undefined
          ? { developmentCodexExecutable }
          : {}),
      });
      const runtimeRoot = await ensurePrivateDesktopRuntimeRoot(app.getPath("userData"));
      return await DaemonProcessSupervisor.start({
        command: resources.command,
        codexExecutable: resources.codexExecutable,
        args: [resources.daemonEntry],
        runtimeRoot,
        clientVersion: desktopBootstrapMetadata.version,
        electronRunAsNode: true,
        onAccountStatusChanged,
      });
    },
  });

  const broadcastState = (state: DesktopBootstrapState): void => {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(BOOTSTRAP_STATE_CHANGED_CHANNEL, state);
      }
    }
  };
  stateStore.subscribe(broadcastState);

  ipcMain.handle(
    GET_BOOTSTRAP_STATE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): DesktopBootstrapState => {
      if (args.length !== 0 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      return stateStore.current;
    },
  );

  const createWindow = (): BrowserWindow => {
    const window = new BrowserWindow(createSecureWindowOptions(preloadPath));
    windows.add(window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    window.once("ready-to-show", () => {
      window.show();
    });
    window.once("closed", () => {
      windows.delete(window);
    });
    void window.loadURL(RENDERER_DOCUMENT_URL).catch(() => {
      const phase = stateStore.current.phase;
      if (phase === "starting" || phase === "ready") {
        stateStore.transition(failedBootstrapState("internal_error"));
      }
    });
    return window;
  };

  let mainWindow = createWindow();
  const focusOrCreateMainWindow = (): void => {
    if (windows.size === 0 || mainWindow.isDestroyed()) {
      mainWindow = createWindow();
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  };
  app.on("activate", focusOrCreateMainWindow);
  app.on("second-instance", focusOrCreateMainWindow);
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    if (allowExit) {
      return;
    }
    event.preventDefault();
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    void controller.stop().then((exitCode) => {
      allowExit = true;
      app.exit(Math.max(exitCode, smokeExitOverride));
    });
  });

  if (!app.isPackaged) {
    const expected = process.env[DEVELOPMENT_SMOKE_EXPECTED_ENVIRONMENT];
    if (expected === "ready" || expected === "failed") {
      installSmokeObservation(mainWindow, stateStore, expected, () => {
        smokeExitOverride = 1;
      });
    }
  }

  await controller.start();
}

function isManagedRenderer(
  event: IpcMainInvokeEvent,
  windows: ReadonlySet<BrowserWindow>,
): boolean {
  for (const window of windows) {
    if (
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      isTrustedRendererSender(event.senderFrame, window.webContents)
    ) {
      return true;
    }
  }
  return false;
}

function denyRendererPermissions(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function denyWebViews(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });
}

function installSmokeObservation(
  window: BrowserWindow,
  stateStore: BootstrapStateStore,
  expected: "ready" | "failed",
  markFailure: () => void,
): void {
  let finished = false;
  const timeout = setTimeout(() => {
    if (!finished) {
      finished = true;
      markFailure();
      process.stderr.write(`desktop-smoke:timeout:${JSON.stringify(stateStore.current)}\n`);
      app.quit();
    }
  }, 45_000);
  const inspect = async (state: DesktopBootstrapState): Promise<void> => {
    if (finished || state.phase !== expected || window.isDestroyed()) {
      return;
    }
    for (let attempt = 0; attempt < 100 && !finished; attempt += 1) {
      try {
        const rendered = (await window.webContents.executeJavaScript(
          `(() => {
            const text = document.body?.textContent ?? "";
            return {
              phase: document.querySelector("[data-bootstrap-phase]")?.dataset.bootstrapPhase,
              code: document.querySelector("[data-bootstrap-code]")?.dataset.bootstrapCode,
              accountStatus: document.querySelector("[data-account-status]")?.dataset.accountStatus,
              accountCredential: document.querySelector("[data-account-credential]")?.dataset.accountCredential,
              accountPlan: document.querySelector("[data-account-plan]")?.dataset.accountPlan,
              modelProvider: document.querySelector("[data-model-catalog-provider]")?.dataset.modelCatalogProvider,
              modelCount: document.querySelector("[data-model-catalog-count]")?.dataset.modelCatalogCount,
              modelNames: Array.from(document.querySelectorAll("[data-model-name]"), (element) => element.dataset.modelName),
              containsSensitiveText: ["private@example.com", "must-not-survive", "snapshotId", "workerSessionId", "nextCursor", "id-smoke"].some((value) => text.includes(value))
            };
          })()`,
          true,
        )) as {
          phase?: unknown;
          code?: unknown;
          accountStatus?: unknown;
          accountCredential?: unknown;
          accountPlan?: unknown;
          modelProvider?: unknown;
          modelCount?: unknown;
          modelNames?: unknown;
          containsSensitiveText?: unknown;
        };
        const accountObserved =
          expected === "ready" &&
          validRenderedAccountObservation(
            rendered.accountStatus,
            rendered.accountCredential,
            rendered.accountPlan,
          ) &&
          rendered.containsSensitiveText === false;
        const modelCatalogObserved =
          expected === "ready" &&
          validRenderedModelCatalog(
            rendered.modelProvider,
            rendered.modelCount,
            rendered.modelNames,
          );
        if (
          rendered.phase === expected &&
          (expected !== "failed" ||
            (typeof rendered.code === "string" && rendered.code.length > 0)) &&
          (expected !== "ready" || (accountObserved && modelCatalogObserved))
        ) {
          finished = true;
          clearTimeout(timeout);
          process.stdout.write(
            `desktop-smoke:${JSON.stringify({ phase: rendered.phase, ...(rendered.code === undefined ? {} : { code: rendered.code }), ...(expected === "ready" ? { accountObserved: true, modelCatalogObserved: true } : {}) })}\n`,
          );
          app.quit();
          return;
        }
      } catch {
        // The document may still be loading; the bounded loop retries the fixed observation.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  stateStore.subscribe((state) => {
    void inspect(state);
  });
  window.webContents.once("did-finish-load", () => {
    void inspect(stateStore.current);
  });
}

function validRenderedModelCatalog(
  provider: unknown,
  count: unknown,
  modelNames: unknown,
): boolean {
  return (
    provider === "openai" &&
    count === "2" &&
    Array.isArray(modelNames) &&
    modelNames.length === 2 &&
    modelNames[0] === "smoke-a" &&
    modelNames[1] === "smoke-b"
  );
}

function validRenderedAccountObservation(
  status: unknown,
  credential: unknown,
  plan: unknown,
): boolean {
  if (
    status !== "authenticated" &&
    status !== "authentication_required" &&
    status !== "not_required"
  ) {
    return false;
  }
  if (
    credential !== "none" &&
    credential !== "amazon_bedrock" &&
    credential !== "api_key" &&
    credential !== "chatgpt"
  ) {
    return false;
  }
  if (
    typeof plan !== "string" ||
    (plan !== "not_applicable" && !desktopAccountPlanTypes.has(plan))
  ) {
    return false;
  }
  return status === "authenticated"
    ? credential !== "none" &&
        (credential === "chatgpt" ? plan !== "not_applicable" : plan === "not_applicable")
    : credential === "none" && plan === "not_applicable";
}

void runDesktopApplication().catch(() => {
  app.exit(1);
});
