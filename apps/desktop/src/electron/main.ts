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
  decodeDesktopRoutingConfigurationMutationResult,
  decodeDesktopRoutingConfigurationUpdate,
  failedBootstrapState,
  type DesktopBootstrapState,
} from "../shared/bootstrap-state.js";
import { DesktopApplicationController } from "./application-controller.js";
import { LOCAL_RESOURCE_SCHEME, createLocalResourceHandler } from "./local-resource-protocol.js";
import {
  ensurePrivateDesktopRuntimeRoot,
  ensurePrivateDesktopStateDatabasePath,
  resolveDesktopRuntimeResources,
} from "./runtime-resources.js";
import {
  RENDERER_DOCUMENT_URL,
  createSecureWindowOptions,
  isTrustedRendererSender,
} from "./security-boundary.js";

const GET_BOOTSTRAP_STATE_CHANNEL = "desktop.bootstrap.get";
const BOOTSTRAP_STATE_CHANGED_CHANNEL = "desktop.bootstrap.changed";
const SET_ROUTING_CONFIGURATION_CHANNEL = "desktop.routing.set";
const DEVELOPMENT_CODEX_ENVIRONMENT = "CODEX_HARNESS_CODEX_EXECUTABLE";
const DEVELOPMENT_SMOKE_EXPECTED_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_EXPECTED";
const DEVELOPMENT_SMOKE_USER_DATA_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_USER_DATA";
const DEVELOPMENT_SMOKE_ROUTING_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_ROUTING";
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
      const userDataPath = app.getPath("userData");
      const [runtimeRoot, stateDatabasePath] = await Promise.all([
        ensurePrivateDesktopRuntimeRoot(userDataPath),
        ensurePrivateDesktopStateDatabasePath(userDataPath),
      ]);
      return await DaemonProcessSupervisor.start({
        command: resources.command,
        codexExecutable: resources.codexExecutable,
        args: [resources.daemonEntry],
        runtimeRoot,
        stateDatabasePath,
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

  ipcMain.handle(
    SET_ROUTING_CONFIGURATION_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const update = decodeDesktopRoutingConfigurationUpdate(args[0]);
      if (update === undefined) {
        throw new Error("The desktop routing update is invalid.");
      }
      const result = decodeDesktopRoutingConfigurationMutationResult(
        await controller.setRoutingConfiguration(update),
      );
      return result ?? Object.freeze({ status: "unavailable" as const });
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
      const routingMode = process.env[DEVELOPMENT_SMOKE_ROUTING_ENVIRONMENT];
      installSmokeObservation(
        mainWindow,
        stateStore,
        expected,
        () => {
          smokeExitOverride = 1;
        },
        routingMode === "configure" || routingMode === "recover" ? routingMode : undefined,
      );
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
  routingMode: "configure" | "recover" | undefined,
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
            const routingMode = ${JSON.stringify(routingMode)};
            const matrix = document.querySelector("[data-routing-configured]");
            if (routingMode === "configure" && matrix?.dataset.routingConfigured === "false" && !window.__codexHarnessRoutingSmokeSubmitted) {
              const values = {
                fast: { model: "smoke-a", reasoningEffort: "low" },
                standard: { model: "smoke-b", reasoningEffort: "medium" },
                deep: { model: "smoke-b", reasoningEffort: "medium" }
              };
              let valuesStable = true;
              for (const [tier, target] of Object.entries(values)) {
                for (const [field, value] of Object.entries(target)) {
                  const input = document.querySelector('[data-routing-tier="' + tier + '"][data-routing-field="' + field + '"]');
                  if (!(input instanceof HTMLInputElement)) {
                    valuesStable = false;
                  } else if (input.value !== value) {
                    valuesStable = false;
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                    setter?.call(input, value);
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                  }
                }
              }
              const save = document.querySelector("[data-routing-save]");
              if (valuesStable && save instanceof HTMLButtonElement && !save.disabled) {
                window.__codexHarnessRoutingSmokeSubmitted = true;
                save.click();
              }
            }
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
              routingConfigured: matrix?.dataset.routingConfigured,
              routingRevision: matrix?.dataset.routingRevision,
              routingModels: Array.from(document.querySelectorAll('[data-routing-field="model"]'), (element) => element.value),
              routingEfforts: Array.from(document.querySelectorAll('[data-routing-field="reasoningEffort"]'), (element) => element.value),
              routingAvailability: Array.from(document.querySelectorAll("[data-routing-availability]"), (element) => element.dataset.routingAvailability),
              routingFeedback: document.querySelector("[data-routing-feedback]")?.textContent,
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
          routingConfigured?: unknown;
          routingRevision?: unknown;
          routingModels?: unknown;
          routingEfforts?: unknown;
          routingAvailability?: unknown;
          routingFeedback?: unknown;
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
        const routingObserved =
          expected === "ready" &&
          (routingMode === undefined ||
            (rendered.routingConfigured === "true" &&
              rendered.routingRevision === "1" &&
              Array.isArray(rendered.routingModels) &&
              rendered.routingModels.join(",") === "smoke-a,smoke-b,smoke-b" &&
              Array.isArray(rendered.routingEfforts) &&
              rendered.routingEfforts.join(",") === "low,medium,medium" &&
              Array.isArray(rendered.routingAvailability) &&
              rendered.routingAvailability.every((status) => status === "observed_available") &&
              (routingMode !== "configure" ||
                rendered.routingFeedback === "配置已持久化；实际执行仍未开放。")));
        if (
          rendered.phase === expected &&
          (expected !== "failed" ||
            (typeof rendered.code === "string" && rendered.code.length > 0)) &&
          (expected !== "ready" || (accountObserved && modelCatalogObserved && routingObserved))
        ) {
          finished = true;
          clearTimeout(timeout);
          process.stdout.write(
            `desktop-smoke:${JSON.stringify({ phase: rendered.phase, ...(rendered.code === undefined ? {} : { code: rendered.code }), ...(expected === "ready" ? { accountObserved: true, modelCatalogObserved: true, routingObserved: true } : {}) })}\n`,
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
