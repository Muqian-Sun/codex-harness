import schemaManifest from "./generated/schema-manifest.json" with { type: "json" };
import { adapterFailure, adapterSuccess, type AdapterResult } from "./result.js";

export const APP_SERVER_SCHEMA_MANIFEST = Object.freeze(schemaManifest);
export const SUPPORTED_CODEX_CLI_VERSION = schemaManifest.codexCliVersion;

export function validateCodexCliVersion(versionOutput: string): AdapterResult<string> {
  const match = /^codex-cli (\S+)$/.exec(versionOutput.trim());
  if (match?.[1] !== SUPPORTED_CODEX_CLI_VERSION) {
    return adapterFailure("invalid_version");
  }
  return adapterSuccess(match[1]);
}
