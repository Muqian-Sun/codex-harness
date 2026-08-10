import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { TextDecoder } from "node:util";

import {
  decodeRequestParams,
  decodeResponseResult,
  validateJsonValue,
  type HarnessModelCatalogPageParams,
  type HarnessModelCatalogPageResult,
  type JsonValue,
} from "@codex-harness/protocol";

import {
  createAccountStatusSnapshot,
  type AccountStatusSnapshot,
} from "../domain/account-status.js";
import {
  createModelCatalogSnapshot,
  type ModelCatalogPageInput,
  type ModelCatalogSnapshot,
} from "../domain/model-catalog.js";
import {
  AppServerWorker,
  type AppServerReadOnlyAnalysisInput,
  type AppServerReadOnlyAnalysisResult,
  type AppServerWorkerCloseResult,
  type AppServerWorkerConfig,
  type AppServerWorkerContainment,
  type AppServerWorkerEvent,
  type AppServerWorkerState,
} from "./app-server-worker.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROVIDER_CHARACTERS = 256;
const MAX_MODEL_ID_CHARACTERS = 256;
const MAX_CURSOR_CHARACTERS = 4_096;
const MAX_PUBLIC_CURSOR_CHARACTERS = 2_048;
const MAX_CATALOG_PAGES = 128;
const MAX_CATALOG_MODELS = 10_000;
const MAX_CATALOG_RESPONSE_BYTES = 64 * 1024 * 1024;
const MODEL_LIST_PAGE_SIZE = 1_000;
const publicCursorDecoder = new TextDecoder("utf-8", { fatal: true });

export type AppServerWorkerManagerState =
  "starting" | "ready" | "refreshing" | "refreshing_account" | "closing" | "closed";

export type AppServerWorkerManagerErrorCode =
  | "account_snapshot_failed"
  | "analysis_unavailable"
  | "catalog_page_unavailable"
  | "catalog_refresh_failed"
  | "closed"
  | "invalid_configuration"
  | "refresh_unavailable"
  | "worker_start_failed";

const ERROR_MESSAGES: Readonly<Record<AppServerWorkerManagerErrorCode, string>> = Object.freeze({
  account_snapshot_failed: "The Codex account status snapshot failed.",
  analysis_unavailable: "The Codex App Server analysis turn is unavailable.",
  catalog_page_unavailable: "The current Codex model catalog page is unavailable.",
  catalog_refresh_failed: "The Codex model catalog refresh failed.",
  closed: "The Codex App Server worker manager is closed.",
  invalid_configuration: "The Codex App Server worker manager configuration is invalid.",
  refresh_unavailable: "The Codex worker snapshot cannot be refreshed in the current state.",
  worker_start_failed: "The Codex App Server worker failed to start.",
});

export class AppServerWorkerManagerError extends Error {
  readonly code: AppServerWorkerManagerErrorCode;

  constructor(code: AppServerWorkerManagerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AppServerWorkerManagerError";
    this.code = code;
  }
}

export type AppServerWorkerManagerConfig = Readonly<{
  provider: string;
  worker: AppServerWorkerConfig;
}>;

export type AppServerWorkerManagerCloseReason =
  "account_snapshot_failed" | "catalog_refresh_failed" | "requested" | "worker_failure";

export type AppServerWorkerManagerCloseResult = Readonly<{
  reason: AppServerWorkerManagerCloseReason;
  workerSessionId: string;
  containment: AppServerWorkerContainment;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrObserved: boolean;
}>;

export type AccountStatusSnapshotListener = (snapshot: AccountStatusSnapshot) => void;

export type ManagedAppServerWorker = Readonly<{
  state: AppServerWorkerState;
  listModels(params: unknown): Promise<JsonValue>;
  readAccount(): Promise<JsonValue>;
  runReadOnlyAnalysisTurn?(
    input: AppServerReadOnlyAnalysisInput,
  ): Promise<AppServerReadOnlyAnalysisResult>;
  close(): Promise<AppServerWorkerCloseResult>;
  closed: Promise<AppServerWorkerCloseResult>;
}>;

/** @internal Test seam. Production callers must omit this argument. */
export type AppServerWorkerManagerDependencies = Readonly<{
  startWorker(config: AppServerWorkerConfig): Promise<ManagedAppServerWorker>;
  newId(): string;
  now(): number;
}>;

const PRODUCTION_DEPENDENCIES: AppServerWorkerManagerDependencies = Object.freeze({
  startWorker: async (config) => await AppServerWorker.start(config),
  newId: () => randomUUID(),
  now: () => Date.now(),
});

export class AppServerWorkerManager {
  readonly #provider: string;
  readonly #worker: ManagedAppServerWorker;
  readonly #dependencies: AppServerWorkerManagerDependencies;
  readonly #workerSessionId: string;
  readonly closed: Promise<AppServerWorkerManagerCloseResult>;
  #resolveClosed!: (result: AppServerWorkerManagerCloseResult) => void;
  #state: AppServerWorkerManagerState = "starting";
  #startupStage: "account" | "catalog" = "catalog";
  #catalog: ModelCatalogSnapshot | undefined;
  #accountStatus: AccountStatusSnapshot | undefined;
  #accountUpdatePending = false;
  #accountUpdateRefresh: Promise<void> | undefined;
  readonly #accountStatusListeners = new Set<AccountStatusSnapshotListener>();
  #lastWorkerClose: AppServerWorkerCloseResult | undefined;
  #closePromise: Promise<AppServerWorkerManagerCloseResult> | undefined;

  private constructor(
    provider: string,
    worker: ManagedAppServerWorker,
    dependencies: AppServerWorkerManagerDependencies,
    workerSessionId: string,
  ) {
    this.#provider = provider;
    this.#worker = worker;
    this.#dependencies = dependencies;
    this.#workerSessionId = workerSessionId;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    void worker.closed.then(
      (result) => {
        const normalized = normalizeWorkerCloseResult(result);
        this.#lastWorkerClose = normalized;
        if (this.#state === "closing" || this.#state === "closed") {
          return;
        }
        const reason = this.#failureReasonForState();
        void this.#beginClose(reason, normalized);
      },
      () => {
        if (this.#state === "closing" || this.#state === "closed") {
          return;
        }
        const reason = this.#failureReasonForState();
        void this.#beginClose(reason);
      },
    );
  }

  static async start(
    config: AppServerWorkerManagerConfig,
    dependencies: AppServerWorkerManagerDependencies = PRODUCTION_DEPENDENCIES,
  ): Promise<AppServerWorkerManager> {
    let provider: string;
    let workerConfig: AppServerWorkerConfig;
    let normalizedDependencies: AppServerWorkerManagerDependencies;
    let workerSessionId: string;
    try {
      provider = normalizeProvider(config?.provider);
      workerConfig = config.worker;
      normalizedDependencies = normalizeDependencies(dependencies);
      workerSessionId = requireUuid(normalizedDependencies.newId());
    } catch {
      throw new AppServerWorkerManagerError("invalid_configuration");
    }

    const managerReference: { current: AppServerWorkerManager | undefined } = {
      current: undefined,
    };
    let accountUpdateBeforeManager = false;
    let worker: ManagedAppServerWorker;
    try {
      const externalOnEvent = workerConfig.onEvent;
      const managedWorkerConfig: AppServerWorkerConfig = Object.freeze({
        ...workerConfig,
        onEvent: async (event: AppServerWorkerEvent) => {
          if (event.type === "account_updated") {
            const currentManager = managerReference.current;
            if (currentManager === undefined) {
              accountUpdateBeforeManager = true;
              return;
            }
            await currentManager.#observeAccountUpdated();
            return;
          }
          await externalOnEvent?.(event);
        },
      });
      worker = await normalizedDependencies.startWorker(managedWorkerConfig);
    } catch {
      throw new AppServerWorkerManagerError("worker_start_failed");
    }
    let workerReady: boolean;
    try {
      workerReady = isManagedWorker(worker) && worker.state === "ready";
    } catch {
      workerReady = false;
    }
    if (!workerReady) {
      await closeInvalidWorker(worker);
      throw new AppServerWorkerManagerError("worker_start_failed");
    }

    const manager = new AppServerWorkerManager(
      provider,
      worker,
      normalizedDependencies,
      workerSessionId,
    );
    managerReference.current = manager;
    if (accountUpdateBeforeManager) {
      manager.#accountUpdatePending = true;
    }
    let catalog: ModelCatalogSnapshot;
    try {
      catalog = await manager.#collectCatalog();
    } catch {
      await manager.#beginClose("catalog_refresh_failed");
      throw new AppServerWorkerManagerError("catalog_refresh_failed");
    }
    manager.#startupStage = "account";
    let accountStatus: AccountStatusSnapshot;
    try {
      accountStatus = await manager.#collectAccountStatus();
      manager.#installStartupSnapshots(catalog, accountStatus);
      await manager.#settlePendingAccountUpdates();
      return manager;
    } catch {
      await manager.#beginClose("account_snapshot_failed");
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
  }

  get state(): AppServerWorkerManagerState {
    return this.#state;
  }

  get provider(): string {
    return this.#provider;
  }

  get workerSessionId(): string {
    return this.#workerSessionId;
  }

  get catalog(): ModelCatalogSnapshot | null {
    return this.#publishesSnapshots() ? (this.#catalog ?? null) : null;
  }

  isCatalogCurrent(candidate: unknown): candidate is ModelCatalogSnapshot {
    return (
      this.#publishesSnapshots() &&
      candidate === this.#catalog &&
      this.#catalog?.workerSessionId === this.#workerSessionId
    );
  }

  async runReadOnlyAnalysisTurn(
    input: AppServerReadOnlyAnalysisInput,
  ): Promise<AppServerReadOnlyAnalysisResult> {
    if (this.#state !== "ready") {
      throw new AppServerWorkerManagerError(
        this.#state === "closing" || this.#state === "closed" ? "closed" : "analysis_unavailable",
      );
    }
    const catalog = this.#catalog;
    if (catalog === undefined || !this.isCatalogCurrent(catalog)) {
      throw new AppServerWorkerManagerError("analysis_unavailable");
    }
    const model = catalog.models.find(
      (candidate) => !candidate.hidden && candidate.model === input.model,
    );
    if (
      typeof this.#worker.runReadOnlyAnalysisTurn !== "function" ||
      input.modelProvider !== catalog.provider ||
      model === undefined ||
      !model.inputModalities.includes("text") ||
      !model.supportedReasoningEfforts.includes(input.reasoningEffort)
    ) {
      throw new AppServerWorkerManagerError("analysis_unavailable");
    }
    try {
      return await this.#worker.runReadOnlyAnalysisTurn(input);
    } catch {
      throw new AppServerWorkerManagerError("analysis_unavailable");
    }
  }

  readCatalogPage(input: unknown): HarnessModelCatalogPageResult {
    if (this.#state !== "ready") {
      throw new AppServerWorkerManagerError(
        this.#state === "closing" || this.#state === "closed"
          ? "closed"
          : "catalog_page_unavailable",
      );
    }
    const catalog = this.#catalog;
    if (catalog === undefined || !this.isCatalogCurrent(catalog)) {
      throw new AppServerWorkerManagerError("catalog_page_unavailable");
    }
    const decodedParams = decodeRequestParams("model.catalog_page", input);
    if (!decodedParams.ok) {
      throw new AppServerWorkerManagerError("catalog_page_unavailable");
    }

    try {
      const params = decodedParams.value as HarnessModelCatalogPageParams;
      const visible = catalog.models.filter((model) => !model.hidden);
      const startIndex = resolveCatalogPageStart(catalog, visible, params.cursor);
      const endIndex = Math.min(startIndex + params.limit, visible.length);
      const models = Object.freeze(
        visible.slice(startIndex, endIndex).map((model) =>
          Object.freeze({
            model: model.model,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
            inputModalities: model.inputModalities,
          }),
        ),
      );
      const nextCursor =
        endIndex < visible.length && endIndex > startIndex
          ? encodeCatalogCursor(catalog.snapshotId, visible[endIndex - 1]!.id)
          : null;
      const result = Object.freeze({
        schemaVersion: 1 as const,
        provider: catalog.provider,
        totalVisibleModels: visible.length,
        models,
        nextCursor,
      });
      const decodedResult = decodeResponseResult("model.catalog_page", result);
      if (!decodedResult.ok) {
        throw new AppServerWorkerManagerError("catalog_page_unavailable");
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof AppServerWorkerManagerError) {
        throw error;
      }
      throw new AppServerWorkerManagerError("catalog_page_unavailable");
    }
  }

  get accountStatus(): AccountStatusSnapshot | null {
    return this.#publishesSnapshots() ? (this.#accountStatus ?? null) : null;
  }

  isAccountStatusCurrent(candidate: unknown): candidate is AccountStatusSnapshot {
    return (
      this.#publishesSnapshots() &&
      candidate === this.#accountStatus &&
      this.#accountStatus?.workerSessionId === this.#workerSessionId
    );
  }

  subscribeAccountStatusChanges(listener: AccountStatusSnapshotListener): () => void {
    if (typeof listener !== "function") {
      throw new AppServerWorkerManagerError("invalid_configuration");
    }
    if (this.#state !== "ready") {
      throw new AppServerWorkerManagerError(
        this.#state === "closing" || this.#state === "closed" ? "closed" : "refresh_unavailable",
      );
    }
    const subscription: AccountStatusSnapshotListener = (snapshot) => listener(snapshot);
    this.#accountStatusListeners.add(subscription);
    let subscribed = true;
    return (): void => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.#accountStatusListeners.delete(subscription);
    };
  }

  async refreshCatalog(): Promise<ModelCatalogSnapshot> {
    if (this.#state !== "ready") {
      throw new AppServerWorkerManagerError(
        this.#state === "closing" || this.#state === "closed" ? "closed" : "refresh_unavailable",
      );
    }
    this.#state = "refreshing";
    this.#catalog = undefined;
    let snapshot: ModelCatalogSnapshot;
    try {
      snapshot = await this.#collectCatalog();
      this.#installCatalog(snapshot, "refreshing");
    } catch {
      await this.#beginClose("catalog_refresh_failed");
      throw new AppServerWorkerManagerError("catalog_refresh_failed");
    }
    await this.#settlePendingAccountUpdates();
    return snapshot;
  }

  async refreshAccountStatus(): Promise<AccountStatusSnapshot> {
    if (this.#state !== "ready") {
      throw new AppServerWorkerManagerError(
        this.#state === "closing" || this.#state === "closed" ? "closed" : "refresh_unavailable",
      );
    }
    await this.#refreshAccountStatusOnce();
    await this.#settlePendingAccountUpdates();
    const current = this.#accountStatus;
    if (current === undefined || !this.isAccountStatusCurrent(current)) {
      await this.#beginClose("account_snapshot_failed");
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
    return current;
  }

  async close(): Promise<AppServerWorkerManagerCloseResult> {
    return await this.#beginClose("requested");
  }

  async #collectCatalog(): Promise<ModelCatalogSnapshot> {
    const pages: ModelCatalogPageInput[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let modelCount = 0;
    let responseBytes = 0;

    for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES; pageNumber += 1) {
      this.#requireCatalogCollectionState();
      const response = await this.#worker.listModels({
        cursor,
        includeHidden: true,
        limit: MODEL_LIST_PAGE_SIZE,
      });
      this.#requireCatalogCollectionState();
      const metadata = readPageMetadata(response);
      modelCount += metadata.modelCount;
      responseBytes += metadata.responseBytes;
      if (modelCount > MAX_CATALOG_MODELS || responseBytes > MAX_CATALOG_RESPONSE_BYTES) {
        throw new AppServerWorkerManagerError("catalog_refresh_failed");
      }
      pages.push(
        Object.freeze({
          requestCursor: cursor,
          includeHidden: true,
          response,
        }),
      );
      if (metadata.nextCursor === null) {
        const snapshotId = requireUuid(this.#dependencies.newId());
        const observedAtMs = requireObservedAt(this.#dependencies.now());
        return createModelCatalogSnapshot({
          schemaVersion: 1,
          snapshotId,
          workerSessionId: this.#workerSessionId,
          provider: this.#provider,
          observedAtMs,
          pages,
        });
      }
      if (seenCursors.has(metadata.nextCursor)) {
        throw new AppServerWorkerManagerError("catalog_refresh_failed");
      }
      seenCursors.add(metadata.nextCursor);
      cursor = metadata.nextCursor;
    }
    throw new AppServerWorkerManagerError("catalog_refresh_failed");
  }

  async #collectAccountStatus(): Promise<AccountStatusSnapshot> {
    this.#requireAccountCollectionState();
    const response = await this.#worker.readAccount();
    this.#requireAccountCollectionState();
    return createAccountStatusSnapshot({
      schemaVersion: 1,
      snapshotId: this.#dependencies.newId(),
      workerSessionId: this.#workerSessionId,
      observedAtMs: this.#dependencies.now(),
      response,
    });
  }

  async #observeAccountUpdated(): Promise<void> {
    if (this.#state === "closing" || this.#state === "closed") {
      return;
    }
    this.#accountUpdatePending = true;
    await this.#settlePendingAccountUpdates();
  }

  async #settlePendingAccountUpdates(): Promise<void> {
    const existing = this.#accountUpdateRefresh;
    if (existing !== undefined) {
      await existing;
      return;
    }
    if (this.#state !== "ready" || !this.#accountUpdatePending) {
      return;
    }
    const refresh = this.#drainPendingAccountUpdates();
    this.#accountUpdateRefresh = refresh;
    void refresh.then(
      () => {
        if (this.#accountUpdateRefresh === refresh) {
          this.#accountUpdateRefresh = undefined;
        }
      },
      () => {
        if (this.#accountUpdateRefresh === refresh) {
          this.#accountUpdateRefresh = undefined;
        }
      },
    );
    await refresh;
  }

  async #drainPendingAccountUpdates(): Promise<void> {
    while (this.#state === "ready" && this.#accountUpdatePending) {
      this.#accountUpdatePending = false;
      await this.#refreshAccountStatusOnce();
    }
  }

  async #refreshAccountStatusOnce(): Promise<AccountStatusSnapshot> {
    if (this.#state !== "ready") {
      throw new AppServerWorkerManagerError(
        this.#state === "closing" || this.#state === "closed" ? "closed" : "refresh_unavailable",
      );
    }
    this.#state = "refreshing_account";
    this.#accountStatus = undefined;
    try {
      const snapshot = await this.#collectAccountStatus();
      this.#installAccountStatus(snapshot);
      return snapshot;
    } catch {
      await this.#beginClose("account_snapshot_failed");
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
  }

  #requireCatalogCollectionState(): void {
    if (
      (this.#state !== "starting" && this.#state !== "refreshing") ||
      this.#worker.state !== "ready" ||
      this.#closePromise !== undefined
    ) {
      throw new AppServerWorkerManagerError("catalog_refresh_failed");
    }
  }

  #requireAccountCollectionState(): void {
    if (
      (this.#state !== "starting" || this.#startupStage !== "account") &&
      this.#state !== "refreshing_account"
    ) {
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
    if (this.#worker.state !== "ready" || this.#closePromise !== undefined) {
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
  }

  #installCatalog(snapshot: ModelCatalogSnapshot, expectedState: "refreshing"): void {
    if (
      this.#state !== expectedState ||
      this.#worker.state !== "ready" ||
      this.#closePromise !== undefined ||
      snapshot.workerSessionId !== this.#workerSessionId
    ) {
      throw new AppServerWorkerManagerError("catalog_refresh_failed");
    }
    this.#catalog = snapshot;
    this.#state = "ready";
  }

  #installStartupSnapshots(
    catalog: ModelCatalogSnapshot,
    accountStatus: AccountStatusSnapshot,
  ): void {
    if (
      this.#state !== "starting" ||
      this.#startupStage !== "account" ||
      this.#worker.state !== "ready" ||
      this.#closePromise !== undefined ||
      catalog.workerSessionId !== this.#workerSessionId ||
      accountStatus.workerSessionId !== this.#workerSessionId
    ) {
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
    this.#catalog = catalog;
    this.#accountStatus = accountStatus;
    this.#state = "ready";
  }

  #installAccountStatus(snapshot: AccountStatusSnapshot): void {
    if (
      this.#state !== "refreshing_account" ||
      this.#worker.state !== "ready" ||
      this.#closePromise !== undefined ||
      snapshot.workerSessionId !== this.#workerSessionId
    ) {
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
    this.#accountStatus = snapshot;
    this.#state = "ready";
    for (const listener of this.#accountStatusListeners) {
      listener(snapshot);
    }
    if (
      this.#state !== "ready" ||
      this.#accountStatus !== snapshot ||
      this.#closePromise !== undefined
    ) {
      throw new AppServerWorkerManagerError("account_snapshot_failed");
    }
  }

  #publishesSnapshots(): boolean {
    return (
      this.#state === "ready" ||
      this.#state === "refreshing" ||
      this.#state === "refreshing_account"
    );
  }

  #failureReasonForState(): AppServerWorkerManagerCloseReason {
    if (this.#state === "refreshing_account") {
      return "account_snapshot_failed";
    }
    if (this.#state === "refreshing") {
      return "catalog_refresh_failed";
    }
    if (this.#state === "starting") {
      return this.#startupStage === "account"
        ? "account_snapshot_failed"
        : "catalog_refresh_failed";
    }
    return "worker_failure";
  }

  #beginClose(
    reason: AppServerWorkerManagerCloseReason,
    observedWorkerClose?: AppServerWorkerCloseResult,
  ): Promise<AppServerWorkerManagerCloseResult> {
    const existing = this.#closePromise;
    if (existing !== undefined) {
      return existing;
    }
    const closing = this.#closeManager(reason, observedWorkerClose);
    this.#closePromise = closing;
    return closing;
  }

  async #closeManager(
    reason: AppServerWorkerManagerCloseReason,
    observedWorkerClose?: AppServerWorkerCloseResult,
  ): Promise<AppServerWorkerManagerCloseResult> {
    this.#state = "closing";
    this.#catalog = undefined;
    this.#accountStatus = undefined;
    this.#accountStatusListeners.clear();

    let workerClose = normalizeWorkerCloseResult(observedWorkerClose) ?? this.#lastWorkerClose;
    if (workerClose === undefined) {
      try {
        workerClose = normalizeWorkerCloseResult(await this.#worker.close());
      } catch {
        workerClose = this.#lastWorkerClose;
      }
    }

    const result = Object.freeze({
      reason,
      workerSessionId: this.#workerSessionId,
      containment: workerClose?.containment ?? "containment_unknown",
      exitCode: workerClose?.exitCode ?? null,
      signal: workerClose?.signal ?? null,
      stderrObserved: workerClose?.stderrObserved ?? false,
    });
    this.#state = "closed";
    this.#resolveClosed(result);
    return result;
  }
}

function resolveCatalogPageStart(
  catalog: ModelCatalogSnapshot,
  visible: readonly ModelCatalogSnapshot["models"][number][],
  cursor: string | null,
): number {
  if (cursor === null) {
    return 0;
  }
  const decoded = decodeCatalogCursor(cursor);
  if (decoded.snapshotId !== catalog.snapshotId) {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  const index = visible.findIndex((model) => model.id === decoded.modelId);
  if (index < 0) {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  return index + 1;
}

function encodeCatalogCursor(snapshotId: string, modelId: string): string {
  const cursor = `${requireUuid(snapshotId)}.${Buffer.from(
    requirePublicModelId(modelId),
    "utf8",
  ).toString("base64url")}`;
  if (cursor.length > MAX_PUBLIC_CURSOR_CHARACTERS) {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  return cursor;
}

function decodeCatalogCursor(cursor: string): Readonly<{ snapshotId: string; modelId: string }> {
  if (
    cursor.length < 1 ||
    cursor.length > MAX_PUBLIC_CURSOR_CHARACTERS ||
    cursor.trim() !== cursor
  ) {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  const parts = cursor.split(".");
  if (parts.length !== 2 || parts[1] === "" || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  const bytes = Buffer.from(parts[1]!, "base64url");
  if (bytes.toString("base64url") !== parts[1]) {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  let modelId: string;
  try {
    modelId = publicCursorDecoder.decode(bytes);
  } catch {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  return Object.freeze({
    snapshotId: requireUuid(parts[0]),
    modelId: requirePublicModelId(modelId),
  });
}

function requirePublicModelId(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > MAX_MODEL_ID_CHARACTERS ||
    input.trim() !== input ||
    containsControlCharacter(input)
  ) {
    throw new AppServerWorkerManagerError("catalog_page_unavailable");
  }
  return input;
}

function normalizeProvider(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > MAX_PROVIDER_CHARACTERS ||
    input.trim() !== input ||
    containsControlCharacter(input)
  ) {
    throw new AppServerWorkerManagerError("invalid_configuration");
  }
  return input;
}

function normalizeDependencies(input: unknown): AppServerWorkerManagerDependencies {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as AppServerWorkerManagerDependencies).startWorker !== "function" ||
      typeof (input as AppServerWorkerManagerDependencies).newId !== "function" ||
      typeof (input as AppServerWorkerManagerDependencies).now !== "function"
    ) {
      throw new AppServerWorkerManagerError("invalid_configuration");
    }
    return input as AppServerWorkerManagerDependencies;
  } catch {
    throw new AppServerWorkerManagerError("invalid_configuration");
  }
}

function requireUuid(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new AppServerWorkerManagerError("invalid_configuration");
  }
  return input;
}

function requireObservedAt(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new AppServerWorkerManagerError("catalog_refresh_failed");
  }
  return input;
}

function readPageMetadata(response: unknown): Readonly<{
  nextCursor: string | null;
  modelCount: number;
  responseBytes: number;
}> {
  if (!validateJsonValue(response).ok || !isRecord(response)) {
    throw new AppServerWorkerManagerError("catalog_refresh_failed");
  }
  if (!Array.isArray(response.data) || response.data.length > MAX_CATALOG_MODELS) {
    throw new AppServerWorkerManagerError("catalog_refresh_failed");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(response);
  } catch {
    throw new AppServerWorkerManagerError("catalog_refresh_failed");
  }
  if (serialized === undefined) {
    throw new AppServerWorkerManagerError("catalog_refresh_failed");
  }
  const cursor = response.nextCursor;
  if (cursor === null) {
    return Object.freeze({
      nextCursor: null,
      modelCount: response.data.length,
      responseBytes: Buffer.byteLength(serialized, "utf8"),
    });
  }
  if (
    typeof cursor !== "string" ||
    cursor.length < 1 ||
    cursor.length > MAX_CURSOR_CHARACTERS ||
    containsControlCharacter(cursor)
  ) {
    throw new AppServerWorkerManagerError("catalog_refresh_failed");
  }
  return Object.freeze({
    nextCursor: cursor,
    modelCount: response.data.length,
    responseBytes: Buffer.byteLength(serialized, "utf8"),
  });
}

function normalizeWorkerCloseResult(input: unknown): AppServerWorkerCloseResult | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  try {
    const reason = input.reason;
    const containment = input.containment;
    const exitCode = input.exitCode;
    const signal = input.signal;
    const stderrObserved = input.stderrObserved;
    if (
      !WORKER_CLOSE_REASONS.has(reason) ||
      !WORKER_CONTAINMENTS.has(containment) ||
      (exitCode !== null && !Number.isSafeInteger(exitCode)) ||
      (signal !== null &&
        (typeof signal !== "string" || !Object.hasOwn(osConstants.signals, signal))) ||
      typeof stderrObserved !== "boolean"
    ) {
      return undefined;
    }
    return Object.freeze({
      reason: reason as AppServerWorkerCloseResult["reason"],
      containment: containment as AppServerWorkerContainment,
      exitCode: exitCode as number | null,
      signal: signal as NodeJS.Signals | null,
      stderrObserved,
    });
  } catch {
    return undefined;
  }
}

const WORKER_CLOSE_REASONS = new Set<unknown>([
  "event_handler_failure",
  "protocol_failure",
  "request_timeout",
  "requested",
  "unsupported_server_request",
  "worker_exited",
]);

const WORKER_CONTAINMENTS = new Set<unknown>([
  "already_exited",
  "containment_unknown",
  "graceful",
  "sigkill",
  "sigterm",
]);

function isManagedWorker(input: unknown): input is ManagedAppServerWorker {
  if (!isRecord(input)) {
    return false;
  }
  try {
    const closed = input.closed;
    return (
      typeof input.state === "string" &&
      typeof input.listModels === "function" &&
      typeof input.readAccount === "function" &&
      typeof input.close === "function" &&
      typeof closed === "object" &&
      closed !== null &&
      typeof (closed as Promise<unknown>).then === "function"
    );
  } catch {
    return false;
  }
}

async function closeInvalidWorker(worker: unknown): Promise<void> {
  try {
    if (!isRecord(worker) || typeof worker.close !== "function") {
      return;
    }
    await (worker.close as () => Promise<unknown>).call(worker);
  } catch {
    // A failed test seam or invalid worker cannot provide stronger containment evidence here.
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function containsControlCharacter(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
