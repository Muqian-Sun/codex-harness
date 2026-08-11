import { basename, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
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
  decodeDesktopProjectRoutingBindingMutationResult,
  decodeDesktopProjectRoutingBindingProjectId,
  decodeDesktopProjectTaskCatalogResult,
  decodeDesktopProjectTaskCandidatePlanConfirmation,
  decodeDesktopProjectTaskCandidatePlanConfirmationResult,
  decodeDesktopProjectTaskCandidatePlanGeneration,
  decodeDesktopProjectTaskCandidatePlanMutationResult,
  decodeDesktopProjectTaskCreation,
  decodeDesktopProjectTaskDetailResult,
  decodeDesktopProjectTaskGraphMaterialization,
  decodeDesktopProjectTaskGraphMaterializationResult,
  decodeDesktopProjectTaskOperationManifestConfirmation,
  decodeDesktopProjectTaskOperationManifestConfirmationResult,
  decodeDesktopProjectTaskOperationManifestGeneration,
  decodeDesktopProjectTaskOperationManifestGenerationResult,
  decodeDesktopProjectTaskMutationResult,
  decodeDesktopProjectTaskRequirementMutationResult,
  decodeDesktopProjectTaskRequirementRevision,
  decodeDesktopProjectTaskSelection,
  decodeDesktopProjectSelectionResult,
  decodeDesktopProjectWorkspaceRegistration,
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
import { ensureSmokeSettingsWorkspace } from "./smoke-settings-workspace.js";

const GET_BOOTSTRAP_STATE_CHANNEL = "desktop.bootstrap.get";
const BOOTSTRAP_STATE_CHANGED_CHANNEL = "desktop.bootstrap.changed";
const SET_ROUTING_CONFIGURATION_CHANNEL = "desktop.routing.set";
const CHOOSE_PROJECT_WORKSPACE_CHANNEL = "desktop.project.choose";
const BIND_PROJECT_DEFAULT_ROUTING_CHANNEL = "desktop.project.routing.bind_default";
const READ_PROJECT_TASK_CATALOG_CHANNEL = "desktop.task.catalog_page";
const CREATE_PROJECT_TASK_CHANNEL = "desktop.task.create";
const READ_PROJECT_TASK_DETAIL_CHANNEL = "desktop.task.detail";
const CONFIRM_PROJECT_TASK_CANDIDATE_PLAN_CHANNEL = "desktop.task.plan.confirm_candidate";
const GENERATE_PROJECT_TASK_CANDIDATE_PLAN_CHANNEL = "desktop.task.plan.generate_candidate";
const REVISE_PROJECT_TASK_REQUIREMENT_CHANNEL = "desktop.task.requirement.revise";
const MATERIALIZE_PROJECT_TASK_GRAPH_CHANNEL = "desktop.task.graph.materialize";
const GENERATE_PROJECT_TASK_OPERATION_MANIFEST_CHANNEL =
  "desktop.task.operation_manifest.generate_candidate";
const CONFIRM_PROJECT_TASK_OPERATION_MANIFEST_CHANNEL =
  "desktop.task.operation_manifest.confirm_candidate";
const DEVELOPMENT_CODEX_ENVIRONMENT = "CODEX_HARNESS_CODEX_EXECUTABLE";
const DEVELOPMENT_SMOKE_EXPECTED_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_EXPECTED";
const DEVELOPMENT_SMOKE_USER_DATA_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_USER_DATA";
const DEVELOPMENT_SMOKE_ROUTING_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_ROUTING";
const DEVELOPMENT_SMOKE_PROJECT_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_PROJECT";
const DEVELOPMENT_SMOKE_PROJECT_PATH_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_PROJECT_PATH";
const DEVELOPMENT_SMOKE_BINDING_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_BINDING";
const DEVELOPMENT_SMOKE_TASK_ENVIRONMENT = "CODEX_HARNESS_DESKTOP_SMOKE_TASK";
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
  let projectWorkspaceSelectionActive = false;
  const activeProjectRoutingBindings = new Set<string>();
  const activeProjectTaskCreations = new Set<string>();
  const activeProjectTaskRequirementRevisions = new Set<string>();
  const activeProjectTaskCandidatePlanGenerations = new Set<string>();
  const activeProjectTaskCandidatePlanConfirmations = new Set<string>();
  const activeProjectTaskGraphMaterializations = new Set<string>();
  const activeProjectTaskOperationManifestMutations = new Set<string>();

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
    CHOOSE_PROJECT_WORKSPACE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const owner = args.length === 0 ? managedRendererWindow(event, windows) : undefined;
      if (owner === undefined) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      if (stateStore.current.phase !== "ready" || projectWorkspaceSelectionActive) {
        return Object.freeze({ status: "unavailable" as const });
      }
      projectWorkspaceSelectionActive = true;
      try {
        const selection = await chooseProjectDirectory(owner);
        if (selection.status !== "selected") {
          return selection;
        }
        const registration = decodeDesktopProjectWorkspaceRegistration({
          displayName: basename(selection.absolutePath) || selection.absolutePath,
          workspace: {
            platform: currentDesktopProjectPlatform(),
            absolutePath: selection.absolutePath,
          },
        });
        if (registration === undefined) {
          return Object.freeze({ status: "unavailable" as const });
        }
        const result = decodeDesktopProjectSelectionResult(
          await controller.registerProjectWorkspace(registration),
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        projectWorkspaceSelectionActive = false;
      }
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

  ipcMain.handle(
    BIND_PROJECT_DEFAULT_ROUTING_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const projectId = decodeDesktopProjectRoutingBindingProjectId(args[0]);
      const state = stateStore.current;
      if (
        projectId === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === projectId)
      ) {
        throw new Error("The desktop Project routing binding request is invalid.");
      }
      if (activeProjectRoutingBindings.has(projectId)) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectRoutingBindings.add(projectId);
      try {
        const result = decodeDesktopProjectRoutingBindingMutationResult(
          await controller.bindProjectToDefaultRouting(projectId),
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectRoutingBindings.delete(projectId);
      }
    },
  );

  ipcMain.handle(
    READ_PROJECT_TASK_CATALOG_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const projectId = decodeDesktopProjectRoutingBindingProjectId(args[0]);
      const state = stateStore.current;
      if (
        projectId === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === projectId)
      ) {
        throw new Error("The desktop Project Task catalog request is invalid.");
      }
      const result = decodeDesktopProjectTaskCatalogResult(
        await controller.readProjectTaskCatalog(projectId),
        projectId,
      );
      return result ?? Object.freeze({ status: "unavailable" as const });
    },
  );

  ipcMain.handle(
    CREATE_PROJECT_TASK_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const creation = decodeDesktopProjectTaskCreation(args[0]);
      const state = stateStore.current;
      const binding =
        creation === undefined || state.phase !== "ready"
          ? undefined
          : state.projectRoutingBindings.bindings.find(
              (candidate) => candidate.projectId === creation.projectId,
            );
      if (
        creation === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === creation.projectId) ||
        binding === undefined
      ) {
        throw new Error("The desktop Project Task creation request is invalid.");
      }
      if (binding.status !== "default_bound") {
        return Object.freeze({ status: "routing_unbound" as const });
      }
      if (activeProjectTaskCreations.has(creation.projectId)) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectTaskCreations.add(creation.projectId);
      try {
        const result = decodeDesktopProjectTaskMutationResult(
          await controller.createProjectTask(creation),
          creation.projectId,
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectTaskCreations.delete(creation.projectId);
      }
    },
  );

  ipcMain.handle(
    READ_PROJECT_TASK_DETAIL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const selection = decodeDesktopProjectTaskSelection(args[0]);
      const state = stateStore.current;
      if (
        selection === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === selection.projectId)
      ) {
        throw new Error("The desktop Project Task detail request is invalid.");
      }
      const result = decodeDesktopProjectTaskDetailResult(
        await controller.readProjectTaskDetail(selection),
        selection.projectId,
        selection.taskId,
      );
      return result ?? Object.freeze({ status: "unavailable" as const });
    },
  );

  ipcMain.handle(
    REVISE_PROJECT_TASK_REQUIREMENT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const revision = decodeDesktopProjectTaskRequirementRevision(args[0]);
      const state = stateStore.current;
      if (
        revision === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === revision.projectId)
      ) {
        throw new Error("The desktop Project Task Requirement revision is invalid.");
      }
      const mutationKey = `${revision.projectId}/${revision.taskId}`;
      if (
        activeProjectTaskRequirementRevisions.has(mutationKey) ||
        activeProjectTaskCandidatePlanGenerations.has(mutationKey) ||
        activeProjectTaskCandidatePlanConfirmations.has(mutationKey) ||
        activeProjectTaskGraphMaterializations.has(mutationKey) ||
        activeProjectTaskOperationManifestMutations.has(mutationKey)
      ) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectTaskRequirementRevisions.add(mutationKey);
      try {
        const result = decodeDesktopProjectTaskRequirementMutationResult(
          await controller.reviseProjectTaskRequirement(revision),
          revision.projectId,
          revision.taskId,
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectTaskRequirementRevisions.delete(mutationKey);
      }
    },
  );

  ipcMain.handle(
    GENERATE_PROJECT_TASK_CANDIDATE_PLAN_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const generation = decodeDesktopProjectTaskCandidatePlanGeneration(args[0]);
      const state = stateStore.current;
      if (
        generation === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === generation.projectId)
      ) {
        throw new Error("The desktop Project Task candidate Plan generation is invalid.");
      }
      const mutationKey = `${generation.projectId}/${generation.taskId}`;
      if (
        activeProjectTaskCandidatePlanGenerations.has(mutationKey) ||
        activeProjectTaskRequirementRevisions.has(mutationKey) ||
        activeProjectTaskCandidatePlanConfirmations.has(mutationKey) ||
        activeProjectTaskGraphMaterializations.has(mutationKey) ||
        activeProjectTaskOperationManifestMutations.has(mutationKey)
      ) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectTaskCandidatePlanGenerations.add(mutationKey);
      try {
        const result = decodeDesktopProjectTaskCandidatePlanMutationResult(
          await controller.generateProjectTaskCandidatePlan(generation),
          generation.projectId,
          generation.taskId,
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectTaskCandidatePlanGenerations.delete(mutationKey);
      }
    },
  );

  ipcMain.handle(
    CONFIRM_PROJECT_TASK_CANDIDATE_PLAN_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const confirmation = decodeDesktopProjectTaskCandidatePlanConfirmation(args[0]);
      const state = stateStore.current;
      if (
        confirmation === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === confirmation.projectId)
      ) {
        throw new Error("The desktop Project Task candidate Plan confirmation is invalid.");
      }
      const mutationKey = `${confirmation.projectId}/${confirmation.taskId}`;
      if (
        activeProjectTaskCandidatePlanConfirmations.has(mutationKey) ||
        activeProjectTaskCandidatePlanGenerations.has(mutationKey) ||
        activeProjectTaskRequirementRevisions.has(mutationKey) ||
        activeProjectTaskGraphMaterializations.has(mutationKey) ||
        activeProjectTaskOperationManifestMutations.has(mutationKey)
      ) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectTaskCandidatePlanConfirmations.add(mutationKey);
      try {
        const result = decodeDesktopProjectTaskCandidatePlanConfirmationResult(
          await controller.confirmProjectTaskCandidatePlan(confirmation),
          confirmation.projectId,
          confirmation.taskId,
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectTaskCandidatePlanConfirmations.delete(mutationKey);
      }
    },
  );

  ipcMain.handle(
    MATERIALIZE_PROJECT_TASK_GRAPH_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const materialization = decodeDesktopProjectTaskGraphMaterialization(args[0]);
      const state = stateStore.current;
      if (
        materialization === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === materialization.projectId)
      ) {
        throw new Error("The desktop Project Task graph materialization is invalid.");
      }
      const mutationKey = `${materialization.projectId}/${materialization.taskId}`;
      if (
        activeProjectTaskGraphMaterializations.has(mutationKey) ||
        activeProjectTaskCandidatePlanConfirmations.has(mutationKey) ||
        activeProjectTaskCandidatePlanGenerations.has(mutationKey) ||
        activeProjectTaskRequirementRevisions.has(mutationKey) ||
        activeProjectTaskOperationManifestMutations.has(mutationKey)
      ) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectTaskGraphMaterializations.add(mutationKey);
      try {
        const result = decodeDesktopProjectTaskGraphMaterializationResult(
          await controller.materializeProjectTaskGraph(materialization),
          materialization.projectId,
          materialization.taskId,
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectTaskGraphMaterializations.delete(mutationKey);
      }
    },
  );

  ipcMain.handle(
    GENERATE_PROJECT_TASK_OPERATION_MANIFEST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const generation = decodeDesktopProjectTaskOperationManifestGeneration(args[0]);
      const state = stateStore.current;
      if (
        generation === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === generation.projectId)
      ) {
        throw new Error("The desktop Project Task operation manifest generation is invalid.");
      }
      const mutationKey = `${generation.projectId}/${generation.taskId}`;
      if (
        activeProjectTaskOperationManifestMutations.has(mutationKey) ||
        activeProjectTaskGraphMaterializations.has(mutationKey) ||
        activeProjectTaskCandidatePlanConfirmations.has(mutationKey) ||
        activeProjectTaskCandidatePlanGenerations.has(mutationKey) ||
        activeProjectTaskRequirementRevisions.has(mutationKey)
      ) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectTaskOperationManifestMutations.add(mutationKey);
      try {
        const result = decodeDesktopProjectTaskOperationManifestGenerationResult(
          await controller.generateProjectTaskOperationManifest(generation),
          generation.projectId,
          generation.taskId,
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectTaskOperationManifestMutations.delete(mutationKey);
      }
    },
  );

  ipcMain.handle(
    CONFIRM_PROJECT_TASK_OPERATION_MANIFEST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 1 || !isManagedRenderer(event, windows)) {
        throw new Error("The desktop IPC sender is not authorized.");
      }
      const confirmation = decodeDesktopProjectTaskOperationManifestConfirmation(args[0]);
      const state = stateStore.current;
      if (
        confirmation === undefined ||
        state.phase !== "ready" ||
        !state.projects.projects.some((project) => project.projectId === confirmation.projectId)
      ) {
        throw new Error("The desktop Project Task operation manifest confirmation is invalid.");
      }
      const mutationKey = `${confirmation.projectId}/${confirmation.taskId}`;
      if (
        activeProjectTaskOperationManifestMutations.has(mutationKey) ||
        activeProjectTaskGraphMaterializations.has(mutationKey) ||
        activeProjectTaskCandidatePlanConfirmations.has(mutationKey) ||
        activeProjectTaskCandidatePlanGenerations.has(mutationKey) ||
        activeProjectTaskRequirementRevisions.has(mutationKey)
      ) {
        return Object.freeze({ status: "unavailable" as const });
      }
      activeProjectTaskOperationManifestMutations.add(mutationKey);
      try {
        const result = decodeDesktopProjectTaskOperationManifestConfirmationResult(
          await controller.confirmProjectTaskOperationManifest(confirmation),
          confirmation.projectId,
          confirmation.taskId,
        );
        return result ?? Object.freeze({ status: "unavailable" as const });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      } finally {
        activeProjectTaskOperationManifestMutations.delete(mutationKey);
      }
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
      const projectMode = process.env[DEVELOPMENT_SMOKE_PROJECT_ENVIRONMENT];
      const bindingMode = process.env[DEVELOPMENT_SMOKE_BINDING_ENVIRONMENT];
      const taskMode = process.env[DEVELOPMENT_SMOKE_TASK_ENVIRONMENT];
      installSmokeObservation(
        mainWindow,
        stateStore,
        expected,
        () => {
          smokeExitOverride = 1;
        },
        routingMode === "configure" || routingMode === "recover" ? routingMode : undefined,
        projectMode === "register" || projectMode === "recover" ? projectMode : undefined,
        bindingMode === "bind" || bindingMode === "recover" ? bindingMode : undefined,
        taskMode === "create_revise" || taskMode === "recover_revision" ? taskMode : undefined,
      );
    }
  }

  await controller.start();
}

function isManagedRenderer(
  event: IpcMainInvokeEvent,
  windows: ReadonlySet<BrowserWindow>,
): boolean {
  return managedRendererWindow(event, windows) !== undefined;
}

function managedRendererWindow(
  event: IpcMainInvokeEvent,
  windows: ReadonlySet<BrowserWindow>,
): BrowserWindow | undefined {
  for (const window of windows) {
    if (
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      isTrustedRendererSender(event.senderFrame, window.webContents)
    ) {
      return window;
    }
  }
  return undefined;
}

async function chooseProjectDirectory(
  owner: BrowserWindow,
): Promise<
  Readonly<{ status: "cancelled" | "unavailable" } | { status: "selected"; absolutePath: string }>
> {
  const smokePath = developmentSmokeProjectPath();
  if (smokePath !== undefined) {
    return Object.freeze({ status: "selected", absolutePath: smokePath });
  }
  const result = await dialog.showOpenDialog(owner, {
    title: "选择 Harness 工作区",
    buttonLabel: "注册工作区",
    properties: ["openDirectory"],
  });
  if (result.canceled) {
    return Object.freeze({ status: "cancelled" });
  }
  return result.filePaths.length === 1
    ? Object.freeze({ status: "selected", absolutePath: result.filePaths[0]! })
    : Object.freeze({ status: "unavailable" });
}

function developmentSmokeProjectPath(): string | undefined {
  if (app.isPackaged || process.env[DEVELOPMENT_SMOKE_PROJECT_ENVIRONMENT] !== "register") {
    return undefined;
  }
  const userData = app.getPath("userData");
  const projectPath = process.env[DEVELOPMENT_SMOKE_PROJECT_PATH_ENVIRONMENT];
  if (
    projectPath === undefined ||
    !isAbsolute(projectPath) ||
    projectPath.includes("\0") ||
    normalize(projectPath) !== projectPath ||
    !projectPath.startsWith(`${userData}/`) ||
    basename(projectPath).length === 0
  ) {
    throw new Error("The desktop smoke Project path is invalid.");
  }
  return projectPath;
}

function currentDesktopProjectPlatform(): "macos" | "windows" | "linux" {
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "win32") {
    return "windows";
  }
  return "linux";
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

const ROUTING_SMOKE_TIERS = Object.freeze(["fast", "standard", "deep"] as const);
const ROUTING_SMOKE_DRAFT = Object.freeze({
  fast: Object.freeze({ model: "smoke-a", reasoningEffort: "low" }),
  standard: Object.freeze({ model: "smoke-b", reasoningEffort: "medium" }),
  deep: Object.freeze({ model: "smoke-b", reasoningEffort: "medium" }),
});
const ROUTING_SMOKE_FIELDS = Object.freeze(
  ROUTING_SMOKE_TIERS.flatMap((tier) => [
    Object.freeze({ tier, field: "model", value: ROUTING_SMOKE_DRAFT[tier].model }),
    Object.freeze({
      tier,
      field: "reasoningEffort",
      value: ROUTING_SMOKE_DRAFT[tier].reasoningEffort,
    }),
  ]),
);
const TASK_SMOKE_DRAFT = Object.freeze({
  title: "桌面重启恢复 Task",
  sourceText: "只持久化初始需求，不启动计划、模型调用或执行。",
});
const TASK_SMOKE_REVISED_SOURCE = "用户补充了需求；保存新修订，但仍不启动计划、模型调用或执行。";

async function driveRoutingSmokeForm(
  window: BrowserWindow,
  reportProgress: (progress: unknown) => void,
): Promise<boolean> {
  for (const { tier, field, value } of ROUTING_SMOKE_FIELDS) {
    reportProgress(Object.freeze({ phase: "focusing_field", tier, field }));
    const selector = `[data-routing-tier="${tier}"][data-routing-field="${field}"]`;
    const focused = (await window.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!(input instanceof HTMLInputElement)) {
          return false;
        }
        input.focus();
        input.select();
        return document.activeElement === input;
      })()`,
      true,
    )) as unknown;
    if (focused !== true) {
      return false;
    }
    reportProgress(Object.freeze({ phase: "inserting_text", tier, field }));
    await window.webContents.insertText(value);
  }
  reportProgress(Object.freeze({ phase: "draft_inserted" }));
  return true;
}

async function driveTaskSmokeForm(
  window: BrowserWindow,
  reportProgress: (progress: unknown) => void,
): Promise<boolean> {
  for (const { selector, field, value } of [
    Object.freeze({ selector: "[data-task-title]", field: "title", value: TASK_SMOKE_DRAFT.title }),
    Object.freeze({
      selector: "[data-task-source]",
      field: "sourceText",
      value: TASK_SMOKE_DRAFT.sourceText,
    }),
  ]) {
    reportProgress(Object.freeze({ phase: "focusing_task_field", field }));
    const focused = (await window.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!((input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) || input.disabled) {
          return false;
        }
        input.focus();
        input.select();
        return document.activeElement === input;
      })()`,
      true,
    )) as unknown;
    if (focused !== true) {
      return false;
    }
    reportProgress(Object.freeze({ phase: "inserting_task_text", field }));
    await window.webContents.insertText(value);
  }
  reportProgress(Object.freeze({ phase: "task_draft_inserted" }));
  return true;
}

async function driveTaskRequirementSmokeForm(
  window: BrowserWindow,
  reportProgress: (progress: unknown) => void,
): Promise<boolean> {
  reportProgress(Object.freeze({ phase: "focusing_task_requirement" }));
  const focused = (await window.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector("[data-task-revision-source]");
      if (!(input instanceof HTMLTextAreaElement) || input.disabled) {
        return false;
      }
      input.focus();
      input.select();
      return document.activeElement === input;
    })()`,
    true,
  )) as unknown;
  if (focused !== true) {
    return false;
  }
  reportProgress(Object.freeze({ phase: "inserting_task_requirement" }));
  await window.webContents.insertText(TASK_SMOKE_REVISED_SOURCE);
  reportProgress(Object.freeze({ phase: "task_requirement_draft_inserted" }));
  return true;
}

function routingSmokeDraftMatches(models: unknown, efforts: unknown): boolean {
  return (
    Array.isArray(models) &&
    models.length === ROUTING_SMOKE_TIERS.length &&
    Array.isArray(efforts) &&
    efforts.length === ROUTING_SMOKE_TIERS.length &&
    ROUTING_SMOKE_TIERS.every(
      (tier, index) =>
        models[index] === ROUTING_SMOKE_DRAFT[tier].model &&
        efforts[index] === ROUTING_SMOKE_DRAFT[tier].reasoningEffort,
    )
  );
}

function classifySmokeConsoleError(message: string): string {
  const nullProperty =
    /\b(TypeError): Cannot read properties of (null|undefined) \(reading '([A-Za-z0-9_]{1,32})'\)/u.exec(
      message,
    );
  if (nullProperty !== null) {
    return `${nullProperty[1]}:null_property_access:${nullProperty[3]}`;
  }
  if (/Content Security Policy|Refused to load/u.test(message)) {
    return "renderer_error:content_security_policy";
  }
  if (/Failed to load resource|ERR_[A-Z_]+/u.test(message)) {
    return "renderer_error:resource_load_failed";
  }
  const errorType = /\b(TypeError|ReferenceError|SyntaxError|RangeError|Error)\b/u.exec(
    message,
  )?.[1];
  return errorType === undefined ? "renderer_error:unclassified" : `${errorType}:unclassified`;
}

function desktopSmokeBootstrapProgress(state: DesktopBootstrapState): unknown {
  if (state.phase === "failed") {
    return Object.freeze({ phase: state.phase, code: state.code });
  }
  if (state.phase === "ready") {
    return Object.freeze({
      phase: state.phase,
      accountStatus: state.account.status,
      modelCount: state.catalog.totalVisibleModels,
      routingConfigured: state.routing.configured,
      routingProfileVersion: state.routing.profileVersion,
      projectCount: state.projects.projects.length,
      projectRoutingBindings: state.projectRoutingBindings.bindings.map(
        (binding) => binding.status,
      ),
    });
  }
  return Object.freeze({ phase: state.phase });
}

function installSmokeObservation(
  window: BrowserWindow,
  stateStore: BootstrapStateStore,
  expected: "ready" | "failed",
  markFailure: () => void,
  routingMode: "configure" | "recover" | undefined,
  projectMode: "register" | "recover" | undefined,
  bindingMode: "bind" | "recover" | undefined,
  taskMode: "create_revise" | "recover_revision" | undefined,
): void {
  let finished = false;
  let inspecting = false;
  let rendererLoaded = false;
  let routingFormDriven = false;
  let taskFormDriven = false;
  let taskRequirementFormDriven = false;
  let lastRendererProgress: unknown = Object.freeze({ phase: "not_observed" });
  let lastRendererConsoleError: unknown = "none";
  const inspectionDeadline = Date.now() + 45_000;
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") {
      lastRendererConsoleError = classifySmokeConsoleError(details.message);
    }
  });
  const timeout = setTimeout(() => {
    if (!finished) {
      finished = true;
      markFailure();
      process.stderr.write(
        `desktop-smoke:timeout:${JSON.stringify({ bootstrap: desktopSmokeBootstrapProgress(stateStore.current), renderer: lastRendererProgress, rendererConsoleError: lastRendererConsoleError })}\n`,
      );
      app.quit();
    }
  }, 45_000);
  const inspect = async (state: DesktopBootstrapState): Promise<void> => {
    if (
      finished ||
      inspecting ||
      !rendererLoaded ||
      state.phase !== expected ||
      window.isDestroyed()
    ) {
      return;
    }
    inspecting = true;
    try {
      while (Date.now() < inspectionDeadline && !finished) {
        try {
          await ensureSmokeSettingsWorkspace(window);
          if (routingMode === "configure" && !routingFormDriven) {
            routingFormDriven = await driveRoutingSmokeForm(window, (progress) => {
              lastRendererProgress = progress;
            });
          }
          if (taskMode === "create_revise" && !taskFormDriven) {
            taskFormDriven = await driveTaskSmokeForm(window, (progress) => {
              lastRendererProgress = progress;
            });
          }
          if (taskMode === "create_revise" && taskFormDriven && !taskRequirementFormDriven) {
            taskRequirementFormDriven = await driveTaskRequirementSmokeForm(window, (progress) => {
              lastRendererProgress = progress;
            });
          }
          const rendered = (await window.webContents.executeJavaScript(
            `(() => {
            const routingMode = ${JSON.stringify(routingMode)};
            const projectMode = ${JSON.stringify(projectMode)};
            const bindingMode = ${JSON.stringify(bindingMode)};
            const taskMode = ${JSON.stringify(taskMode)};
            const taskDraft = ${JSON.stringify(TASK_SMOKE_DRAFT)};
            const revisedTaskSource = ${JSON.stringify(TASK_SMOKE_REVISED_SOURCE)};
            const matrix = document.querySelector("[data-routing-configured]");
            if (routingMode === "configure" && matrix?.dataset.routingConfigured === "false" && !window.__codexHarnessRoutingSmokeSubmitted) {
              const values = ${JSON.stringify(ROUTING_SMOKE_DRAFT)};
              let draftReady = true;
              for (const [tier, target] of Object.entries(values)) {
                for (const [field, value] of Object.entries(target)) {
                  const input = document.querySelector('[data-routing-tier="' + tier + '"][data-routing-field="' + field + '"]');
                  if (!(input instanceof HTMLInputElement) || input.value !== value) {
                    draftReady = false;
                  }
                }
              }
              const save = document.querySelector("[data-routing-save]");
              if (draftReady && save instanceof HTMLButtonElement && !save.disabled) {
                window.__codexHarnessRoutingSmokeSubmitted = true;
                save.click();
              }
            }
            const projectRegistry = document.querySelector("[data-project-count]");
            if (projectMode === "register" && projectRegistry?.dataset.projectCount === "0" && !window.__codexHarnessProjectSmokeSubmitted) {
              const choose = document.querySelector("[data-project-choose]");
              if (choose instanceof HTMLButtonElement && !choose.disabled) {
                window.__codexHarnessProjectSmokeSubmitted = true;
                choose.click();
              }
            }
            const projectRouting = document.querySelector("[data-project-routing]");
            if (bindingMode === "bind" && projectRouting?.dataset.projectRouting === "unbound" && !window.__codexHarnessBindingSmokeSubmitted) {
              const bind = projectRouting.querySelector("[data-project-routing-bind]");
              if (bind instanceof HTMLButtonElement && !bind.disabled) {
                window.__codexHarnessBindingSmokeSubmitted = true;
                bind.click();
              }
            }
            const taskPanel = document.querySelector("[data-task-catalog-status]");
            if (taskMode === "create_revise" && taskPanel?.dataset.taskCatalogStatus === "loaded" && taskPanel.dataset.taskCount === "0" && !window.__codexHarnessTaskSmokeSubmitted) {
              const title = document.querySelector("[data-task-title]");
              const source = document.querySelector("[data-task-source]");
              const create = document.querySelector("[data-task-create]");
              if (title instanceof HTMLInputElement && title.value === taskDraft.title && source instanceof HTMLTextAreaElement && source.value === taskDraft.sourceText && create instanceof HTMLButtonElement && !create.disabled) {
                window.__codexHarnessTaskSmokeSubmitted = true;
                create.click();
              }
            }
            const taskDetail = document.querySelector("[data-task-detail-status]");
            if (taskMode === "create_revise" && taskDetail?.dataset.taskDetailStatus === "loaded" && taskDetail.dataset.taskRequirementRevision === "1" && !window.__codexHarnessTaskRevisionSmokeSubmitted) {
              const source = document.querySelector("[data-task-revision-source]");
              const revise = document.querySelector("[data-task-revise]");
              if (source instanceof HTMLTextAreaElement && source.value === revisedTaskSource && revise instanceof HTMLButtonElement && !revise.disabled) {
                window.__codexHarnessTaskRevisionSmokeSubmitted = true;
                revise.click();
              }
            }
            const text = document.body?.textContent ?? "";
            return {
              documentReadyState: document.readyState,
              rootChildCount: document.querySelector("#root")?.childElementCount,
              scriptCount: document.scripts.length,
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
              routingSaveDisabled: document.querySelector("[data-routing-save]")?.disabled,
              routingSubmitted: window.__codexHarnessRoutingSmokeSubmitted === true,
              projectCount: projectRegistry?.dataset.projectCount,
              projectIdentity: Array.from(document.querySelectorAll("[data-project-identity]"), (element) => element.dataset.projectIdentity),
              projectPathShape: Array.from(document.querySelectorAll("[data-project-path]"), (element) => typeof element.dataset.projectPath === "string" && element.dataset.projectPath.startsWith("/tmp/ch-el-") && element.dataset.projectPath.endsWith("/workspace")),
              projectFeedback: document.querySelector("[data-project-feedback]")?.textContent,
              projectSubmitted: window.__codexHarnessProjectSmokeSubmitted === true,
              projectSelected: document.querySelector("[data-project-selected]") !== null,
              projectRouting: Array.from(document.querySelectorAll("[data-project-routing]"), (element) => element.dataset.projectRouting),
              projectRoutingButtonDisabled: document.querySelector("[data-project-routing-bind]")?.disabled,
              bindingSubmitted: window.__codexHarnessBindingSmokeSubmitted === true,
              taskCatalogStatus: taskPanel?.dataset.taskCatalogStatus,
              taskCount: taskPanel?.dataset.taskCount,
              taskProject: taskPanel?.dataset.taskProject,
              taskTitles: Array.from(document.querySelectorAll("[data-task-id] strong"), (element) => element.textContent),
              taskObjectives: Array.from(document.querySelectorAll("[data-task-id] p"), (element) => element.textContent),
              taskStages: Array.from(document.querySelectorAll("[data-task-stage]"), (element) => element.dataset.taskStage),
              taskFeedback: document.querySelector("[data-task-feedback]")?.textContent,
              taskCreateDisabled: document.querySelector("[data-task-create]")?.disabled,
              taskSubmitted: window.__codexHarnessTaskSmokeSubmitted === true,
              taskDetailStatus: taskDetail?.dataset.taskDetailStatus,
              taskVersion: taskDetail?.dataset.taskVersion,
              taskRequirementRevision: taskDetail?.dataset.taskRequirementRevision,
              taskRevisionStatus: taskDetail?.dataset.taskRevisionStatus,
              taskRevisionSourceMatches: document.querySelector("[data-task-revision-source]")?.value === revisedTaskSource,
              taskRevisionSubmitted: window.__codexHarnessTaskRevisionSmokeSubmitted === true,
              containsSensitiveText: ["private@example.com", "must-not-survive", "snapshotId", "workerSessionId", "nextCursor", "id-smoke"].some((value) => text.includes(value))
            };
          })()`,
            true,
          )) as {
            documentReadyState?: unknown;
            rootChildCount?: unknown;
            scriptCount?: unknown;
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
            routingSaveDisabled?: unknown;
            routingSubmitted?: unknown;
            projectCount?: unknown;
            projectIdentity?: unknown;
            projectPathShape?: unknown;
            projectFeedback?: unknown;
            projectSubmitted?: unknown;
            projectSelected?: unknown;
            projectRouting?: unknown;
            projectRoutingButtonDisabled?: unknown;
            bindingSubmitted?: unknown;
            taskCatalogStatus?: unknown;
            taskCount?: unknown;
            taskProject?: unknown;
            taskTitles?: unknown;
            taskObjectives?: unknown;
            taskStages?: unknown;
            taskFeedback?: unknown;
            taskCreateDisabled?: unknown;
            taskSubmitted?: unknown;
            taskDetailStatus?: unknown;
            taskVersion?: unknown;
            taskRequirementRevision?: unknown;
            taskRevisionStatus?: unknown;
            taskRevisionSourceMatches?: unknown;
            taskRevisionSubmitted?: unknown;
            containsSensitiveText?: unknown;
          };
          lastRendererProgress = Object.freeze({
            documentReadyState: rendered.documentReadyState,
            rootChildCount: rendered.rootChildCount,
            scriptCount: rendered.scriptCount,
            phase: rendered.phase,
            routingConfigured: rendered.routingConfigured,
            routingRevision: rendered.routingRevision,
            routingModels: rendered.routingModels,
            routingEfforts: rendered.routingEfforts,
            routingAvailability: rendered.routingAvailability,
            routingFeedback: rendered.routingFeedback,
            routingSaveDisabled: rendered.routingSaveDisabled,
            routingSubmitted: rendered.routingSubmitted,
            projectCount: rendered.projectCount,
            projectIdentity: rendered.projectIdentity,
            projectPathShape: rendered.projectPathShape,
            projectFeedback: rendered.projectFeedback,
            projectSubmitted: rendered.projectSubmitted,
            projectSelected: rendered.projectSelected,
            projectRouting: rendered.projectRouting,
            projectRoutingButtonDisabled: rendered.projectRoutingButtonDisabled,
            bindingSubmitted: rendered.bindingSubmitted,
            taskCatalogStatus: rendered.taskCatalogStatus,
            taskCount: rendered.taskCount,
            taskProject: rendered.taskProject,
            taskStages: rendered.taskStages,
            taskFeedback: rendered.taskFeedback,
            taskCreateDisabled: rendered.taskCreateDisabled,
            taskSubmitted: rendered.taskSubmitted,
            taskDetailStatus: rendered.taskDetailStatus,
            taskVersion: rendered.taskVersion,
            taskRequirementRevision: rendered.taskRequirementRevision,
            taskRevisionStatus: rendered.taskRevisionStatus,
            taskRevisionSourceMatches: rendered.taskRevisionSourceMatches,
            taskRevisionSubmitted: rendered.taskRevisionSubmitted,
          });
          if (
            routingMode === "configure" &&
            rendered.routingConfigured === "false" &&
            !routingSmokeDraftMatches(rendered.routingModels, rendered.routingEfforts)
          ) {
            routingFormDriven = false;
          }
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
                routingSmokeDraftMatches(rendered.routingModels, rendered.routingEfforts) &&
                Array.isArray(rendered.routingAvailability) &&
                rendered.routingAvailability.every((status) => status === "observed_available") &&
                (routingMode !== "configure" ||
                  rendered.routingFeedback === "配置已持久化；实际执行仍未开放。")));
          const projectObserved =
            expected === "ready" &&
            (projectMode === undefined ||
              (rendered.projectCount === "1" &&
                Array.isArray(rendered.projectIdentity) &&
                rendered.projectIdentity.length === 1 &&
                rendered.projectIdentity[0] === "unverified" &&
                Array.isArray(rendered.projectPathShape) &&
                rendered.projectPathShape.length === 1 &&
                rendered.projectPathShape[0] === true &&
                (projectMode !== "register" ||
                  (rendered.projectSubmitted === true &&
                    rendered.projectSelected === true &&
                    (bindingMode === "bind" ||
                      rendered.projectFeedback === "工作区已持久化；Task 与执行仍未开放。")))));
          const bindingObserved =
            expected === "ready" &&
            (bindingMode === undefined ||
              (Array.isArray(rendered.projectRouting) &&
                rendered.projectRouting.length === 1 &&
                rendered.projectRouting[0] === "default_bound" &&
                rendered.projectRoutingButtonDisabled === true &&
                (bindingMode !== "bind" ||
                  (rendered.bindingSubmitted === true &&
                    rendered.projectFeedback === "Project 已绑定默认路由；执行权限仍未开放。"))));
          const taskObserved =
            expected === "ready" &&
            (taskMode === undefined ||
              (rendered.taskCatalogStatus === "loaded" &&
                rendered.taskCount === "1" &&
                typeof rendered.taskProject === "string" &&
                rendered.taskProject.length > 0 &&
                Array.isArray(rendered.taskTitles) &&
                rendered.taskTitles.length === 1 &&
                rendered.taskTitles[0] === TASK_SMOKE_DRAFT.title &&
                Array.isArray(rendered.taskObjectives) &&
                rendered.taskObjectives.length === 1 &&
                rendered.taskObjectives[0] === TASK_SMOKE_REVISED_SOURCE &&
                Array.isArray(rendered.taskStages) &&
                rendered.taskStages.length === 1 &&
                rendered.taskStages[0] === "requirements_only" &&
                rendered.taskCreateDisabled === true &&
                rendered.taskDetailStatus === "loaded" &&
                rendered.taskVersion === "2" &&
                rendered.taskRequirementRevision === "2" &&
                rendered.taskRevisionSourceMatches === true &&
                (taskMode !== "create_revise" ||
                  (rendered.taskSubmitted === true &&
                    rendered.taskRevisionSubmitted === true &&
                    rendered.taskRevisionStatus === "revised"))));
          if (
            rendered.phase === expected &&
            (expected !== "failed" ||
              (typeof rendered.code === "string" && rendered.code.length > 0)) &&
            (expected !== "ready" ||
              (accountObserved &&
                modelCatalogObserved &&
                routingObserved &&
                projectObserved &&
                bindingObserved &&
                taskObserved))
          ) {
            finished = true;
            clearTimeout(timeout);
            process.stdout.write(
              `desktop-smoke:${JSON.stringify({ phase: rendered.phase, ...(rendered.code === undefined ? {} : { code: rendered.code }), ...(expected === "ready" ? { accountObserved: true, modelCatalogObserved: true, routingObserved: true, projectObserved: true, bindingObserved: true, taskObserved: true } : {}) })}\n`,
            );
            app.quit();
            return;
          }
        } catch {
          // The document may still be loading; the bounded loop retries the fixed observation.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      inspecting = false;
    }
  };
  stateStore.subscribe((state) => {
    void inspect(state);
  });
  window.webContents.once("did-finish-load", () => {
    void window.webContents
      .executeJavaScript(
        `new Promise((resolve) => {
          const root = document.querySelector("#root");
          if (!(root instanceof HTMLElement)) {
            resolve(false);
            return;
          }
          if (root.childElementCount > 0) {
            resolve(true);
            return;
          }
          const observer = new MutationObserver(() => {
            if (root.childElementCount > 0) {
              clearTimeout(timer);
              observer.disconnect();
              resolve(true);
            }
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            resolve(false);
          }, 10_000);
          observer.observe(root, { childList: true });
        })`,
        true,
      )
      .then((mounted: unknown) => {
        if (mounted === true) {
          rendererLoaded = true;
          void inspect(stateStore.current);
          return;
        }
        lastRendererProgress = Object.freeze({ phase: "renderer_mount_timeout" });
      })
      .catch(() => {
        lastRendererProgress = Object.freeze({ phase: "renderer_mount_observation_failed" });
      });
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
