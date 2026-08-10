import type {
  DesktopBootstrapState,
  DesktopProjectSelectionResult,
  DesktopProjectRoutingBindingMutationResult,
  DesktopProjectTaskCatalogResult,
  DesktopProjectTaskCreation,
  DesktopProjectTaskMutationResult,
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
      setRoutingConfiguration(
        update: DesktopRoutingConfigurationUpdate,
      ): Promise<DesktopRoutingConfigurationMutationResult>;
      onBootstrapState(listener: (state: DesktopBootstrapState) => void): () => void;
    }>;
  }
}

export {};
