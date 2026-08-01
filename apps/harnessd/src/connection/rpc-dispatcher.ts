import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  RPC_ERROR_CODES,
  decodeRequestParams,
  type JsonValue,
  type RpcRequest,
} from "@codex-harness/protocol";

export type RpcDispatchContext = Readonly<{
  streamId: string;
  uptimeMs: number;
  closing: boolean;
}>;

export type RpcDispatchResult = Readonly<{
  envelope: JsonValue;
  shutdownRequested: boolean;
  shutdownReason: string | undefined;
}>;

function rpcError(id: string, code: string, message: string): JsonValue {
  return {
    kind: "error",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id,
    error: { code, message },
  };
}

function rpcResponse(id: string, result: JsonValue): JsonValue {
  return {
    kind: "response",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id,
    result,
  };
}

export function dispatchRpcRequest(
  request: RpcRequest,
  context: RpcDispatchContext,
): RpcDispatchResult {
  try {
    if (context.closing) {
      return {
        envelope: rpcError(
          request.id,
          RPC_ERROR_CODES.unavailable,
          "The Harness daemon is shutting down.",
        ),
        shutdownRequested: false,
        shutdownReason: undefined,
      };
    }

    const decodedParams = decodeRequestParams(request.method, request.params);
    if (!decodedParams.ok) {
      return {
        envelope:
          decodedParams.error.code === "unknown_method"
            ? rpcError(
                request.id,
                RPC_ERROR_CODES.methodNotFound,
                "The RPC method is not available.",
              )
            : rpcError(
                request.id,
                RPC_ERROR_CODES.invalidParams,
                "The RPC method parameters are invalid.",
              ),
        shutdownRequested: false,
        shutdownReason: undefined,
      };
    }

    if (request.method === "system.health") {
      return {
        envelope: rpcResponse(request.id, {
          status: "ok",
          streamId: context.streamId,
          uptimeMs: context.uptimeMs,
        }),
        shutdownRequested: false,
        shutdownReason: undefined,
      };
    }

    if (request.method !== "system.shutdown") {
      return {
        envelope: rpcError(
          request.id,
          RPC_ERROR_CODES.methodNotFound,
          "The RPC method is not available.",
        ),
        shutdownRequested: false,
        shutdownReason: undefined,
      };
    }

    const params = decodedParams.value;
    const reason =
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params) &&
      typeof params.reason === "string"
        ? params.reason
        : undefined;
    return {
      envelope: rpcResponse(request.id, { accepted: true }),
      shutdownRequested: true,
      shutdownReason: reason,
    };
  } catch {
    return {
      envelope: rpcError(request.id, RPC_ERROR_CODES.internalError, INTERNAL_ERROR_PUBLIC_MESSAGE),
      shutdownRequested: false,
      shutdownReason: undefined,
    };
  }
}
