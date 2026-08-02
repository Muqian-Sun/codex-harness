export const DESKTOP_BOOTSTRAP_FAILURE_CODES = Object.freeze([
  "unsupported_platform",
  "resource_configuration_missing",
  "resource_invalid",
  "runtime_root_insecure",
  "daemon_startup_failed",
  "daemon_unavailable",
  "internal_error",
] as const);

export type DesktopBootstrapFailureCode = (typeof DESKTOP_BOOTSTRAP_FAILURE_CODES)[number];

export const DESKTOP_ACCOUNT_PLAN_TYPES = Object.freeze([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
] as const);

export type DesktopAccountPlanType = (typeof DESKTOP_ACCOUNT_PLAN_TYPES)[number];
export type DesktopAccountStatus = Readonly<{
  status: "authenticated" | "authentication_required" | "not_required";
  credentialKind: "amazon_bedrock" | "api_key" | "chatgpt" | null;
  planType: DesktopAccountPlanType | null;
}>;

export type DesktopModelInputModality = "audio" | "image" | "text";
export type DesktopModelCatalogEntry = Readonly<{
  model: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly string[];
  inputModalities: readonly DesktopModelInputModality[];
}>;
export type DesktopModelCatalogSummary = Readonly<{
  provider: string;
  totalVisibleModels: number;
  models: readonly DesktopModelCatalogEntry[];
  hasMore: boolean;
}>;

export type DesktopBootstrapState =
  | Readonly<{ phase: "starting" }>
  | Readonly<{
      phase: "ready";
      account: DesktopAccountStatus;
      catalog: DesktopModelCatalogSummary;
    }>
  | Readonly<{ phase: "failed"; code: DesktopBootstrapFailureCode }>
  | Readonly<{ phase: "stopping" }>;

const failureCodes = new Set<string>(DESKTOP_BOOTSTRAP_FAILURE_CODES);
const planTypes = new Set<string>(DESKTOP_ACCOUNT_PLAN_TYPES);
const modelInputModalities = new Set<string>(["audio", "image", "text"]);
const MAX_PROVIDER_CHARACTERS = 256;
const MAX_MODEL_CHARACTERS = 4_096;
const MAX_REASONING_EFFORT_CHARACTERS = 128;
const MAX_MODEL_CATALOG_PAGE_SIZE = 16;
const MAX_MODEL_REASONING_EFFORTS = 64;

export function decodeDesktopBootstrapState(input: unknown): DesktopBootstrapState | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.phase === "ready") {
    if (
      keys.length !== 3 ||
      !keys.includes("phase") ||
      !keys.includes("account") ||
      !keys.includes("catalog")
    ) {
      return undefined;
    }
    const account = decodeDesktopAccountStatus(record.account, true);
    const catalog = decodeDesktopModelCatalogSummary(record.catalog);
    return account === undefined || catalog === undefined
      ? undefined
      : Object.freeze({ phase: "ready", account, catalog });
  }
  if (record.phase === "failed") {
    if (
      keys.length !== 2 ||
      !keys.includes("phase") ||
      !keys.includes("code") ||
      typeof record.code !== "string" ||
      !failureCodes.has(record.code)
    ) {
      return undefined;
    }
    return failedBootstrapState(record.code as DesktopBootstrapFailureCode);
  }
  if (
    keys.length !== 1 ||
    keys[0] !== "phase" ||
    (record.phase !== "starting" && record.phase !== "stopping")
  ) {
    return undefined;
  }
  return Object.freeze({ phase: record.phase });
}

export function advanceDesktopBootstrapState(
  current: DesktopBootstrapState,
  candidate: DesktopBootstrapState,
): DesktopBootstrapState {
  return canTransition(current.phase, candidate.phase) ? candidate : current;
}

export function failedBootstrapState(code: DesktopBootstrapFailureCode): DesktopBootstrapState {
  return Object.freeze({ phase: "failed", code });
}

export function projectDesktopModelCatalogSummary(input: unknown): DesktopModelCatalogSummary {
  const summary = projectModelCatalogPage(input);
  if (summary === undefined) {
    throw new BootstrapStateTransitionError();
  }
  return summary;
}

export function readyBootstrapState(
  accountInput: unknown,
  catalogInput: unknown,
): DesktopBootstrapState {
  const account = decodeDesktopAccountStatus(accountInput, false);
  const catalog = decodeDesktopModelCatalogSummary(catalogInput);
  if (account === undefined || catalog === undefined) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({ phase: "ready", account, catalog });
}

export function initialBootstrapState(): DesktopBootstrapState {
  return Object.freeze({ phase: "starting" });
}

export class BootstrapStateTransitionError extends Error {
  constructor() {
    super("The desktop bootstrap state transition is invalid.");
    this.name = "BootstrapStateTransitionError";
  }
}

export class BootstrapStateStore {
  readonly #listeners = new Set<(state: DesktopBootstrapState) => void>();
  #state = initialBootstrapState();

  get current(): DesktopBootstrapState {
    return this.#state;
  }

  transition(next: DesktopBootstrapState): void {
    const decoded = decodeDesktopBootstrapState(next);
    if (decoded === undefined || !canTransition(this.#state.phase, decoded.phase)) {
      throw new BootstrapStateTransitionError();
    }
    if (sameState(this.#state, decoded)) {
      return;
    }
    this.#state = decoded;
    for (const listener of this.#listeners) {
      try {
        listener(decoded);
      } catch {
        // A renderer or other observer must not interrupt the application lifecycle.
      }
    }
  }

  subscribe(listener: (state: DesktopBootstrapState) => void): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }
}

function decodeDesktopAccountStatus(
  input: unknown,
  requireExactKeys: boolean,
): DesktopAccountStatus | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    requireExactKeys &&
    (keys.length !== 3 ||
      !keys.includes("status") ||
      !keys.includes("credentialKind") ||
      !keys.includes("planType"))
  ) {
    return undefined;
  }
  const status = record.status;
  const credentialKind = record.credentialKind;
  const planType = record.planType;
  if (
    (status !== "authenticated" &&
      status !== "authentication_required" &&
      status !== "not_required") ||
    (credentialKind !== null &&
      credentialKind !== "amazon_bedrock" &&
      credentialKind !== "api_key" &&
      credentialKind !== "chatgpt") ||
    (planType !== null && (typeof planType !== "string" || !planTypes.has(planType))) ||
    (status === "authenticated" && credentialKind === null) ||
    (status !== "authenticated" && credentialKind !== null) ||
    (credentialKind === "chatgpt" ? planType === null : planType !== null)
  ) {
    return undefined;
  }
  return Object.freeze({
    status,
    credentialKind,
    planType: planType as DesktopAccountPlanType | null,
  });
}

function sameState(current: DesktopBootstrapState, candidate: DesktopBootstrapState): boolean {
  if (current.phase !== candidate.phase) {
    return false;
  }
  if (current.phase === "failed" && candidate.phase === "failed") {
    return current.code === candidate.code;
  }
  if (current.phase === "ready" && candidate.phase === "ready") {
    return (
      current.account.status === candidate.account.status &&
      current.account.credentialKind === candidate.account.credentialKind &&
      current.account.planType === candidate.account.planType &&
      modelCatalogSummariesEqual(current.catalog, candidate.catalog)
    );
  }
  return true;
}

function projectModelCatalogPage(input: unknown): DesktopModelCatalogSummary | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 5 ||
    !keys.includes("schemaVersion") ||
    !keys.includes("provider") ||
    !keys.includes("totalVisibleModels") ||
    !keys.includes("models") ||
    !keys.includes("nextCursor") ||
    record.schemaVersion !== 1 ||
    (typeof record.nextCursor !== "string" && record.nextCursor !== null)
  ) {
    return undefined;
  }
  const decoded = decodeModelCatalogFields(record, record.nextCursor !== null);
  if (decoded === undefined) {
    return undefined;
  }
  return decoded;
}

function decodeDesktopModelCatalogSummary(input: unknown): DesktopModelCatalogSummary | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4 ||
    !keys.includes("provider") ||
    !keys.includes("totalVisibleModels") ||
    !keys.includes("models") ||
    !keys.includes("hasMore") ||
    typeof record.hasMore !== "boolean"
  ) {
    return undefined;
  }
  return decodeModelCatalogFields(record, record.hasMore);
}

function decodeModelCatalogFields(
  record: Record<string, unknown>,
  hasMore: boolean,
): DesktopModelCatalogSummary | undefined {
  if (
    !validBoundedText(record.provider, MAX_PROVIDER_CHARACTERS) ||
    !Number.isSafeInteger(record.totalVisibleModels) ||
    (record.totalVisibleModels as number) < 0 ||
    (record.totalVisibleModels as number) > 10_000 ||
    !Array.isArray(record.models) ||
    record.models.length > MAX_MODEL_CATALOG_PAGE_SIZE
  ) {
    return undefined;
  }
  const models = record.models.map(decodeDesktopModelCatalogEntry);
  if (models.some((model) => model === undefined)) {
    return undefined;
  }
  const decodedModels = models as DesktopModelCatalogEntry[];
  const totalVisibleModels = record.totalVisibleModels as number;
  if (
    decodedModels.length > totalVisibleModels ||
    (hasMore
      ? totalVisibleModels <= decodedModels.length
      : totalVisibleModels !== decodedModels.length) ||
    new Set(decodedModels.map((model) => model.model)).size !== decodedModels.length
  ) {
    return undefined;
  }
  return Object.freeze({
    provider: record.provider,
    totalVisibleModels,
    models: Object.freeze(decodedModels),
    hasMore,
  });
}

function decodeDesktopModelCatalogEntry(input: unknown): DesktopModelCatalogEntry | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4 ||
    !keys.includes("model") ||
    !keys.includes("defaultReasoningEffort") ||
    !keys.includes("supportedReasoningEfforts") ||
    !keys.includes("inputModalities") ||
    !validBoundedText(record.model, MAX_MODEL_CHARACTERS) ||
    !validBoundedText(record.defaultReasoningEffort, MAX_REASONING_EFFORT_CHARACTERS) ||
    !Array.isArray(record.supportedReasoningEfforts) ||
    record.supportedReasoningEfforts.length < 1 ||
    record.supportedReasoningEfforts.length > MAX_MODEL_REASONING_EFFORTS ||
    !record.supportedReasoningEfforts.every((effort) =>
      validBoundedText(effort, MAX_REASONING_EFFORT_CHARACTERS),
    ) ||
    new Set(record.supportedReasoningEfforts).size !== record.supportedReasoningEfforts.length ||
    !record.supportedReasoningEfforts.includes(record.defaultReasoningEffort) ||
    !Array.isArray(record.inputModalities) ||
    record.inputModalities.length < 1 ||
    record.inputModalities.length > 3 ||
    !record.inputModalities.every(
      (modality) => typeof modality === "string" && modelInputModalities.has(modality),
    ) ||
    new Set(record.inputModalities).size !== record.inputModalities.length
  ) {
    return undefined;
  }
  return Object.freeze({
    model: record.model,
    defaultReasoningEffort: record.defaultReasoningEffort,
    supportedReasoningEfforts: Object.freeze([...record.supportedReasoningEfforts]),
    inputModalities: Object.freeze([...record.inputModalities] as DesktopModelInputModality[]),
  });
}

function validBoundedText(input: unknown, maxCharacters: number): input is string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maxCharacters ||
    input.trim() !== input
  ) {
    return false;
  }
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return false;
    }
  }
  return true;
}

function modelCatalogSummariesEqual(
  left: DesktopModelCatalogSummary,
  right: DesktopModelCatalogSummary,
): boolean {
  if (
    left.provider !== right.provider ||
    left.totalVisibleModels !== right.totalVisibleModels ||
    left.hasMore !== right.hasMore ||
    left.models.length !== right.models.length
  ) {
    return false;
  }
  return left.models.every((model, index) => {
    const other = right.models[index];
    return (
      other !== undefined &&
      model.model === other.model &&
      model.defaultReasoningEffort === other.defaultReasoningEffort &&
      stringArraysEqual(model.supportedReasoningEfforts, other.supportedReasoningEfforts) &&
      stringArraysEqual(model.inputModalities, other.inputModalities)
    );
  });
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canTransition(
  current: DesktopBootstrapState["phase"],
  next: DesktopBootstrapState["phase"],
): boolean {
  if (current === next) {
    return true;
  }
  switch (current) {
    case "starting":
      return next === "ready" || next === "failed" || next === "stopping";
    case "ready":
      return next === "failed" || next === "stopping";
    case "failed":
      return next === "stopping";
    case "stopping":
      return false;
  }
}
