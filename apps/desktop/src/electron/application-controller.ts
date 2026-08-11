import { randomUUID } from "node:crypto";

import {
  DaemonProcessSupervisorError,
  type DaemonProcessSupervisor,
} from "../main/daemon-process-supervisor.js";
import {
  HarnessRpcClientError,
  type HarnessAccountStatusChangedEvent,
} from "../main/harness-rpc-client.js";
import {
  failedBootstrapState,
  decodeDesktopProjectRoutingBindingProjectId,
  decodeDesktopProjectTaskCreation,
  decodeDesktopProjectTaskCandidatePlanConfirmation,
  decodeDesktopProjectTaskCandidatePlanGeneration,
  decodeDesktopProjectTaskGraphMaterialization,
  decodeDesktopProjectTaskRequirementRevision,
  decodeDesktopProjectTaskSelection,
  decodeDesktopRoutingConfigurationUpdate,
  decodeDesktopProjectWorkspaceRegistration,
  projectDesktopModelCatalogSummary,
  projectDesktopProjectCatalog,
  projectDesktopProjectRegistration,
  projectDesktopProjectRoutingBindings,
  projectDesktopProjectTaskCatalog,
  projectDesktopProjectTaskDetail,
  projectDesktopRoutingConfiguration,
  readyBootstrapState,
  type BootstrapStateStore,
  type DesktopBootstrapFailureCode,
  type DesktopRoutingConfigurationMutationResult,
  type DesktopProjectSelectionResult,
  type DesktopProjectRoutingBindingMutationResult,
  type DesktopProjectTaskCatalogResult,
  type DesktopProjectTaskCandidatePlanConfirmationResult,
  type DesktopProjectTaskCandidatePlanMutationResult,
  type DesktopProjectTaskDetailResult,
  type DesktopProjectTaskGraphMaterializationResult,
  type DesktopProjectTaskMutationResult,
  type DesktopProjectTaskRequirementMutationResult,
} from "../shared/bootstrap-state.js";
import { DesktopRuntimeResourceError, DesktopRuntimeRootError } from "./runtime-resources.js";

export type DesktopSupervisorHandle = Pick<
  DaemonProcessSupervisor,
  | "closed"
  | "readAccountStatusObservation"
  | "readModelCatalogPage"
  | "readProjectCatalogPage"
  | "registerProject"
  | "readProjectRoutingBindingStatuses"
  | "bindProjectDefaultRouting"
  | "readProjectTaskCatalogPage"
  | "createProjectTask"
  | "readProjectTaskDetail"
  | "reviseProjectTaskRequirement"
  | "readRoutingConfiguration"
  | "setRoutingConfiguration"
  | "stop"
> &
  Partial<
    Pick<
      DaemonProcessSupervisor,
      | "confirmProjectTaskCandidatePlan"
      | "generateProjectTaskCandidatePlan"
      | "materializeProjectTaskGraph"
    >
  >;

export type DesktopApplicationControllerConfig = Readonly<{
  stateStore: BootstrapStateStore;
  createSupervisor: (
    onAccountStatusChanged: (event: HarnessAccountStatusChangedEvent) => void,
  ) => Promise<DesktopSupervisorHandle>;
}>;

export class DesktopApplicationController {
  readonly #stateStore: BootstrapStateStore;
  readonly #createSupervisor: DesktopApplicationControllerConfig["createSupervisor"];
  #pendingAccountStatusEvent: HarnessAccountStatusChangedEvent | undefined;
  #supervisor: DesktopSupervisorHandle | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<number> | undefined;

  constructor(config: DesktopApplicationControllerConfig) {
    this.#stateStore = config.stateStore;
    this.#createSupervisor = config.createSupervisor;
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  stop(): Promise<number> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async setRoutingConfiguration(
    input: unknown,
  ): Promise<DesktopRoutingConfigurationMutationResult> {
    const update = decodeDesktopRoutingConfigurationUpdate(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (update === undefined || state.phase !== "ready" || supervisor === undefined) {
      return Object.freeze({ status: "unavailable" });
    }
    try {
      const routing = projectDesktopRoutingConfiguration(
        await supervisor.setRoutingConfiguration({ commandId: randomUUID(), ...update }),
      );
      const current = this.#stateStore.current;
      if (current.phase !== "ready") {
        return Object.freeze({ status: "unavailable" });
      }
      this.#stateStore.transition(
        readyBootstrapState(
          current.account,
          current.catalog,
          routing,
          current.projects,
          current.projectRoutingBindings,
        ),
      );
      return Object.freeze({ status: "saved", routing });
    } catch (error: unknown) {
      if (!(error instanceof HarnessRpcClientError) || error.remoteCode !== "rpc.conflict") {
        return Object.freeze({ status: "unavailable" });
      }
      try {
        const routing = projectDesktopRoutingConfiguration(
          await supervisor.readRoutingConfiguration(),
        );
        const current = this.#stateStore.current;
        if (current.phase !== "ready") {
          return Object.freeze({ status: "unavailable" });
        }
        this.#stateStore.transition(
          readyBootstrapState(
            current.account,
            current.catalog,
            routing,
            current.projects,
            current.projectRoutingBindings,
          ),
        );
        return Object.freeze({ status: "conflict", routing });
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    }
  }

  async registerProjectWorkspace(input: unknown): Promise<DesktopProjectSelectionResult> {
    const registration = decodeDesktopProjectWorkspaceRegistration(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (registration === undefined || state.phase !== "ready" || supervisor === undefined) {
      return Object.freeze({ status: "unavailable" });
    }
    try {
      const selected = projectDesktopProjectRegistration(
        await supervisor.registerProject({
          commandId: randomUUID(),
          projectId: randomUUID(),
          ...registration,
        }),
      );
      const projects = projectDesktopProjectCatalog(
        await supervisor.readProjectCatalogPage({ cursor: null, limit: 12 }),
      );
      const projectRoutingBindings = projectDesktopProjectRoutingBindings(
        await supervisor.readProjectRoutingBindingStatuses({
          projectIds: projects.projects.map((project) => project.projectId),
        }),
        projects.projects.map((project) => project.projectId),
      );
      const current = this.#stateStore.current;
      if (current.phase !== "ready") {
        return Object.freeze({ status: "unavailable" });
      }
      this.#stateStore.transition(
        readyBootstrapState(
          current.account,
          current.catalog,
          current.routing,
          projects,
          projectRoutingBindings,
        ),
      );
      return Object.freeze({
        status: "selected",
        registrationStatus: selected.registrationStatus,
        project: selected.project,
        projects,
      });
    } catch {
      return Object.freeze({ status: "unavailable" });
    }
  }

  async bindProjectToDefaultRouting(
    input: unknown,
  ): Promise<DesktopProjectRoutingBindingMutationResult> {
    const projectId = decodeDesktopProjectRoutingBindingProjectId(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (
      projectId === undefined ||
      state.phase !== "ready" ||
      supervisor === undefined ||
      !state.projects.projects.some((project) => project.projectId === projectId)
    ) {
      return Object.freeze({ status: "unavailable" });
    }

    try {
      const [routingInput, bindingInput] = await Promise.all([
        supervisor.readRoutingConfiguration(),
        supervisor.readProjectRoutingBindingStatuses({ projectIds: [projectId] }),
      ]);
      const routing = projectDesktopRoutingConfiguration(routingInput);
      const projectedBinding = projectDesktopProjectRoutingBindings(bindingInput, [projectId]);
      if (!routing.configured || routing.configurationRevisionId === null) {
        return Object.freeze({ status: "routing_unconfigured" });
      }
      const rawBinding = bindingInput.statuses[0];
      const visibleBinding = projectedBinding.bindings[0];
      if (rawBinding === undefined || visibleBinding === undefined) {
        return Object.freeze({ status: "unavailable" });
      }

      const result = await supervisor.bindProjectDefaultRouting({
        commandId: randomUUID(),
        projectId,
        expectedBindingVersion: visibleBinding.bindingVersion ?? 0,
        previousProfileId: rawBinding.binding?.profileId ?? null,
        expectedProfileVersion: routing.profileVersion,
        expectedConfigurationRevisionId: routing.configurationRevisionId,
      });
      if (
        (result.status !== "bound" && result.status !== "existing") ||
        result.binding.projectId !== projectId ||
        result.binding.profileVersionAtBinding !== routing.profileVersion ||
        result.binding.configurationRevisionIdAtBinding !== routing.configurationRevisionId ||
        result.binding.bindingVersion !==
          (result.status === "bound"
            ? (visibleBinding.bindingVersion ?? 0) + 1
            : visibleBinding.bindingVersion)
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      const refreshed = await this.#refreshProjectsAndBindings(supervisor);
      const refreshedBinding = refreshed.projectRoutingBindings.bindings.find(
        (binding) => binding.projectId === projectId,
      );
      if (
        refreshedBinding?.status !== "default_bound" ||
        refreshedBinding.bindingVersion !== result.binding.bindingVersion
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      const current = this.#stateStore.current;
      if (current.phase !== "ready") {
        return Object.freeze({ status: "unavailable" });
      }
      this.#stateStore.transition(
        readyBootstrapState(
          current.account,
          current.catalog,
          current.routing,
          refreshed.projects,
          refreshed.projectRoutingBindings,
        ),
      );
      return Object.freeze({ status: result.status });
    } catch (error: unknown) {
      if (!(error instanceof HarnessRpcClientError) || error.remoteCode !== "rpc.conflict") {
        return Object.freeze({ status: "unavailable" });
      }
      try {
        const [routing, refreshed] = await Promise.all([
          supervisor.readRoutingConfiguration().then(projectDesktopRoutingConfiguration),
          this.#refreshProjectsAndBindings(supervisor),
        ]);
        const current = this.#stateStore.current;
        if (current.phase !== "ready") {
          return Object.freeze({ status: "unavailable" });
        }
        this.#stateStore.transition(
          readyBootstrapState(
            current.account,
            current.catalog,
            routing,
            refreshed.projects,
            refreshed.projectRoutingBindings,
          ),
        );
        return Object.freeze({ status: "conflict" });
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    }
  }

  async readProjectTaskCatalog(input: unknown): Promise<DesktopProjectTaskCatalogResult> {
    const projectId = decodeDesktopProjectRoutingBindingProjectId(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (
      projectId === undefined ||
      state.phase !== "ready" ||
      supervisor === undefined ||
      !state.projects.projects.some((project) => project.projectId === projectId)
    ) {
      return Object.freeze({ status: "unavailable" });
    }
    try {
      const catalog = projectDesktopProjectTaskCatalog(
        await supervisor.readProjectTaskCatalogPage({ projectId, cursor: null, limit: 12 }),
        projectId,
      );
      return this.#stateStore.current.phase === "ready"
        ? Object.freeze({ status: "loaded", catalog })
        : Object.freeze({ status: "unavailable" });
    } catch {
      return Object.freeze({ status: "unavailable" });
    }
  }

  async createProjectTask(input: unknown): Promise<DesktopProjectTaskMutationResult> {
    const creation = decodeDesktopProjectTaskCreation(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (creation === undefined || state.phase !== "ready" || supervisor === undefined) {
      return Object.freeze({ status: "unavailable" });
    }
    const project = state.projects.projects.find(
      (candidate) => candidate.projectId === creation.projectId,
    );
    const binding = state.projectRoutingBindings.bindings.find(
      (candidate) => candidate.projectId === creation.projectId,
    );
    if (project === undefined || binding === undefined) {
      return Object.freeze({ status: "unavailable" });
    }
    if (binding.status !== "default_bound" || binding.bindingVersion === null) {
      return Object.freeze({ status: "routing_unbound" });
    }

    const taskId = randomUUID();
    try {
      const result = await supervisor.createProjectTask({
        commandId: randomUUID(),
        ownershipCommandId: randomUUID(),
        taskId,
        projectId: project.projectId,
        expectedProjectVersion: project.projectVersion,
        expectedRoutingBindingVersion: binding.bindingVersion,
        title: creation.title,
        sourceText: creation.sourceText,
      });
      if (
        (result.status !== "created" && result.status !== "existing") ||
        result.taskId !== taskId ||
        this.#stateStore.current.phase !== "ready"
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      const catalog = projectDesktopProjectTaskCatalog(
        await supervisor.readProjectTaskCatalogPage({
          projectId: project.projectId,
          cursor: null,
          limit: 12,
        }),
        project.projectId,
      );
      return this.#stateStore.current.phase === "ready"
        ? Object.freeze({ status: result.status, taskId, catalog })
        : Object.freeze({ status: "unavailable" });
    } catch (error: unknown) {
      if (!(error instanceof HarnessRpcClientError) || error.remoteCode !== "rpc.conflict") {
        return Object.freeze({ status: "unavailable" });
      }
      try {
        const refreshed = await this.#refreshProjectsAndBindings(supervisor);
        const current = this.#stateStore.current;
        if (current.phase !== "ready") {
          return Object.freeze({ status: "unavailable" });
        }
        this.#stateStore.transition(
          readyBootstrapState(
            current.account,
            current.catalog,
            current.routing,
            refreshed.projects,
            refreshed.projectRoutingBindings,
          ),
        );
        return Object.freeze({ status: "conflict" });
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    }
  }

  async readProjectTaskDetail(input: unknown): Promise<DesktopProjectTaskDetailResult> {
    const selection = decodeDesktopProjectTaskSelection(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (
      selection === undefined ||
      state.phase !== "ready" ||
      supervisor === undefined ||
      !state.projects.projects.some((project) => project.projectId === selection.projectId)
    ) {
      return Object.freeze({ status: "unavailable" });
    }
    try {
      const detail = projectDesktopProjectTaskDetail(
        await supervisor.readProjectTaskDetail(selection),
        selection.projectId,
        selection.taskId,
      );
      return this.#stateStore.current.phase === "ready"
        ? Object.freeze({ status: "loaded", detail })
        : Object.freeze({ status: "unavailable" });
    } catch {
      return Object.freeze({ status: "unavailable" });
    }
  }

  async generateProjectTaskCandidatePlan(
    input: unknown,
  ): Promise<DesktopProjectTaskCandidatePlanMutationResult> {
    const generation = decodeDesktopProjectTaskCandidatePlanGeneration(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    const project =
      generation === undefined || state.phase !== "ready"
        ? undefined
        : state.projects.projects.find((candidate) => candidate.projectId === generation.projectId);
    const binding =
      generation === undefined || state.phase !== "ready"
        ? undefined
        : state.projectRoutingBindings.bindings.find(
            (candidate) => candidate.projectId === generation.projectId,
          );
    if (
      generation === undefined ||
      state.phase !== "ready" ||
      supervisor === undefined ||
      typeof supervisor.generateProjectTaskCandidatePlan !== "function" ||
      project === undefined ||
      binding?.status !== "default_bound" ||
      binding.bindingVersion === null ||
      !state.routing.configured ||
      state.routing.configurationRevisionId === null ||
      state.routing.availability?.deep !== "observed_available"
    ) {
      return Object.freeze({ status: "unavailable" });
    }

    try {
      const current = await supervisor.readProjectTaskDetail({
        projectId: generation.projectId,
        taskId: generation.taskId,
      });
      projectDesktopProjectTaskDetail(current, generation.projectId, generation.taskId);
      if (current.taskVersion !== generation.expectedTaskVersion) {
        return Object.freeze({ status: "conflict" });
      }
      const result = await supervisor.generateProjectTaskCandidatePlan({
        commandId: randomUUID(),
        projectId: generation.projectId,
        taskId: generation.taskId,
        expectedProjectVersion: project.projectVersion,
        expectedTaskVersion: current.taskVersion,
        expectedOwnershipVersion: current.ownershipVersion,
        previousRequirementRevisionId: current.activeRequirement.revisionId,
        previousPlanRevisionId: current.latestPlanRevisionId,
        expectedRoutingBindingVersion: binding.bindingVersion,
        expectedProfileVersion: state.routing.profileVersion,
        expectedConfigurationRevisionId: state.routing.configurationRevisionId,
      });
      if (
        (result.status !== "generated" && result.status !== "existing") ||
        result.taskId !== generation.taskId ||
        this.#stateStore.current.phase !== "ready"
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      const [rawDetail, rawCatalog] = await Promise.all([
        supervisor.readProjectTaskDetail({
          projectId: generation.projectId,
          taskId: generation.taskId,
        }),
        supervisor.readProjectTaskCatalogPage({
          projectId: generation.projectId,
          cursor: null,
          limit: 12,
        }),
      ]);
      const detail = projectDesktopProjectTaskDetail(
        rawDetail,
        generation.projectId,
        generation.taskId,
      );
      const catalog = projectDesktopProjectTaskCatalog(rawCatalog, generation.projectId);
      return this.#stateStore.current.phase === "ready"
        ? Object.freeze({ status: result.status, taskId: result.taskId, detail, catalog })
        : Object.freeze({ status: "unavailable" });
    } catch (error: unknown) {
      return error instanceof HarnessRpcClientError && error.remoteCode === "rpc.conflict"
        ? Object.freeze({ status: "conflict" })
        : Object.freeze({ status: "unavailable" });
    }
  }

  async confirmProjectTaskCandidatePlan(
    input: unknown,
  ): Promise<DesktopProjectTaskCandidatePlanConfirmationResult> {
    const confirmation = decodeDesktopProjectTaskCandidatePlanConfirmation(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (
      confirmation === undefined ||
      state.phase !== "ready" ||
      supervisor === undefined ||
      typeof supervisor.confirmProjectTaskCandidatePlan !== "function" ||
      !state.projects.projects.some((project) => project.projectId === confirmation.projectId)
    ) {
      return Object.freeze({ status: "unavailable" });
    }

    try {
      const current = await supervisor.readProjectTaskDetail({
        projectId: confirmation.projectId,
        taskId: confirmation.taskId,
      });
      projectDesktopProjectTaskDetail(current, confirmation.projectId, confirmation.taskId);
      if (
        current.taskVersion !== confirmation.expectedTaskVersion ||
        current.candidatePlan === null ||
        current.candidatePlan.revisionNumber !== confirmation.candidatePlanRevisionNumber
      ) {
        return Object.freeze({ status: "conflict" });
      }
      const result = await supervisor.confirmProjectTaskCandidatePlan({
        commandId: randomUUID(),
        projectId: confirmation.projectId,
        taskId: confirmation.taskId,
        expectedTaskVersion: current.taskVersion,
        expectedOwnershipVersion: current.ownershipVersion,
        previousRequirementRevisionId: current.activeRequirement.revisionId,
        candidatePlanRevisionId: current.candidatePlan.revisionId,
      });
      if (
        (result.status !== "confirmed" && result.status !== "existing") ||
        result.taskId !== confirmation.taskId ||
        this.#stateStore.current.phase !== "ready"
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      const [rawDetail, rawCatalog] = await Promise.all([
        supervisor.readProjectTaskDetail({
          projectId: confirmation.projectId,
          taskId: confirmation.taskId,
        }),
        supervisor.readProjectTaskCatalogPage({
          projectId: confirmation.projectId,
          cursor: null,
          limit: 12,
        }),
      ]);
      const detail = projectDesktopProjectTaskDetail(
        rawDetail,
        confirmation.projectId,
        confirmation.taskId,
      );
      const catalog = projectDesktopProjectTaskCatalog(rawCatalog, confirmation.projectId);
      if (
        detail.stage !== "confirmed_plan" ||
        detail.candidatePlan !== null ||
        detail.confirmedPlan === null
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      return this.#stateStore.current.phase === "ready"
        ? Object.freeze({ status: result.status, taskId: result.taskId, detail, catalog })
        : Object.freeze({ status: "unavailable" });
    } catch (error: unknown) {
      return error instanceof HarnessRpcClientError && error.remoteCode === "rpc.conflict"
        ? Object.freeze({ status: "conflict" })
        : Object.freeze({ status: "unavailable" });
    }
  }

  async materializeProjectTaskGraph(
    input: unknown,
  ): Promise<DesktopProjectTaskGraphMaterializationResult> {
    const materialization = decodeDesktopProjectTaskGraphMaterialization(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (
      materialization === undefined ||
      state.phase !== "ready" ||
      supervisor === undefined ||
      typeof supervisor.materializeProjectTaskGraph !== "function" ||
      !state.projects.projects.some((project) => project.projectId === materialization.projectId)
    ) {
      return Object.freeze({ status: "unavailable" });
    }

    try {
      const current = await supervisor.readProjectTaskDetail({
        projectId: materialization.projectId,
        taskId: materialization.taskId,
      });
      projectDesktopProjectTaskDetail(current, materialization.projectId, materialization.taskId);
      if (
        current.taskVersion !== materialization.expectedTaskVersion ||
        current.stage !== "confirmed_plan" ||
        current.candidatePlan !== null ||
        current.confirmedPlan === null ||
        current.confirmedPlan.revisionNumber !== materialization.confirmedPlanRevisionNumber ||
        current.activeGraph !== null
      ) {
        return Object.freeze({ status: "conflict" });
      }
      const result = await supervisor.materializeProjectTaskGraph({
        commandId: randomUUID(),
        projectId: materialization.projectId,
        taskId: materialization.taskId,
        expectedTaskVersion: current.taskVersion,
        expectedOwnershipVersion: current.ownershipVersion,
        previousRequirementRevisionId: current.activeRequirement.revisionId,
        confirmedPlanRevisionId: current.confirmedPlan.revisionId,
        previousGraphRevisionId: null,
      });
      if (
        (result.status !== "materialized" && result.status !== "existing") ||
        result.taskId !== materialization.taskId ||
        this.#stateStore.current.phase !== "ready"
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      const [rawDetail, rawCatalog] = await Promise.all([
        supervisor.readProjectTaskDetail({
          projectId: materialization.projectId,
          taskId: materialization.taskId,
        }),
        supervisor.readProjectTaskCatalogPage({
          projectId: materialization.projectId,
          cursor: null,
          limit: 12,
        }),
      ]);
      const detail = projectDesktopProjectTaskDetail(
        rawDetail,
        materialization.projectId,
        materialization.taskId,
      );
      const catalog = projectDesktopProjectTaskCatalog(rawCatalog, materialization.projectId);
      if (
        detail.stage !== "active_graph" ||
        detail.candidatePlan !== null ||
        detail.confirmedPlan === null ||
        detail.activeGraph === null
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      return this.#stateStore.current.phase === "ready"
        ? Object.freeze({ status: result.status, taskId: result.taskId, detail, catalog })
        : Object.freeze({ status: "unavailable" });
    } catch (error: unknown) {
      return error instanceof HarnessRpcClientError && error.remoteCode === "rpc.conflict"
        ? Object.freeze({ status: "conflict" })
        : Object.freeze({ status: "unavailable" });
    }
  }

  async reviseProjectTaskRequirement(
    input: unknown,
  ): Promise<DesktopProjectTaskRequirementMutationResult> {
    const revision = decodeDesktopProjectTaskRequirementRevision(input);
    const state = this.#stateStore.current;
    const supervisor = this.#supervisor;
    if (
      revision === undefined ||
      state.phase !== "ready" ||
      supervisor === undefined ||
      !state.projects.projects.some((project) => project.projectId === revision.projectId)
    ) {
      return Object.freeze({ status: "unavailable" });
    }

    try {
      const current = await supervisor.readProjectTaskDetail({
        projectId: revision.projectId,
        taskId: revision.taskId,
      });
      projectDesktopProjectTaskDetail(current, revision.projectId, revision.taskId);
      if (current.taskVersion !== revision.expectedTaskVersion) {
        return Object.freeze({ status: "conflict" });
      }
      const result = await supervisor.reviseProjectTaskRequirement({
        commandId: randomUUID(),
        projectId: revision.projectId,
        taskId: revision.taskId,
        expectedTaskVersion: current.taskVersion,
        expectedOwnershipVersion: current.ownershipVersion,
        previousRequirementRevisionId: current.activeRequirement.revisionId,
        sourceText: revision.sourceText,
      });
      if (
        (result.status !== "revised" && result.status !== "existing") ||
        result.taskId !== revision.taskId ||
        this.#stateStore.current.phase !== "ready"
      ) {
        return Object.freeze({ status: "unavailable" });
      }
      const [rawDetail, rawCatalog] = await Promise.all([
        supervisor.readProjectTaskDetail({
          projectId: revision.projectId,
          taskId: revision.taskId,
        }),
        supervisor.readProjectTaskCatalogPage({
          projectId: revision.projectId,
          cursor: null,
          limit: 12,
        }),
      ]);
      const detail = projectDesktopProjectTaskDetail(
        rawDetail,
        revision.projectId,
        revision.taskId,
      );
      const catalog = projectDesktopProjectTaskCatalog(rawCatalog, revision.projectId);
      return this.#stateStore.current.phase === "ready"
        ? Object.freeze({ status: result.status, taskId: result.taskId, detail, catalog })
        : Object.freeze({ status: "unavailable" });
    } catch (error: unknown) {
      return error instanceof HarnessRpcClientError && error.remoteCode === "rpc.conflict"
        ? Object.freeze({ status: "conflict" })
        : Object.freeze({ status: "unavailable" });
    }
  }

  async #start(): Promise<void> {
    try {
      const supervisor = await this.#createSupervisor((event) =>
        this.#observeAccountStatusChanged(event),
      );
      this.#supervisor = supervisor;
      void supervisor.closed.then(() => {
        if (this.#stateStore.current.phase === "ready") {
          this.#stateStore.transition(failedBootstrapState("daemon_unavailable"));
        }
      });
      if (this.#isStopping()) {
        return;
      }
      const [observation, catalogPage, routingConfiguration, projectCatalogPage] =
        await Promise.all([
          supervisor.readAccountStatusObservation(),
          supervisor.readModelCatalogPage({ cursor: null, limit: 12 }),
          supervisor.readRoutingConfiguration(),
          supervisor.readProjectCatalogPage({ cursor: null, limit: 12 }),
        ]);
      if (this.#isStopping()) {
        return;
      }
      const projects = projectDesktopProjectCatalog(projectCatalogPage);
      const projectRoutingBindings = projectDesktopProjectRoutingBindings(
        await supervisor.readProjectRoutingBindingStatuses({
          projectIds: projects.projects.map((project) => project.projectId),
        }),
        projects.projects.map((project) => project.projectId),
      );
      if (this.#isStopping()) {
        return;
      }
      const pending = this.#pendingAccountStatusEvent;
      this.#pendingAccountStatusEvent = undefined;
      const accountStatus =
        pending !== undefined && pending.sequence > observation.observedThroughSequence
          ? pending.account
          : observation.account;
      this.#stateStore.transition(
        readyBootstrapState(
          accountStatus,
          projectDesktopModelCatalogSummary(catalogPage),
          projectDesktopRoutingConfiguration(routingConfiguration),
          projects,
          projectRoutingBindings,
        ),
      );
    } catch (error: unknown) {
      if (this.#stateStore.current.phase !== "stopping") {
        try {
          await this.#supervisor?.stop();
        } catch {
          // Startup already failed; shutdown errors must not replace the stable startup code.
        }
        this.#stateStore.transition(failedBootstrapState(mapBootstrapFailure(error)));
      }
    }
  }

  async #stop(): Promise<number> {
    if (this.#stateStore.current.phase !== "stopping") {
      this.#stateStore.transition(Object.freeze({ phase: "stopping" }));
    }
    await (this.#startPromise ?? Promise.resolve());
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      return 0;
    }
    try {
      const result = await supervisor.stop();
      return result.containment === "containment_unknown" ? 1 : 0;
    } catch {
      return 1;
    }
  }

  #isStopping(): boolean {
    return this.#stateStore.current.phase === "stopping";
  }

  #observeAccountStatusChanged(event: HarnessAccountStatusChangedEvent): void {
    const state = this.#stateStore.current;
    if (state.phase === "starting") {
      const pending = this.#pendingAccountStatusEvent;
      if (pending === undefined || event.sequence > pending.sequence) {
        this.#pendingAccountStatusEvent = event;
      }
      return;
    }
    if (state.phase === "ready") {
      this.#stateStore.transition(
        readyBootstrapState(
          event.account,
          state.catalog,
          state.routing,
          state.projects,
          state.projectRoutingBindings,
        ),
      );
    }
  }

  async #refreshProjectsAndBindings(supervisor: DesktopSupervisorHandle): Promise<
    Readonly<{
      projects: ReturnType<typeof projectDesktopProjectCatalog>;
      projectRoutingBindings: ReturnType<typeof projectDesktopProjectRoutingBindings>;
    }>
  > {
    const projects = projectDesktopProjectCatalog(
      await supervisor.readProjectCatalogPage({ cursor: null, limit: 12 }),
    );
    const projectIds = projects.projects.map((project) => project.projectId);
    const projectRoutingBindings = projectDesktopProjectRoutingBindings(
      await supervisor.readProjectRoutingBindingStatuses({ projectIds }),
      projectIds,
    );
    return Object.freeze({ projects, projectRoutingBindings });
  }
}

export function mapBootstrapFailure(error: unknown): DesktopBootstrapFailureCode {
  if (error instanceof DesktopRuntimeResourceError || error instanceof DesktopRuntimeRootError) {
    return error.code;
  }
  if (error instanceof DaemonProcessSupervisorError) {
    if (error.code === "unsupported_platform") {
      return "unsupported_platform";
    }
    if (error.code === "runtime_root_insecure") {
      return "runtime_root_insecure";
    }
    return "daemon_startup_failed";
  }
  if (error instanceof HarnessRpcClientError) {
    return "daemon_startup_failed";
  }
  return "internal_error";
}
