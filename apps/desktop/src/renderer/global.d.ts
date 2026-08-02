import type {
  DesktopBootstrapState,
  DesktopProjectSelectionResult,
  DesktopRoutingConfigurationMutationResult,
  DesktopRoutingConfigurationUpdate,
} from "../shared/bootstrap-state.js";

declare global {
  interface Window {
    readonly codexHarness: Readonly<{
      getBootstrapState(): Promise<DesktopBootstrapState>;
      chooseProjectWorkspace(): Promise<DesktopProjectSelectionResult>;
      setRoutingConfiguration(
        update: DesktopRoutingConfigurationUpdate,
      ): Promise<DesktopRoutingConfigurationMutationResult>;
      onBootstrapState(listener: (state: DesktopBootstrapState) => void): () => void;
    }>;
  }
}

export {};
