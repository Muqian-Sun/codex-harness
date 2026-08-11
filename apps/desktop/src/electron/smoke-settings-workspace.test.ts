import { describe, expect, it, vi } from "vitest";

import { ensureSmokeSettingsWorkspace } from "./smoke-settings-workspace.js";

describe("desktop smoke settings workspace driver", () => {
  it.each([
    [true, true],
    [false, false],
    ["true", false],
  ] as const)("accepts only an observed open settings layer", async (observed, expected) => {
    const executeJavaScript = vi.fn(async () => observed);

    await expect(
      ensureSmokeSettingsWorkspace({ webContents: { executeJavaScript } }),
    ).resolves.toBe(expected);
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("[data-open-settings]"),
      true,
    );
  });

  it("leaves execution failures for the bounded smoke observer to contain", async () => {
    const failure = new Error("renderer unavailable");
    const executeJavaScript = vi.fn(async () => await Promise.reject(failure));

    await expect(ensureSmokeSettingsWorkspace({ webContents: { executeJavaScript } })).rejects.toBe(
      failure,
    );
  });
});
