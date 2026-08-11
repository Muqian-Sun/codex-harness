import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import {
  AppServerProtocolAdapter,
  MAX_APP_SERVER_FRAME_BYTES,
  SUPPORTED_CODEX_CLI_VERSION,
  parseAppServerJson,
  validateCodexCliVersion,
  type AppServerAdapterEvent,
  type ClientIdentity,
  type OutgoingAppServerNotification,
  type OutgoingAppServerRequest,
} from "@codex-harness/app-server-adapter";
import { validateJsonValue, type JsonValue } from "@codex-harness/protocol";

const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_ANALYSIS_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 2_000;
const DEFAULT_SIGTERM_TIMEOUT_MS = 2_000;
const DEFAULT_SIGKILL_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_ANALYSIS_TURN_TIMEOUT_MS = 900_000;
const MAX_ANALYSIS_OUTPUT_SCHEMA_BYTES = 256 * 1024;
const MAX_ANALYSIS_AGENT_MESSAGES = 64;
const MAX_ANALYSIS_AGENT_MESSAGE_CHARACTERS = 2_000_000;
const MAX_VERSION_OUTPUT_BYTES = 4_096;

export type AppServerWorkerState = "starting" | "ready" | "closing" | "closed";

export type AppServerWorkerErrorCode =
  | "analysis_busy"
  | "closed"
  | "invalid_analysis_input"
  | "invalid_configuration"
  | "invalid_turn_output"
  | "protocol_failure"
  | "request_failed"
  | "request_timeout"
  | "spawn_failed"
  | "startup_timeout"
  | "turn_failed"
  | "turn_timeout"
  | "unsupported_server_request"
  | "unsupported_version"
  | "version_check_failed"
  | "worker_exited";

const ERROR_MESSAGES: Readonly<Record<AppServerWorkerErrorCode, string>> = Object.freeze({
  analysis_busy: "The Codex App Server worker already has an active analysis turn.",
  closed: "The Codex App Server worker is closed.",
  invalid_analysis_input: "The Codex App Server analysis turn input is invalid.",
  invalid_configuration: "The Codex App Server worker configuration is invalid.",
  invalid_turn_output: "The Codex App Server analysis turn output is invalid.",
  protocol_failure: "The Codex App Server worker protocol failed.",
  request_failed: "The Codex App Server request failed.",
  request_timeout: "The Codex App Server request timed out.",
  spawn_failed: "The Codex App Server worker failed to start.",
  startup_timeout: "The Codex App Server worker startup timed out.",
  turn_failed: "The Codex App Server analysis turn did not complete successfully.",
  turn_timeout: "The Codex App Server analysis turn timed out.",
  unsupported_server_request: "The Codex App Server requested an unsupported capability.",
  unsupported_version: "The Codex CLI version is not supported.",
  version_check_failed: "The Codex CLI version check failed.",
  worker_exited: "The Codex App Server worker exited unexpectedly.",
});

export class AppServerWorkerError extends Error {
  readonly code: AppServerWorkerErrorCode;

  constructor(code: AppServerWorkerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AppServerWorkerError";
    this.code = code;
  }
}

export type AppServerWorkerEvent = Extract<
  AppServerAdapterEvent,
  { type: "account_updated" | "notification" | "recovery_lifecycle" }
>;

export type AppServerWorkerCloseReason =
  | "event_handler_failure"
  | "protocol_failure"
  | "request_timeout"
  | "requested"
  | "turn_timeout"
  | "unsupported_server_request"
  | "worker_exited";

export type AppServerWorkerContainment =
  "already_exited" | "containment_unknown" | "graceful" | "sigkill" | "sigterm";

export type AppServerWorkerCloseResult = Readonly<{
  reason: AppServerWorkerCloseReason;
  containment: AppServerWorkerContainment;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrObserved: boolean;
}>;

export type AppServerWorkerConfig = Readonly<{
  codexExecutable: string;
  clientIdentity: ClientIdentity;
  versionCheckTimeoutMs?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  analysisTurnTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  sigtermTimeoutMs?: number;
  sigkillTimeoutMs?: number;
  onEvent?: (event: AppServerWorkerEvent) => void | Promise<void>;
}>;

type NormalizedConfig = Readonly<{
  codexExecutable: string;
  clientIdentity: ClientIdentity;
  versionCheckTimeoutMs: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  analysisTurnTimeoutMs: number;
  gracefulTimeoutMs: number;
  sigtermTimeoutMs: number;
  sigkillTimeoutMs: number;
  onEvent: ((event: AppServerWorkerEvent) => void | Promise<void>) | null;
}>;

type ChildExit = Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>;

type PendingRequest = Readonly<{
  resolve: (value: JsonValue) => void;
  reject: (error: AppServerWorkerError) => void;
  timer: NodeJS.Timeout;
}>;

export type AppServerReadOnlyAnalysisInput = Readonly<{
  cwd: string;
  modelProvider: string;
  model: string;
  reasoningEffort: string;
  prompt: string;
  outputSchema: JsonValue;
}>;

export type AppServerReadOnlyAnalysisResult = Readonly<{
  threadId: string;
  turnId: string;
  output: JsonValue;
}>;

type CompletedAgentMessage = Readonly<{
  itemId: string;
  phase: "commentary" | "final_answer" | null;
  text: string;
}>;

type ActiveAnalysisTurn = {
  threadId: string | null;
  turnId: string | null;
  messages: CompletedAgentMessage[];
  messageIds: Set<string>;
  messageCharacters: number;
  deferred: Deferred<AppServerReadOnlyAnalysisResult>;
  timer: NodeJS.Timeout | null;
};

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: AppServerWorkerError) => void;
}>;

export class AppServerWorker {
  readonly #config: NormalizedConfig;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #adapter = new AppServerProtocolAdapter();
  readonly #decoder = new AppServerJsonlFrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #childExit: Promise<ChildExit>;
  readonly #initializeDeferred: Deferred<void>;
  readonly closed: Promise<AppServerWorkerCloseResult>;
  #resolveClosed!: (result: AppServerWorkerCloseResult) => void;
  #state: AppServerWorkerState = "starting";
  #lastChildExit: ChildExit | undefined;
  #closePromise: Promise<AppServerWorkerCloseResult> | undefined;
  #stderrObserved = false;
  #terminalError: AppServerWorkerError | undefined;
  #activeAnalysisTurn: ActiveAnalysisTurn | undefined;

  private constructor(config: NormalizedConfig, child: ChildProcessWithoutNullStreams) {
    this.#config = config;
    this.#child = child;
    this.#initializeDeferred = createDeferred<void>();
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#childExit = observeChildExit(child);
    this.#attachTransport();
  }

  static async start(config: AppServerWorkerConfig): Promise<AppServerWorker> {
    const normalized = normalizeConfig(config);
    try {
      await access(normalized.codexExecutable, fsConstants.X_OK);
    } catch {
      throw new AppServerWorkerError("invalid_configuration");
    }
    await verifyCodexVersion(normalized.codexExecutable, normalized.versionCheckTimeoutMs);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(normalized.codexExecutable, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new AppServerWorkerError("spawn_failed");
    }
    child.on("error", () => undefined);
    try {
      await waitForSpawn(child);
    } catch {
      child.kill("SIGKILL");
      throw new AppServerWorkerError("spawn_failed");
    }

    const worker = new AppServerWorker(normalized, child);
    try {
      await worker.#initialize();
      worker.#state = "ready";
      return worker;
    } catch (error: unknown) {
      const normalizedError = normalizeWorkerError(error, "protocol_failure");
      worker.#terminalError = normalizedError;
      await worker.#beginClose(closeReasonForError(normalizedError), normalizedError);
      throw normalizedError;
    }
  }

  get state(): AppServerWorkerState {
    return this.#state;
  }

  get supportedCodexCliVersion(): string {
    return SUPPORTED_CODEX_CLI_VERSION;
  }

  get stderrObserved(): boolean {
    return this.#stderrObserved;
  }

  async listModels(params: unknown): Promise<JsonValue> {
    return await this.#request("model/list", params);
  }

  async readAccount(): Promise<JsonValue> {
    return await this.#request("account/read", { refreshToken: false });
  }

  async runReadOnlyAnalysisTurn(
    input: AppServerReadOnlyAnalysisInput,
  ): Promise<AppServerReadOnlyAnalysisResult> {
    if (this.#state !== "ready") {
      throw new AppServerWorkerError("closed");
    }
    if (this.#activeAnalysisTurn !== undefined) {
      throw new AppServerWorkerError("analysis_busy");
    }
    const normalized = normalizeAnalysisInput(input);
    const active: ActiveAnalysisTurn = {
      threadId: null,
      turnId: null,
      messages: [],
      messageIds: new Set(),
      messageCharacters: 0,
      deferred: createDeferred<AppServerReadOnlyAnalysisResult>(),
      timer: null,
    };
    void active.deferred.promise.catch(() => undefined);
    this.#activeAnalysisTurn = active;

    try {
      const threadResult = await this.#request("thread/start", {
        approvalPolicy: "never",
        cwd: normalized.cwd,
        ephemeral: true,
        model: normalized.model,
        modelProvider: normalized.modelProvider,
        sandbox: "read-only",
      });
      active.threadId = requireNestedIdentifier(threadResult, "thread");
      active.timer = setTimeout(() => {
        const error = new AppServerWorkerError("turn_timeout");
        active.deferred.reject(error);
        this.#fail(error, "turn_timeout");
      }, this.#config.analysisTurnTimeoutMs);

      const turnResult = await this.#request("turn/start", {
        approvalPolicy: "never",
        cwd: normalized.cwd,
        effort: normalized.reasoningEffort,
        input: [{ type: "text", text: normalized.prompt, text_elements: [] }],
        model: normalized.model,
        outputSchema: normalized.outputSchema,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        summary: "none",
        threadId: active.threadId,
      });
      this.#bindActiveTurn(active, requireNestedIdentifier(turnResult, "turn"));
      return await active.deferred.promise;
    } catch (error: unknown) {
      if (error instanceof AppServerWorkerError) {
        throw error;
      }
      throw new AppServerWorkerError("invalid_turn_output");
    } finally {
      if (active.timer !== null) {
        clearTimeout(active.timer);
      }
      if (this.#activeAnalysisTurn === active) {
        this.#activeAnalysisTurn = undefined;
      }
    }
  }

  async #request(
    method: "account/read" | "model/list" | "thread/start" | "turn/start",
    params: unknown,
  ): Promise<JsonValue> {
    if (this.#state !== "ready") {
      throw new AppServerWorkerError("closed");
    }
    const request = this.#adapter.createRequest(method, params);
    if (!request.ok) {
      throw new AppServerWorkerError("request_failed");
    }

    const result = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(request.value.id)) {
          return;
        }
        const error = new AppServerWorkerError("request_timeout");
        reject(error);
        this.#fail(error, "request_timeout");
      }, this.#config.requestTimeoutMs);
      this.#pending.set(
        request.value.id,
        Object.freeze({
          resolve,
          reject,
          timer,
        }),
      );
    });

    void this.#writeMessage(request.value).catch(() => {
      this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
    });
    return await result;
  }

  async close(): Promise<AppServerWorkerCloseResult> {
    return await this.#beginClose("requested", new AppServerWorkerError("closed"));
  }

  async #initialize(): Promise<void> {
    const request = this.#adapter.beginInitialize(this.#config.clientIdentity);
    if (!request.ok) {
      throw new AppServerWorkerError("invalid_configuration");
    }
    await this.#writeMessage(request.value);
    await withTimeout(
      this.#initializeDeferred.promise,
      this.#config.startupTimeoutMs,
      "startup_timeout",
    );
  }

  #attachTransport(): void {
    this.#child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.byteLength > 0) {
        this.#stderrObserved = true;
      }
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    this.#child.stdout.once("end", () => {
      if (this.#state === "closing" || this.#state === "closed") {
        return;
      }
      const complete = this.#decoder.finish();
      this.#fail(
        new AppServerWorkerError(complete ? "worker_exited" : "protocol_failure"),
        complete ? "worker_exited" : "protocol_failure",
      );
    });
    this.#child.once("error", () => {
      if (this.#state !== "closing" && this.#state !== "closed") {
        this.#fail(new AppServerWorkerError("worker_exited"), "worker_exited");
      }
    });
    void this.#childExit.then((exit) => {
      this.#lastChildExit = exit;
      if (this.#state !== "closing" && this.#state !== "closed") {
        this.#fail(new AppServerWorkerError("worker_exited"), "worker_exited");
      }
    });
  }

  #consumeStdout(chunk: Buffer): void {
    if (!this.#canConsumeStdout()) {
      return;
    }
    const frames = this.#decoder.push(chunk);
    if (frames === null) {
      this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
      return;
    }
    for (const frame of frames) {
      if (!this.#canConsumeStdout()) {
        return;
      }
      let line: string;
      try {
        const content =
          frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d
            ? frame.subarray(0, frame.byteLength - 1)
            : frame;
        line = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
        return;
      }
      const parsed = parseAppServerJson(line);
      if (!parsed.ok) {
        this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
        return;
      }
      const accepted = this.#adapter.accept(parsed.value);
      if (!accepted.ok) {
        this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
        return;
      }
      this.#handleAdapterEvent(accepted.value);
    }
  }

  #canConsumeStdout(): boolean {
    return this.#state !== "closing" && this.#state !== "closed";
  }

  #handleAdapterEvent(event: AppServerAdapterEvent): void {
    if (event.type === "initialized") {
      const notification = this.#adapter.completeInitialize();
      if (!notification.ok) {
        this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
        return;
      }
      void this.#writeMessage(notification.value).then(
        () => this.#initializeDeferred.resolve(undefined),
        () => this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure"),
      );
      return;
    }

    if (event.type === "request_completed") {
      const pending = this.#pending.get(event.request.id);
      if (pending === undefined) {
        this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
        return;
      }
      this.#pending.delete(event.request.id);
      clearTimeout(pending.timer);
      pending.resolve(event.result);
      return;
    }

    if (event.type === "request_failed") {
      const pending = this.#pending.get(event.request.id);
      if (pending === undefined) {
        this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
        return;
      }
      this.#pending.delete(event.request.id);
      clearTimeout(pending.timer);
      pending.reject(new AppServerWorkerError("request_failed"));
      return;
    }

    if (event.type === "server_request") {
      this.#fail(
        new AppServerWorkerError("unsupported_server_request"),
        "unsupported_server_request",
      );
      return;
    }

    if (event.type === "turn_output") {
      this.#observeTurnOutput(event.signal);
      return;
    }

    if (
      event.type === "account_updated" ||
      event.type === "notification" ||
      event.type === "recovery_lifecycle"
    ) {
      if (event.type === "recovery_lifecycle") {
        this.#observeTurnLifecycle(event.signal);
      }
      try {
        const handled = this.#config.onEvent?.(event);
        if (handled !== undefined) {
          void Promise.resolve(handled).catch(() => {
            this.#fail(new AppServerWorkerError("protocol_failure"), "event_handler_failure");
          });
        }
      } catch {
        this.#fail(new AppServerWorkerError("protocol_failure"), "event_handler_failure");
      }
      return;
    }

    this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
  }

  #observeTurnOutput(
    signal: Extract<AppServerAdapterEvent, { type: "turn_output" }>["signal"],
  ): void {
    const active = this.#activeAnalysisTurn;
    if (active === undefined || active.threadId === null || signal.threadId !== active.threadId) {
      this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
      return;
    }
    if (!this.#bindActiveTurn(active, signal.turnId)) {
      return;
    }
    if (active.messageIds.has(signal.itemId)) {
      this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
      return;
    }
    const nextMessageCharacters = active.messageCharacters + signal.text.length;
    if (
      active.messageIds.size >= MAX_ANALYSIS_AGENT_MESSAGES ||
      nextMessageCharacters > MAX_ANALYSIS_AGENT_MESSAGE_CHARACTERS
    ) {
      this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
      return;
    }
    active.messageIds.add(signal.itemId);
    active.messageCharacters = nextMessageCharacters;
    if (signal.phase !== "commentary") {
      active.messages.push(
        Object.freeze({ itemId: signal.itemId, phase: signal.phase, text: signal.text }),
      );
    }
  }

  #observeTurnLifecycle(
    signal: Extract<AppServerAdapterEvent, { type: "recovery_lifecycle" }>["signal"],
  ): void {
    const active = this.#activeAnalysisTurn;
    if (
      active === undefined ||
      active.threadId === null ||
      signal.threadId !== active.threadId ||
      (signal.type !== "turn_started" && signal.type !== "turn_completed")
    ) {
      return;
    }
    if (!this.#bindActiveTurn(active, signal.turnId) || signal.type !== "turn_completed") {
      return;
    }
    if (signal.status !== "completed") {
      active.deferred.reject(new AppServerWorkerError("turn_failed"));
      return;
    }
    const message = selectFinalAgentMessage(active.messages);
    if (message === null) {
      active.deferred.reject(new AppServerWorkerError("invalid_turn_output"));
      return;
    }
    const output = parseTurnOutput(message.text);
    if (output === null) {
      active.deferred.reject(new AppServerWorkerError("invalid_turn_output"));
      return;
    }
    active.deferred.resolve(
      Object.freeze({ threadId: active.threadId, turnId: signal.turnId, output }),
    );
  }

  #bindActiveTurn(active: ActiveAnalysisTurn, turnId: string): boolean {
    if (this.#activeAnalysisTurn !== active) {
      return false;
    }
    if (active.turnId !== null && active.turnId !== turnId) {
      this.#fail(new AppServerWorkerError("protocol_failure"), "protocol_failure");
      return false;
    }
    active.turnId = turnId;
    return true;
  }

  async #writeMessage(
    message: OutgoingAppServerRequest | OutgoingAppServerNotification,
  ): Promise<void> {
    if (this.#state === "closing" || this.#state === "closed") {
      throw new AppServerWorkerError("closed");
    }
    let frame: string;
    try {
      frame = `${JSON.stringify(message)}\n`;
    } catch {
      throw new AppServerWorkerError("protocol_failure");
    }
    if (Buffer.byteLength(frame, "utf8") - 1 > MAX_APP_SERVER_FRAME_BYTES) {
      throw new AppServerWorkerError("protocol_failure");
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(frame, (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(new AppServerWorkerError("protocol_failure"));
        }
      });
    });
  }

  #fail(error: AppServerWorkerError, reason: AppServerWorkerCloseReason): void {
    if (this.#state === "closing" || this.#state === "closed") {
      return;
    }
    this.#terminalError ??= error;
    this.#initializeDeferred.reject(this.#terminalError);
    void this.#beginClose(reason, this.#terminalError);
  }

  #beginClose(
    reason: AppServerWorkerCloseReason,
    rejection: AppServerWorkerError,
  ): Promise<AppServerWorkerCloseResult> {
    const existing = this.#closePromise;
    if (existing !== undefined) {
      return existing;
    }
    const closing = this.#closeProcess(reason, rejection);
    this.#closePromise = closing;
    return closing;
  }

  async #closeProcess(
    reason: AppServerWorkerCloseReason,
    rejection: AppServerWorkerError,
  ): Promise<AppServerWorkerCloseResult> {
    this.#state = "closing";
    this.#initializeDeferred.reject(rejection);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(rejection);
    }
    this.#pending.clear();
    const active = this.#activeAnalysisTurn;
    if (active !== undefined) {
      if (active.timer !== null) {
        clearTimeout(active.timer);
      }
      active.deferred.reject(rejection);
    }
    this.#adapter.close();
    this.#decoder.close();

    const exitedBeforeClose = this.#lastChildExit !== undefined;
    if (!exitedBeforeClose && !this.#child.stdin.destroyed && !this.#child.stdin.writableEnded) {
      this.#child.stdin.end();
    }

    let containment: AppServerWorkerContainment;
    if (exitedBeforeClose) {
      containment = "already_exited";
    } else if (await this.#waitForExit(this.#config.gracefulTimeoutMs)) {
      containment = "graceful";
    } else {
      safelyKill(this.#child, "SIGTERM");
      if (await this.#waitForExit(this.#config.sigtermTimeoutMs)) {
        containment = "sigterm";
      } else {
        safelyKill(this.#child, "SIGKILL");
        containment = (await this.#waitForExit(this.#config.sigkillTimeoutMs))
          ? "sigkill"
          : "containment_unknown";
      }
    }

    this.#state = "closed";
    const exit = this.#lastChildExit ?? { exitCode: null, signal: null };
    const result = Object.freeze({
      reason,
      containment,
      exitCode: exit.exitCode,
      signal: exit.signal,
      stderrObserved: this.#stderrObserved,
    });
    this.#resolveClosed(result);
    return result;
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#lastChildExit !== undefined) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.#childExit.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

function normalizeConfig(config: AppServerWorkerConfig): NormalizedConfig {
  try {
    const codexExecutable = config.codexExecutable;
    const clientIdentity = config.clientIdentity;
    const versionCheckTimeoutMs = config.versionCheckTimeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;
    const startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const analysisTurnTimeoutMs = config.analysisTurnTimeoutMs ?? DEFAULT_ANALYSIS_TURN_TIMEOUT_MS;
    const gracefulTimeoutMs = config.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
    const sigtermTimeoutMs = config.sigtermTimeoutMs ?? DEFAULT_SIGTERM_TIMEOUT_MS;
    const sigkillTimeoutMs = config.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS;
    if (
      typeof codexExecutable !== "string" ||
      !isAbsolute(codexExecutable) ||
      codexExecutable.includes("\0") ||
      (config.onEvent !== undefined && typeof config.onEvent !== "function") ||
      !validTimeout(versionCheckTimeoutMs) ||
      !validTimeout(startupTimeoutMs) ||
      !validTimeout(requestTimeoutMs) ||
      !validAnalysisTurnTimeout(analysisTurnTimeoutMs) ||
      !validTimeout(gracefulTimeoutMs) ||
      !validTimeout(sigtermTimeoutMs) ||
      !validTimeout(sigkillTimeoutMs)
    ) {
      throw new AppServerWorkerError("invalid_configuration");
    }
    const identityValidator = new AppServerProtocolAdapter();
    const identityResult = identityValidator.beginInitialize(clientIdentity);
    identityValidator.close();
    if (!identityResult.ok) {
      throw new AppServerWorkerError("invalid_configuration");
    }
    return Object.freeze({
      codexExecutable,
      clientIdentity: Object.freeze({
        name: clientIdentity.name,
        title: clientIdentity.title,
        version: clientIdentity.version,
      }),
      versionCheckTimeoutMs,
      startupTimeoutMs,
      requestTimeoutMs,
      analysisTurnTimeoutMs,
      gracefulTimeoutMs,
      sigtermTimeoutMs,
      sigkillTimeoutMs,
      onEvent: config.onEvent ?? null,
    });
  } catch (error: unknown) {
    if (error instanceof AppServerWorkerError) {
      throw error;
    }
    throw new AppServerWorkerError("invalid_configuration");
  }
}

function normalizeAnalysisInput(input: unknown): AppServerReadOnlyAnalysisInput {
  try {
    if (!validateJsonValue(input).ok || typeof input !== "object" || input === null) {
      throw new AppServerWorkerError("invalid_analysis_input");
    }
    const record = input as Record<string, JsonValue>;
    const keys = Object.keys(record).sort();
    const expectedKeys = [
      "cwd",
      "model",
      "modelProvider",
      "outputSchema",
      "prompt",
      "reasoningEffort",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new AppServerWorkerError("invalid_analysis_input");
    }
    const cwd = requireBoundedString(record.cwd, 16_384);
    const modelProvider = requireBoundedString(record.modelProvider, 4_096);
    const model = requireBoundedString(record.model, 4_096);
    const reasoningEffort = requireBoundedString(record.reasoningEffort, 128);
    const prompt = requireBoundedString(record.prompt, 1_000_000);
    const outputSchema = record.outputSchema;
    if (
      !isAbsolute(cwd) ||
      cwd.includes("\0") ||
      typeof outputSchema !== "object" ||
      outputSchema === null ||
      Array.isArray(outputSchema)
    ) {
      throw new AppServerWorkerError("invalid_analysis_input");
    }
    const outputSchemaCopy = structuredClone(outputSchema);
    if (
      Buffer.byteLength(JSON.stringify(outputSchemaCopy), "utf8") > MAX_ANALYSIS_OUTPUT_SCHEMA_BYTES
    ) {
      throw new AppServerWorkerError("invalid_analysis_input");
    }
    return Object.freeze({
      cwd,
      modelProvider,
      model,
      reasoningEffort,
      prompt,
      outputSchema: freezeJsonValue(outputSchemaCopy),
    });
  } catch (error: unknown) {
    if (error instanceof AppServerWorkerError) {
      throw error;
    }
    throw new AppServerWorkerError("invalid_analysis_input");
  }
}

function requireBoundedString(value: JsonValue | undefined, maxCharacters: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxCharacters) {
    throw new AppServerWorkerError("invalid_analysis_input");
  }
  return value;
}

function requireNestedIdentifier(result: JsonValue, key: "thread" | "turn"): string {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new AppServerWorkerError("invalid_turn_output");
  }
  const nested = result[key];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    throw new AppServerWorkerError("invalid_turn_output");
  }
  const id = nested.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    throw new AppServerWorkerError("invalid_turn_output");
  }
  return id;
}

function selectFinalAgentMessage(
  messages: readonly CompletedAgentMessage[],
): CompletedAgentMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.phase === "final_answer") {
      return message;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.phase === null) {
      return message;
    }
  }
  return null;
}

function parseTurnOutput(text: string): JsonValue | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!validateJsonValue(parsed).ok) {
      return null;
    }
    return freezeJsonValue(parsed as JsonValue);
  } catch {
    return null;
  }
}

function freezeJsonValue<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeJsonValue(item);
    }
  } else {
    for (const item of Object.values(value)) {
      freezeJsonValue(item);
    }
  }
  return Object.freeze(value);
}

async function verifyCodexVersion(executable: string, timeoutMs: number): Promise<void> {
  let child: ChildProcess;
  try {
    child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new AppServerWorkerError("version_check_failed");
  }
  child.on("error", () => undefined);
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    safelyKill(child, "SIGKILL");
    throw new AppServerWorkerError("version_check_failed");
  }
  stderr.resume();

  const output = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    let terminalFailure: AppServerWorkerError | undefined;
    let killFallbackTimer: NodeJS.Timeout | undefined;
    const finish = (result: Buffer | AppServerWorkerError): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killFallbackTimer !== undefined) {
        clearTimeout(killFallbackTimer);
      }
      if (result instanceof AppServerWorkerError) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const failAndKill = (error: AppServerWorkerError): void => {
      if (terminalFailure !== undefined) {
        return;
      }
      terminalFailure = error;
      safelyKill(child, "SIGKILL");
      killFallbackTimer = setTimeout(() => finish(error), Math.min(timeoutMs, 1_000));
    };
    const timer = setTimeout(
      () => failAndKill(new AppServerWorkerError("version_check_failed")),
      timeoutMs,
    );
    stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > MAX_VERSION_OUTPUT_BYTES) {
        failAndKill(new AppServerWorkerError("version_check_failed"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => finish(new AppServerWorkerError("version_check_failed")));
    child.once("close", (exitCode) => {
      if (terminalFailure !== undefined) {
        finish(terminalFailure);
        return;
      }
      if (exitCode !== 0) {
        finish(new AppServerWorkerError("version_check_failed"));
        return;
      }
      finish(Buffer.concat(chunks, byteLength));
    });
  });

  const validated = validateCodexCliVersion(output.toString("utf8"));
  if (!validated.ok) {
    throw new AppServerWorkerError("unsupported_version");
  }
}

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

function validAnalysisTurnTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_ANALYSIS_TURN_TIMEOUT_MS;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function observeChildExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once("close", (exitCode, signal) => {
      resolve(Object.freeze({ exitCode, signal }));
    });
  });
}

function safelyKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The exact child may already have exited.
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: AppServerWorkerError) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorCode: AppServerWorkerErrorCode,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppServerWorkerError(errorCode)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeWorkerError(
  error: unknown,
  fallback: AppServerWorkerErrorCode,
): AppServerWorkerError {
  return error instanceof AppServerWorkerError ? error : new AppServerWorkerError(fallback);
}

function closeReasonForError(error: AppServerWorkerError): AppServerWorkerCloseReason {
  if (error.code === "request_timeout") {
    return "request_timeout";
  }
  if (error.code === "unsupported_server_request") {
    return "unsupported_server_request";
  }
  if (error.code === "worker_exited") {
    return "worker_exited";
  }
  if (error.code === "turn_timeout") {
    return "turn_timeout";
  }
  return "protocol_failure";
}

class AppServerJsonlFrameDecoder {
  #chunks: Uint8Array[] = [];
  #byteLength = 0;
  #closed = false;

  push(input: Uint8Array): readonly Uint8Array[] | null {
    if (this.#closed) {
      return null;
    }
    const frames: Uint8Array[] = [];
    let segmentStart = 0;
    for (let index = 0; index < input.byteLength; index += 1) {
      if (input[index] !== 0x0a) {
        continue;
      }
      if (!this.#append(input.subarray(segmentStart, index))) {
        return null;
      }
      frames.push(this.#take());
      segmentStart = index + 1;
    }
    if (!this.#append(input.subarray(segmentStart))) {
      return null;
    }
    return Object.freeze(frames);
  }

  finish(): boolean {
    if (this.#closed) {
      return false;
    }
    this.#closed = true;
    const complete = this.#byteLength === 0;
    this.#clear();
    return complete;
  }

  close(): void {
    this.#closed = true;
    this.#clear();
  }

  #append(segment: Uint8Array): boolean {
    if (segment.byteLength === 0) {
      return true;
    }
    const nextLength = this.#byteLength + segment.byteLength;
    const lastByte = segment[segment.byteLength - 1];
    if (
      nextLength > MAX_APP_SERVER_FRAME_BYTES + 1 ||
      (nextLength === MAX_APP_SERVER_FRAME_BYTES + 1 && lastByte !== 0x0d)
    ) {
      this.close();
      return false;
    }
    this.#chunks.push(Uint8Array.from(segment));
    this.#byteLength = nextLength;
    return true;
  }

  #take(): Uint8Array {
    const frame = new Uint8Array(this.#byteLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      frame.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.#clear();
    return frame;
  }

  #clear(): void {
    this.#chunks = [];
    this.#byteLength = 0;
  }
}
