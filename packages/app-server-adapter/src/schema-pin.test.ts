import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ALLOWED_APP_SERVER_METHODS, KNOWN_APP_SERVER_REQUEST_METHODS } from "./methods.js";
import { APP_SERVER_SCHEMA_MANIFEST, SUPPORTED_CODEX_CLI_VERSION } from "./version.js";

type MethodUnionSchema = {
  oneOf?: Array<{
    properties?: { method?: { enum?: string[] } };
  }>;
};

function methodNames(schema: MethodUnionSchema | undefined): string[] {
  return schema?.oneOf?.flatMap((variant) => variant.properties?.method?.enum ?? []).sort() ?? [];
}

describe("pinned App Server schema", () => {
  it("matches its manifest and contains the stable protocol definitions", async () => {
    const schemaBytes = await readFile(
      new URL("../schema/codex-app-server.schema.json", import.meta.url),
    );
    expect(createHash("sha256").update(schemaBytes).digest("hex")).toBe(
      APP_SERVER_SCHEMA_MANIFEST.sha256,
    );
    expect(APP_SERVER_SCHEMA_MANIFEST.experimentalApi).toBe(false);
    expect(APP_SERVER_SCHEMA_MANIFEST.generatorCommand).not.toContain("--experimental");
    expect(SUPPORTED_CODEX_CLI_VERSION).toBe("0.146.0-alpha.9.2");

    const schema = JSON.parse(schemaBytes.toString("utf8")) as {
      definitions?: Record<string, unknown> & {
        ClientRequest?: MethodUnionSchema;
        ServerRequest?: MethodUnionSchema;
        v2?: Record<string, unknown>;
      };
    };
    expect(schema.definitions).toHaveProperty("InitializeParams");
    expect(schema.definitions).toHaveProperty("ClientRequest");
    expect(schema.definitions?.v2).toHaveProperty("ThreadStartParams");
    expect(schema.definitions?.v2).toHaveProperty("TurnStartParams");
    expect(schema.definitions?.v2).toHaveProperty("ModelListParams");

    const clientRequestMethods = methodNames(schema.definitions?.ClientRequest);
    expect(
      ALLOWED_APP_SERVER_METHODS.every((method) => clientRequestMethods.includes(method)),
    ).toBe(true);
    expect([...KNOWN_APP_SERVER_REQUEST_METHODS].sort()).toEqual(
      methodNames(schema.definitions?.ServerRequest),
    );
  });
});
