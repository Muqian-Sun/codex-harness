import type {
  DesktopBootstrapState,
  DesktopProjectSelectionResult,
  DesktopProjectRoutingBindingMutationResult,
  DesktopProjectTaskCatalogResult,
  DesktopProjectTaskCandidatePlanGeneration,
  DesktopProjectTaskCandidatePlanMutationResult,
  DesktopProjectTaskCreation,
  DesktopProjectTaskDetailResult,
  DesktopProjectTaskMutationResult,
  DesktopProjectTaskRequirementMutationResult,
  DesktopProjectTaskRequirementRevision,
  DesktopProjectTaskSelection,
  DesktopRoutingConfigurationMutationResult,
  DesktopRoutingConfigurationUpdate,
} from "../shared/bootstrap-state.js";

declare global {
  interface Window {
    readonly codexHarness: Readonly<{
      getBootstrapState(): Promise<DesktopBootstrapState>;
      chooseProjectWorkspace(): Promise<DesktopProjectSelectionResult>;
      bindProjectToDefaultRouting(
        projectId: string,
      ): Promise<DesktopProjectRoutingBindingMutationResult>;
      readProjectTaskCatalog(projectId: string): Promise<DesktopProjectTaskCatalogResult>;
      createProjectTask(
        creation: DesktopProjectTaskCreation,
      ): Promise<DesktopProjectTaskMutationResult>;
      readProjectTaskDetail(
        selection: DesktopProjectTaskSelection,
      ): Promise<DesktopProjectTaskDetailResult>;
      reviseProjectTaskRequirement(
        revision: DesktopProjectTaskRequirementRevision,
      ): Promise<DesktopProjectTaskRequirementMutationResult>;
      generateProjectTaskCandidatePlan(
        input: DesktopProjectTaskCandidatePlanGeneration,
      ): Promise<DesktopProjectTaskCandidatePlanMutationResult>;
      setRoutingConfiguration(
        update: DesktopRoutingConfigurationUpdate,
      ): Promise<DesktopRoutingConfigurationMutationResult>;
      onBootstrapState(listener: (state: DesktopBootstrapState) => void): () => void;
    }>;
  }
}

export {};
