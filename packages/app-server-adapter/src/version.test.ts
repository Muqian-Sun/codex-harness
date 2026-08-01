import { describe, expect, it } from "vitest";

import { SUPPORTED_CODEX_CLI_VERSION, validateCodexCliVersion } from "./version.js";

describe("Codex CLI version compatibility", () => {
  it("requires the exact version used to generate the schema", () => {
    expect(validateCodexCliVersion(`codex-cli ${SUPPORTED_CODEX_CLI_VERSION}`)).toEqual({
      ok: true,
      value: SUPPORTED_CODEX_CLI_VERSION,
    });
    expect(validateCodexCliVersion("codex-cli 0.147.0")).toMatchObject({
      ok: false,
      error: { code: "invalid_version" },
    });
    expect(validateCodexCliVersion("unexpected output")).toMatchObject({
      ok: false,
      error: { code: "invalid_version" },
    });
  });
});
