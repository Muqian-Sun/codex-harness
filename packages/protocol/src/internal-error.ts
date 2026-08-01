import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  RPC_ERROR_CODES,
} from "./constants.js";
import { RpcIdSchema, type RpcErrorResponse } from "./schemas.js";

export function createInternalErrorResponse(
  requestId: string | null,
  correlationId: string,
  cause?: unknown,
): RpcErrorResponse {
  void cause;

  if (requestId !== null && !RpcIdSchema.safeParse(requestId).success) {
    throw new TypeError("Invalid RPC response identifier.");
  }
  if (!RpcIdSchema.safeParse(correlationId).success) {
    throw new TypeError("Invalid internal error correlation identifier.");
  }

  return {
    kind: "error",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id: requestId,
    error: {
      code: RPC_ERROR_CODES.internalError,
      message: INTERNAL_ERROR_PUBLIC_MESSAGE,
      data: { correlationId },
    },
  };
}
