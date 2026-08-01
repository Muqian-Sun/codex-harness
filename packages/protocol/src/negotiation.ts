import { z } from "zod";

import {
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  MAX_APPLICATION_VERSION_COUNT,
  MAX_CAPABILITY_COUNT,
  RPC_ERROR_CODES,
  type KnownRpcErrorCode,
} from "./constants.js";
import {
  ApplicationVersionSchema,
  CapabilityTokenSchema,
  SystemHelloParamsSchema,
} from "./schemas.js";

const uniqueStrings = (values: readonly string[], context: z.RefinementCtx): void => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Values must be unique" });
  }
};

const ServerNegotiationConfigSchema = z
  .object({
    supportedProtocolVersions: z
      .array(ApplicationVersionSchema)
      .min(1)
      .max(MAX_APPLICATION_VERSION_COUNT)
      .superRefine(uniqueStrings),
    capabilities: z
      .array(CapabilityTokenSchema)
      .max(MAX_CAPABILITY_COUNT)
      .superRefine(uniqueStrings),
  })
  .strict();

export type ServerNegotiationConfig = z.infer<typeof ServerNegotiationConfigSchema>;

export type HelloNegotiation = Readonly<{
  selectedProtocolVersion: string;
  enabledCapabilities: readonly string[];
}>;

export type HelloNegotiationResult =
  | Readonly<{ ok: true; value: HelloNegotiation }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: KnownRpcErrorCode; message: string }>;
    }>;

function negotiationFailure(code: KnownRpcErrorCode, message: string): HelloNegotiationResult {
  return { ok: false, error: Object.freeze({ code, message }) };
}

export function negotiateHello(
  clientHello: unknown,
  serverConfig: unknown,
): HelloNegotiationResult {
  const parsedClient = SystemHelloParamsSchema.safeParse(clientHello);
  if (!parsedClient.success) {
    return negotiationFailure(RPC_ERROR_CODES.invalidMessage, "The bootstrap request is invalid.");
  }

  const parsedServer = ServerNegotiationConfigSchema.safeParse(serverConfig);
  if (!parsedServer.success) {
    return negotiationFailure(RPC_ERROR_CODES.internalError, INTERNAL_ERROR_PUBLIC_MESSAGE);
  }

  const clientVersions = new Set(parsedClient.data.supportedProtocolVersions);
  const selectedProtocolVersion = parsedServer.data.supportedProtocolVersions.find((version) =>
    clientVersions.has(version),
  );

  if (selectedProtocolVersion === undefined) {
    return negotiationFailure(
      RPC_ERROR_CODES.unsupportedProtocolVersion,
      "No supported application protocol version is available.",
    );
  }

  const clientCapabilities = new Set(parsedClient.data.capabilities.supported);
  const enabledCapabilities = parsedServer.data.capabilities.filter((token) =>
    clientCapabilities.has(token),
  );
  const enabledSet = new Set(enabledCapabilities);

  if (parsedClient.data.capabilities.required.some((token) => !enabledSet.has(token))) {
    return negotiationFailure(
      RPC_ERROR_CODES.unsupportedCapability,
      "A required capability is unavailable.",
    );
  }

  return {
    ok: true,
    value: Object.freeze({
      selectedProtocolVersion,
      enabledCapabilities: Object.freeze(enabledCapabilities),
    }),
  };
}
