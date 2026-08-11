export interface SmokeSettingsWindow {
  readonly webContents: Readonly<{
    executeJavaScript(source: string, userGesture: boolean): Promise<unknown>;
  }>;
}

export async function ensureSmokeSettingsWorkspace(window: SmokeSettingsWindow): Promise<boolean> {
  const visible = await window.webContents.executeJavaScript(
    `(() => {
      const settings = document.querySelector("[data-settings-workspace]");
      if (settings instanceof HTMLElement) {
        return true;
      }
      const open = document.querySelector("[data-open-settings]");
      if (open instanceof HTMLButtonElement && !open.disabled) {
        open.click();
      }
      return false;
    })()`,
    true,
  );
  return visible === true;
}
