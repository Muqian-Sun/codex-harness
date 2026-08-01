import { z } from "zod";

import {
  APPLICATION_PROTOCOL_VERSION,
  APPLICATION_VERSION_PATTERN,
  BOOTSTRAP_WIRE_VERSION,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  MAX_APPLICATION_VERSION_BYTES,
  MAX_APPLICATION_VERSION_COUNT,
  MAX_CAPABILITY_COUNT,
  MAX_NAMESPACED_TOKEN_BYTES,
  MAX_RPC_ID_BYTES,
  NAMESPACED_TOKEN_PATTERN,
  PRODUCT_VERSION_PATTERN,
  RPC_ERROR_CODES,
  RPC_ID_PATTERN,
  STARTUP_CAPABILITY_PATTERN,
  STREAM_ID_PATTERN,
} from "./constants.js";
import { isJsonValue, type JsonValue } from "./json-value.js";

const uniqueStrings = (values: readonly string[], context: z.RefinementCtx): void => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Values must be unique" });
  }
};

export const JsonValueSchema = z.custom<JsonValue>(isJsonValue, {
  message: "Expected a JSON value",
});

export const RpcIdSchema = z.string().min(1).max(MAX_RPC_ID_BYTES).regex(RPC_ID_PATTERN);

export const NamespacedTokenSchema = z
  .string()
  .min(1)
  .max(MAX_NAMESPACED_TOKEN_BYTES)
  .regex(NAMESPACED_TOKEN_PATTERN);

export const RpcErrorCodeSchema = NamespacedTokenSchema;
export const MethodNameSchema = NamespacedTokenSchema;
export const CapabilityTokenSchema = NamespacedTokenSchema;

export const ApplicationVersionSchema = z
  .string()
  .min(3)
  .max(MAX_APPLICATION_VERSION_BYTES)
  .regex(APPLICATION_VERSION_PATTERN);

export const ProductVersionSchema = z.string().min(3).max(64).regex(PRODUCT_VERSION_PATTERN);

export const StartupCapabilitySchema = z.string().length(43).regex(STARTUP_CAPABILITY_PATTERN);

export const StreamIdSchema = z.string().length(22).regex(STREAM_ID_PATTERN);

export const PositiveSafeIntegerSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value > 0, {
    message: "Expected a positive safe integer",
  });

export const NonNegativeSafeIntegerSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0, {
    message: "Expected a non-negative safe integer",
  });

const CapabilityListSchema = z
  .array(CapabilityTokenSchema)
  .max(MAX_CAPABILITY_COUNT)
  .superRefine(uniqueStrings);

const ApplicationVersionListSchema = z
  .array(ApplicationVersionSchema)
  .min(1)
  .max(MAX_APPLICATION_VERSION_COUNT)
  .superRefine(uniqueStrings);

export const SystemHelloParamsSchema = z
  .object({
    client: z
      .object({
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
        version: ProductVersionSchema,
      })
      .strict(),
    supportedProtocolVersions: ApplicationVersionListSchema,
    capabilities: z
      .object({
        supported: CapabilityListSchema,
        required: CapabilityListSchema,
      })
      .strict(),
    startupCapability: StartupCapabilitySchema,
    resume: z
      .object({
        streamId: StreamIdSchema,
        lastSequence: NonNegativeSafeIntegerSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const supported = new Set(value.capabilities.supported);
    if (!value.capabilities.required.every((token) => supported.has(token))) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "required"],
        message: "Required capabilities must be supported by the client",
      });
    }
  });

export const SystemHelloResultSchema = z
  .object({
    selectedProtocolVersion: ApplicationVersionSchema,
    server: z
      .object({
        name: z.literal("harnessd"),
        version: ProductVersionSchema,
      })
      .passthrough(),
    enabledCapabilities: CapabilityListSchema,
    stream: z
      .object({
        id: StreamIdSchema,
        nextSequence: PositiveSafeIntegerSchema,
        replayWindowStart: PositiveSafeIntegerSchema,
        resyncRequired: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.stream.replayWindowStart > value.stream.nextSequence) {
      context.addIssue({
        code: "custom",
        path: ["stream", "replayWindowStart"],
        message: "Replay window cannot start after the next sequence",
      });
    }
  });

const CorrelationDataSchema = z.object({ correlationId: RpcIdSchema }).strict();

const InternalErrorSchema = z
  .object({
    code: z.literal(RPC_ERROR_CODES.internalError),
    message: z.literal(INTERNAL_ERROR_PUBLIC_MESSAGE),
    data: CorrelationDataSchema.optional(),
  })
  .strict();

const NonInternalErrorCodeSchema = RpcErrorCodeSchema.refine(
  (code) => code !== RPC_ERROR_CODES.internalError,
  { message: "Internal errors require the restricted error schema" },
);

const KNOWN_RPC_ERROR_CODES = new Set<string>(Object.values(RPC_ERROR_CODES));
const BOOTSTRAP_KNOWN_NON_INTERNAL_ERROR_CODES = new Set<string>([
  RPC_ERROR_CODES.invalidMessage,
  RPC_ERROR_CODES.authenticationFailed,
  RPC_ERROR_CODES.unsupportedProtocolVersion,
  RPC_ERROR_CODES.unsupportedCapability,
  RPC_ERROR_CODES.unavailable,
]);

const BootstrapNonInternalErrorCodeSchema = NonInternalErrorCodeSchema.refine(
  (code) => !KNOWN_RPC_ERROR_CODES.has(code) || BOOTSTRAP_KNOWN_NON_INTERNAL_ERROR_CODES.has(code),
  { message: "Known application-only error codes are invalid during bootstrap" },
);

const BootstrapErrorSchema = z
  .object({
    code: BootstrapNonInternalErrorCodeSchema,
    message: z.string().min(1).max(512),
  })
  .passthrough();

export const BootstrapHelloRequestSchema = z
  .object({
    kind: z.literal("bootstrap-request"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    id: RpcIdSchema,
    method: z.literal("system.hello"),
    params: SystemHelloParamsSchema,
  })
  .strict();

export const BootstrapHelloResponseSchema = z
  .object({
    kind: z.literal("bootstrap-response"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    id: RpcIdSchema,
    result: SystemHelloResultSchema,
  })
  .passthrough();

const GenericBootstrapErrorResponseSchema = z
  .object({
    kind: z.literal("bootstrap-error"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    id: RpcIdSchema.nullable(),
    error: BootstrapErrorSchema,
  })
  .passthrough();

const InternalBootstrapErrorResponseSchema = z
  .object({
    kind: z.literal("bootstrap-error"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    id: RpcIdSchema.nullable(),
    error: InternalErrorSchema,
  })
  .strict();

export const BootstrapErrorResponseSchema = z.union([
  InternalBootstrapErrorResponseSchema,
  GenericBootstrapErrorResponseSchema,
]);

export const RpcRequestSchema = z
  .object({
    kind: z.literal("request"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    protocolVersion: z.literal(APPLICATION_PROTOCOL_VERSION),
    id: RpcIdSchema,
    method: MethodNameSchema,
    params: JsonValueSchema,
  })
  .strict();

export const RpcResponseSchema = z
  .object({
    kind: z.literal("response"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    protocolVersion: z.literal(APPLICATION_PROTOCOL_VERSION),
    id: RpcIdSchema,
    result: JsonValueSchema,
  })
  .passthrough();

const RpcErrorSchema = z
  .object({
    code: NonInternalErrorCodeSchema,
    message: z.string().min(1).max(512),
    data: JsonValueSchema.optional(),
  })
  .passthrough();

const GenericRpcErrorResponseSchema = z
  .object({
    kind: z.literal("error"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    protocolVersion: z.literal(APPLICATION_PROTOCOL_VERSION),
    id: RpcIdSchema.nullable(),
    error: RpcErrorSchema,
  })
  .passthrough();

const InternalRpcErrorResponseSchema = z
  .object({
    kind: z.literal("error"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    protocolVersion: z.literal(APPLICATION_PROTOCOL_VERSION),
    id: RpcIdSchema.nullable(),
    error: InternalErrorSchema,
  })
  .strict();

export const RpcErrorResponseSchema = z.union([
  InternalRpcErrorResponseSchema,
  GenericRpcErrorResponseSchema,
]);

export const RpcEventSchema = z
  .object({
    kind: z.literal("event"),
    wireVersion: z.literal(BOOTSTRAP_WIRE_VERSION),
    protocolVersion: z.literal(APPLICATION_PROTOCOL_VERSION),
    streamId: StreamIdSchema,
    sequence: PositiveSafeIntegerSchema,
    method: MethodNameSchema,
    params: JsonValueSchema,
  })
  .passthrough();

export const ClientBootstrapEnvelopeSchema = BootstrapHelloRequestSchema;
export const ServerBootstrapEnvelopeSchema = z.union([
  BootstrapHelloResponseSchema,
  BootstrapErrorResponseSchema,
]);
export const ClientRpcEnvelopeSchema = RpcRequestSchema;
export const ServerRpcEnvelopeSchema = z.union([
  RpcResponseSchema,
  RpcErrorResponseSchema,
  RpcEventSchema,
]);

export type SystemHelloParams = z.infer<typeof SystemHelloParamsSchema>;
export type SystemHelloResult = z.infer<typeof SystemHelloResultSchema>;
export type ApplicationVersionToken = z.infer<typeof ApplicationVersionSchema>;
export type BootstrapHelloRequest = z.infer<typeof BootstrapHelloRequestSchema>;
export type BootstrapHelloResponse = z.infer<typeof BootstrapHelloResponseSchema>;
export type BootstrapErrorResponse = z.infer<typeof BootstrapErrorResponseSchema>;
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
export type RpcErrorResponse = z.infer<typeof RpcErrorResponseSchema>;
export type RpcEvent = z.infer<typeof RpcEventSchema>;
export type ClientBootstrapEnvelope = z.infer<typeof ClientBootstrapEnvelopeSchema>;
export type ServerBootstrapEnvelope = z.infer<typeof ServerBootstrapEnvelopeSchema>;
export type ClientRpcEnvelope = z.infer<typeof ClientRpcEnvelopeSchema>;
export type ServerRpcEnvelope = z.infer<typeof ServerRpcEnvelopeSchema>;
export type RpcErrorCode = z.infer<typeof RpcErrorCodeSchema>;
