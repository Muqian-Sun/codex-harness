import type {
  DesktopBootstrapState,
  DesktopProjectSelectionResult,
  DesktopProjectRoutingBindingMutationResult,
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
      setRoutingConfiguration(
        update: DesktopRoutingConfigurationUpdate,
      ): Promise<DesktopRoutingConfigurationMutationResult>;
      onBootstrapState(listener: (state: DesktopBootstrapState) => void): () => void;
    }>;
  }
}

export {};
