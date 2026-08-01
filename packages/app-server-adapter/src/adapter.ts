import type { JsonValue } from "@codex-harness/protocol";

import { deepFreezeJsonValue } from "./json.js";
import {
  parseAppServerLifecycleNotification,
  type AppServerRecoveryLifecycleSignal,
} from "./lifecycle.js";
import {
  classifyServerRequest,
  isAllowedAppServerMethod,
  validateMethodParams,
  validateMethodResult,
  type AllowedAppServerMethod,
  type ServerRequestDisposition,
} from "./methods.js";
import { adapterFailure, adapterSuccess, type AdapterResult } from "./result.js";
import { InitializeParamsSchema, InitializeResponseSchema } from "./schemas.js";
import type { AppServerMessage, AppServerRequestId } from "./wire.js";

export type AdapterState = "new" | "initializing" | "awaiting_initialized" | "ready" | "closed";

export type ClientIdentity = Readonly<{
  name: string;
  title: string | null;
  version: string;
}>;

export type OutgoingAppServerRequest = Readonly<{
  id: string;
  method: "initialize" | AllowedAppServerMethod;
  params: JsonValue;
}>;

export type OutgoingAppServerNotification = Readonly<{
  method: "initialized";
}>;

export type PendingAppServerRequest = Readonly<{
  id: string;
  method: "initialize" | AllowedAppServerMethod;
}>;

export type AppServerAdapterEvent =
  | Readonly<{ type: "initialized"; result: JsonValue }>
  | Readonly<{ type: "request_completed"; request: PendingAppServerRequest; result: JsonValue }>
  | Readonly<{
      type: "request_failed";
      request: PendingAppServerRequest;
      error: Readonly<{ code: number; message: string }>;
    }>
  | Readonly<{ type: "notification"; method: string; params: JsonValue | undefined }>
  | Readonly<{ type: "recovery_lifecycle"; signal: AppServerRecoveryLifecycleSignal }>
  | Readonly<{
      type: "server_request";
      id: AppServerRequestId;
      method: string;
      params: JsonValue | undefined;
      disposition: ServerRequestDisposition;
    }>;

function toJsonValue(input: unknown): JsonValue {
  return deepFreezeJsonValue(input as JsonValue);
}

export class AppServerProtocolAdapter {
  #nextRequestNumber = 1;
  #pending = new Map<string, PendingAppServerRequest>();
  #state: AdapterState = "new";

  get state(): AdapterState {
    return this.#state;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  beginInitialize(client: ClientIdentity): AdapterResult<OutgoingAppServerRequest> {
    if (this.#state === "closed") {
      return adapterFailure("closed");
    }
    if (this.#state !== "new") {
      return adapterFailure("not_ready");
    }
    let params: ReturnType<typeof InitializeParamsSchema.safeParse>;
    try {
      params = InitializeParamsSchema.safeParse({
        clientInfo: client,
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
    } catch {
      return adapterFailure("invalid_params");
    }
    if (!params.success) {
      return adapterFailure("invalid_params");
    }
    const request = this.#createPendingRequest("initialize", toJsonValue(params.data));
    if (!request.ok) {
      return request;
    }
    this.#state = "initializing";
    return request;
  }

  completeInitialize(): AdapterResult<OutgoingAppServerNotification> {
    if (this.#state === "closed") {
      return adapterFailure("closed");
    }
    if (this.#state !== "awaiting_initialized") {
      return adapterFailure("not_ready");
    }
    this.#state = "ready";
    return adapterSuccess(Object.freeze({ method: "initialized" }));
  }

  createRequest(method: string, params?: unknown): AdapterResult<OutgoingAppServerRequest> {
    if (this.#state === "closed") {
      return adapterFailure("closed");
    }
    if (this.#state !== "ready") {
      return adapterFailure("not_ready");
    }
    const validated = validateMethodParams(method, params);
    if (!validated.ok) {
      return validated;
    }
    if (!isAllowedAppServerMethod(method)) {
      return adapterFailure("unsupported_method");
    }
    return this.#createPendingRequest(method, validated.value);
  }

  accept(message: AppServerMessage): AdapterResult<AppServerAdapterEvent> {
    try {
      return this.#acceptMessage(message);
    } catch {
      this.#state = "closed";
      return adapterFailure("invalid_message");
    }
  }

  #acceptMessage(message: AppServerMessage): AdapterResult<AppServerAdapterEvent> {
    if (this.#state === "closed") {
      return adapterFailure("closed");
    }
    if (this.#state !== "ready" && this.#state !== "initializing") {
      return adapterFailure("not_ready");
    }
    if (
      this.#state === "initializing" &&
      (message.kind === "notification" || message.kind === "request")
    ) {
      return adapterFailure("not_ready");
    }

    if (message.kind === "notification") {
      const lifecycle = parseAppServerLifecycleNotification(message.method, message.params);
      if (lifecycle.kind === "invalid") {
        this.#state = "closed";
        return adapterFailure("invalid_message");
      }
      if (lifecycle.kind === "signal") {
        return adapterSuccess({
          type: "recovery_lifecycle",
          signal: lifecycle.signal,
        });
      }
      return adapterSuccess({
        type: "notification",
        method: message.method,
        params: message.params,
      });
    }

    if (message.kind === "request") {
      return adapterSuccess({
        type: "server_request",
        id: message.id,
        method: message.method,
        params: message.params,
        disposition: classifyServerRequest(message.method),
      });
    }

    const id = String(message.id);
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return adapterFailure("unexpected_response");
    }
    this.#pending.delete(id);

    if (message.kind === "error") {
      if (pending.method === "initialize") {
        this.#state = "closed";
      }
      return adapterSuccess({
        type: "request_failed",
        request: pending,
        error: { code: message.error.code, message: "The App Server request failed." },
      });
    }

    if (pending.method === "initialize") {
      const result = InitializeResponseSchema.safeParse(message.result);
      if (!result.success) {
        this.#state = "closed";
        return adapterFailure("invalid_response");
      }
      this.#state = "awaiting_initialized";
      return adapterSuccess({ type: "initialized", result: toJsonValue(result.data) });
    }

    const validatedResult = validateMethodResult(pending.method, message.result);
    if (!validatedResult.ok) {
      this.#state = "closed";
      return validatedResult;
    }
    return adapterSuccess({
      type: "request_completed",
      request: pending,
      result: validatedResult.value,
    });
  }

  close(): readonly PendingAppServerRequest[] {
    const pending = Object.freeze([...this.#pending.values()]);
    this.#pending.clear();
    this.#state = "closed";
    return pending;
  }

  #createPendingRequest(
    method: "initialize" | AllowedAppServerMethod,
    params: JsonValue,
  ): AdapterResult<OutgoingAppServerRequest> {
    if (!Number.isSafeInteger(this.#nextRequestNumber)) {
      return adapterFailure("request_id_exhausted");
    }
    const id = `harness-${String(this.#nextRequestNumber)}`;
    this.#nextRequestNumber += 1;
    if (this.#pending.has(id)) {
      return adapterFailure("duplicate_request_id");
    }
    const pending = Object.freeze({ id, method });
    this.#pending.set(id, pending);
    return adapterSuccess(Object.freeze({ id, method, params }));
  }
}
