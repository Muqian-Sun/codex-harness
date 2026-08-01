export const BOOTSTRAP_WIRE_VERSION = "1" as const;
export const APPLICATION_PROTOCOL_VERSION = "1.0" as const;

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_NODES = 100_000;
export const MAX_RPC_ID_BYTES = 64;
export const MAX_NAMESPACED_TOKEN_BYTES = 128;
export const MAX_APPLICATION_VERSION_BYTES = 32;
export const MAX_APPLICATION_VERSION_COUNT = 16;
export const MAX_CAPABILITY_COUNT = 64;

export const RPC_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
export const NAMESPACED_TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z][a-z0-9]*)*$/;
export const APPLICATION_VERSION_PATTERN =
  /^[1-9][0-9]*\.[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9.-]*)?$/;
export const PRODUCT_VERSION_PATTERN = /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9.-]*)?$/;
export const STARTUP_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const STREAM_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;

export const RPC_ERROR_CODES = Object.freeze({
  invalidMessage: "protocol.invalid_message",
  authenticationFailed: "auth.authentication_failed",
  unsupportedProtocolVersion: "protocol.unsupported_version",
  unsupportedCapability: "capability.unsupported",
  methodNotFound: "rpc.method_not_found",
  invalidParams: "rpc.invalid_params",
  internalError: "internal.error",
  unavailable: "service.unavailable",
  conflict: "rpc.conflict",
} as const);

export type KnownRpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export const INTERNAL_ERROR_PUBLIC_MESSAGE = "An internal error occurred.";
