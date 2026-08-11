import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  RPC_ERROR_CODES,
  decodeRequestParams,
  decodeResponseResult,
  type JsonValue,
  type RpcRequest,
} from "@codex-harness/protocol";

export type RpcDispatchContext = Readonly<{
  streamId: string;
  uptimeMs: number;
  closing: boolean;
  readAccountStatus: () => unknown;
  readModelCatalogPage: (params: JsonValue) => unknown;
  readProjectCatalogPage: (params: JsonValue) => unknown;
  registerProject: (params: JsonValue) => unknown;
  readProjectRoutingBindingStatuses: (params: JsonValue) => unknown;
  bindProjectDefaultRouting: (params: JsonValue) => unknown;
  readProjectTaskCatalogPage: (params: JsonValue) => unknown;
  createProjectTask: (params: JsonValue) => unknown;
  readProjectTaskDetail: (params: JsonValue) => unknown;
  reviseProjectTaskRequirement: (params: JsonValue) => unknown;
  confirmProjectTaskCandidatePlan: (params: JsonValue) => unknown;
  materializeProjectTaskGraph: (params: JsonValue) => unknown;
  generateProjectTaskCandidatePlan?: (params: JsonValue) => unknown | Promise<unknown>;
  readRoutingConfiguration: () => unknown;
  setRoutingConfiguration: (params: JsonValue) => unknown;
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

function unavailable(id: string, message: string): RpcDispatchResult {
  return {
    envelope: rpcError(id, RPC_ERROR_CODES.unavailable, message),
    shutdownRequested: false,
    shutdownReason: undefined,
  };
}

export class RpcProviderError extends Error {
  readonly code: "conflict" | "unavailable";

  constructor(code: "conflict" | "unavailable") {
    super(
      code === "conflict"
        ? "The RPC provider reported a conflict."
        : "The RPC provider is unavailable.",
    );
    this.name = "RpcProviderError";
    this.code = code;
  }
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

    if (request.method === "account.status") {
      let candidate: unknown;
      try {
        candidate = context.readAccountStatus();
      } catch {
        return unavailable(request.id, "The account status is unavailable.");
      }
      const decodedResult = decodeResponseResult("account.status", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The account status is unavailable.");
    }

    if (request.method === "model.catalog_page") {
      let candidate: unknown;
      try {
        candidate = context.readModelCatalogPage(decodedParams.value);
      } catch {
        return unavailable(request.id, "The model catalog is unavailable.");
      }
      const decodedResult = decodeResponseResult("model.catalog_page", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The model catalog is unavailable.");
    }

    if (request.method === "routing.configuration.get") {
      let candidate: unknown;
      try {
        candidate = context.readRoutingConfiguration();
      } catch {
        return unavailable(request.id, "The routing configuration is unavailable.");
      }
      const decodedResult = decodeResponseResult("routing.configuration.get", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The routing configuration is unavailable.");
    }

    if (request.method === "project.catalog_page") {
      let candidate: unknown;
      try {
        candidate = context.readProjectCatalogPage(decodedParams.value);
      } catch {
        return unavailable(request.id, "The Project catalog is unavailable.");
      }
      const decodedResult = decodeResponseResult("project.catalog_page", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project catalog is unavailable.");
    }

    if (request.method === "project.register") {
      let candidate: unknown;
      try {
        candidate = context.registerProject(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(
              request.id,
              RPC_ERROR_CODES.conflict,
              "The Project registry changed.",
            ),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Project registry is unavailable.");
      }
      const decodedResult = decodeResponseResult("project.register", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project registry is unavailable.");
    }

    if (request.method === "project.routing_binding.status_batch") {
      let candidate: unknown;
      try {
        candidate = context.readProjectRoutingBindingStatuses(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(
              request.id,
              RPC_ERROR_CODES.conflict,
              "The Project routing binding status changed.",
            ),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Project routing binding status is unavailable.");
      }
      const decodedResult = decodeResponseResult("project.routing_binding.status_batch", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project routing binding status is unavailable.");
    }

    if (request.method === "project.routing_binding.bind_default") {
      let candidate: unknown;
      try {
        candidate = context.bindProjectDefaultRouting(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(
              request.id,
              RPC_ERROR_CODES.conflict,
              "The Project routing binding changed.",
            ),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Project routing binding is unavailable.");
      }
      const decodedResult = decodeResponseResult("project.routing_binding.bind_default", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project routing binding is unavailable.");
    }

    if (request.method === "task.catalog_page") {
      let candidate: unknown;
      try {
        candidate = context.readProjectTaskCatalogPage(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(
              request.id,
              RPC_ERROR_CODES.conflict,
              "The Project Task catalog changed.",
            ),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Project Task catalog is unavailable.");
      }
      const decodedResult = decodeResponseResult("task.catalog_page", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project Task catalog is unavailable.");
    }

    if (request.method === "task.create") {
      let candidate: unknown;
      try {
        candidate = context.createProjectTask(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(request.id, RPC_ERROR_CODES.conflict, "The Project Task changed."),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Project Task service is unavailable.");
      }
      const decodedResult = decodeResponseResult("task.create", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project Task service is unavailable.");
    }

    if (request.method === "task.detail") {
      let candidate: unknown;
      try {
        candidate = context.readProjectTaskDetail(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(request.id, RPC_ERROR_CODES.conflict, "The Project Task changed."),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Project Task detail is unavailable.");
      }
      const decodedResult = decodeResponseResult("task.detail", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project Task detail is unavailable.");
    }

    if (request.method === "task.requirement.revise") {
      let candidate: unknown;
      try {
        candidate = context.reviseProjectTaskRequirement(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(request.id, RPC_ERROR_CODES.conflict, "The Project Task changed."),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Project Task Requirement service is unavailable.");
      }
      const decodedResult = decodeResponseResult("task.requirement.revise", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Project Task Requirement service is unavailable.");
    }

    if (request.method === "task.plan.confirm_candidate") {
      let candidate: unknown;
      try {
        candidate = context.confirmProjectTaskCandidatePlan(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(request.id, RPC_ERROR_CODES.conflict, "The Project Task changed."),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The candidate Plan confirmation service is unavailable.");
      }
      const decodedResult = decodeResponseResult("task.plan.confirm_candidate", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The candidate Plan confirmation service is unavailable.");
    }

    if (request.method === "task.graph.materialize") {
      let candidate: unknown;
      try {
        candidate = context.materializeProjectTaskGraph(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(request.id, RPC_ERROR_CODES.conflict, "The Project Task changed."),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The Task graph materialization service is unavailable.");
      }
      const decodedResult = decodeResponseResult("task.graph.materialize", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The Task graph materialization service is unavailable.");
    }

    if (request.method === "task.plan.generate_candidate") {
      return unavailable(request.id, "The candidate Plan generation service is unavailable.");
    }

    if (request.method === "routing.configuration.set") {
      let candidate: unknown;
      try {
        candidate = context.setRoutingConfiguration(decodedParams.value);
      } catch (error: unknown) {
        if (error instanceof RpcProviderError && error.code === "conflict") {
          return {
            envelope: rpcError(
              request.id,
              RPC_ERROR_CODES.conflict,
              "The routing configuration changed.",
            ),
            shutdownRequested: false,
            shutdownReason: undefined,
          };
        }
        return unavailable(request.id, "The routing configuration is unavailable.");
      }
      const decodedResult = decodeResponseResult("routing.configuration.set", candidate);
      return decodedResult.ok
        ? {
            envelope: rpcResponse(request.id, decodedResult.value),
            shutdownRequested: false,
            shutdownReason: undefined,
          }
        : unavailable(request.id, "The routing configuration is unavailable.");
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

export async function dispatchRpcRequestAsync(
  request: RpcRequest,
  context: RpcDispatchContext,
): Promise<RpcDispatchResult> {
  if (request.method !== "task.plan.generate_candidate" || context.closing) {
    return dispatchRpcRequest(request, context);
  }
  const decodedParams = decodeRequestParams(request.method, request.params);
  if (!decodedParams.ok || context.generateProjectTaskCandidatePlan === undefined) {
    return dispatchRpcRequest(request, context);
  }
  return await dispatchCandidatePlanGeneration(
    request.id,
    decodedParams.value,
    context.generateProjectTaskCandidatePlan,
  );
}

async function dispatchCandidatePlanGeneration(
  requestId: string,
  params: JsonValue,
  provider: NonNullable<RpcDispatchContext["generateProjectTaskCandidatePlan"]>,
): Promise<RpcDispatchResult> {
  let candidate: unknown;
  try {
    candidate = await provider(params);
  } catch (error: unknown) {
    if (error instanceof RpcProviderError && error.code === "conflict") {
      return {
        envelope: rpcError(requestId, RPC_ERROR_CODES.conflict, "The Project Task changed."),
        shutdownRequested: false,
        shutdownReason: undefined,
      };
    }
    return unavailable(requestId, "The candidate Plan generation service is unavailable.");
  }
  const decodedResult = decodeResponseResult("task.plan.generate_candidate", candidate);
  return decodedResult.ok
    ? {
        envelope: rpcResponse(requestId, decodedResult.value),
        shutdownRequested: false,
        shutdownReason: undefined,
      }
    : unavailable(requestId, "The candidate Plan generation service is unavailable.");
}
