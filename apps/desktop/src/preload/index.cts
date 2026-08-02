const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const GET_BOOTSTRAP_STATE_CHANNEL = "desktop.bootstrap.get";
const BOOTSTRAP_STATE_CHANGED_CHANNEL = "desktop.bootstrap.changed";
const SET_ROUTING_CONFIGURATION_CHANNEL = "desktop.routing.set";
const FAILURE_CODES = new Set([
  "unsupported_platform",
  "resource_configuration_missing",
  "resource_invalid",
  "runtime_root_insecure",
  "daemon_startup_failed",
  "daemon_unavailable",
  "internal_error",
]);
const ACCOUNT_PLAN_TYPES = new Set([
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
]);
const MODEL_INPUT_MODALITIES = new Set(["audio", "image", "text"]);
const ROUTING_AVAILABILITY_STATUSES = new Set([
  "model_unavailable",
  "observed_available",
  "provider_unobserved",
  "reasoning_effort_unsupported",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROVIDER_CHARACTERS = 256;
const MAX_MODEL_CHARACTERS = 4_096;
const MAX_REASONING_EFFORT_CHARACTERS = 128;
const MAX_MODEL_CATALOG_PAGE_SIZE = 16;
const MAX_MODEL_REASONING_EFFORTS = 64;

type PreloadAccountStatus = Readonly<{
  status: "authenticated" | "authentication_required" | "not_required";
  credentialKind: "amazon_bedrock" | "api_key" | "chatgpt" | null;
  planType: string | null;
}>;

type PreloadModelCatalogEntry = Readonly<{
  model: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly string[];
  inputModalities: readonly ("audio" | "image" | "text")[];
}>;

type PreloadModelCatalogSummary = Readonly<{
  provider: string;
  totalVisibleModels: number;
  models: readonly PreloadModelCatalogEntry[];
  hasMore: boolean;
}>;

type PreloadRoutingTarget = Readonly<{
  provider: string;
  model: string;
  reasoningEffort: string;
}>;
type PreloadRoutingTargets = Readonly<{
  fast: PreloadRoutingTarget;
  standard: PreloadRoutingTarget;
  deep: PreloadRoutingTarget;
}>;
type PreloadRoutingConfiguration = Readonly<{
  configured: boolean;
  profileVersion: number;
  configurationRevisionId: string | null;
  tiers: PreloadRoutingTargets | null;
  availability: Readonly<Record<"fast" | "standard" | "deep", string>> | null;
}>;
type PreloadRoutingConfigurationUpdate = Readonly<{
  expectedProfileVersion: number;
  previousConfigurationRevisionId: string | null;
  tiers: PreloadRoutingTargets;
}>;
type PreloadRoutingMutationResult =
  | Readonly<{ status: "saved" | "conflict"; routing: PreloadRoutingConfiguration }>
  | Readonly<{ status: "unavailable" }>;

type PreloadBootstrapState =
  | Readonly<{ phase: "starting" | "stopping" }>
  | Readonly<{
      phase: "ready";
      account: PreloadAccountStatus;
      catalog: PreloadModelCatalogSummary;
      routing: PreloadRoutingConfiguration;
    }>
  | Readonly<{ phase: "failed"; code: string }>;

function decodeBootstrapState(input: unknown): PreloadBootstrapState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("The desktop bootstrap state is invalid.");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    record.phase === "ready" &&
    keys.length === 4 &&
    keys.includes("phase") &&
    keys.includes("account") &&
    keys.includes("catalog") &&
    keys.includes("routing")
  ) {
    const account = decodeAccountStatus(record.account);
    const catalog = decodeModelCatalogSummary(record.catalog);
    const routing = decodeRoutingConfiguration(record.routing);
    if (account !== undefined && catalog !== undefined && routing !== undefined) {
      return Object.freeze({ phase: "ready", account, catalog, routing });
    }
  }
  if (
    record.phase === "failed" &&
    keys.length === 2 &&
    keys.includes("phase") &&
    keys.includes("code") &&
    typeof record.code === "string" &&
    FAILURE_CODES.has(record.code)
  ) {
    return Object.freeze({ phase: "failed", code: record.code });
  }
  if (
    keys.length === 1 &&
    keys[0] === "phase" &&
    (record.phase === "starting" || record.phase === "stopping")
  ) {
    return Object.freeze({ phase: record.phase });
  }
  throw new Error("The desktop bootstrap state is invalid.");
}

function decodeRoutingConfiguration(input: unknown): PreloadRoutingConfiguration | undefined {
  const record = exactRecord(input, [
    "availability",
    "configurationRevisionId",
    "configured",
    "profileVersion",
    "tiers",
  ]);
  if (record === undefined) {
    return undefined;
  }
  const tiers = record.tiers === null ? null : decodeRoutingTargets(record.tiers);
  const availability =
    record.availability === null ? null : decodeRoutingAvailability(record.availability);
  const configuredShape =
    record.configured === true &&
    isPositiveSafeInteger(record.profileVersion) &&
    isUuid(record.configurationRevisionId) &&
    tiers !== null &&
    tiers !== undefined &&
    availability !== null &&
    availability !== undefined;
  const unconfiguredShape =
    record.configured === false &&
    record.profileVersion === 0 &&
    record.configurationRevisionId === null &&
    tiers === null &&
    availability === null;
  if (!configuredShape && !unconfiguredShape) {
    return undefined;
  }
  return Object.freeze({
    configured: record.configured as boolean,
    profileVersion: record.profileVersion as number,
    configurationRevisionId: record.configurationRevisionId as string | null,
    tiers: tiers ?? null,
    availability: availability ?? null,
  });
}

function decodeRoutingUpdate(input: unknown): PreloadRoutingConfigurationUpdate | undefined {
  const record = exactRecord(input, [
    "expectedProfileVersion",
    "previousConfigurationRevisionId",
    "tiers",
  ]);
  if (record === undefined) {
    return undefined;
  }
  const tiers = decodeRoutingTargets(record.tiers);
  if (
    !isNonNegativeSafeInteger(record.expectedProfileVersion) ||
    (record.previousConfigurationRevisionId !== null &&
      !isUuid(record.previousConfigurationRevisionId)) ||
    (record.expectedProfileVersion === 0) !== (record.previousConfigurationRevisionId === null) ||
    tiers === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    expectedProfileVersion: record.expectedProfileVersion,
    previousConfigurationRevisionId: record.previousConfigurationRevisionId,
    tiers,
  });
}

function decodeRoutingMutationResult(input: unknown): PreloadRoutingMutationResult {
  const unavailable = exactRecord(input, ["status"]);
  if (unavailable?.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  const record = exactRecord(input, ["routing", "status"]);
  if (record === undefined || (record.status !== "saved" && record.status !== "conflict")) {
    throw new Error("The desktop routing result is invalid.");
  }
  const routing = decodeRoutingConfiguration(record.routing);
  if (routing === undefined) {
    throw new Error("The desktop routing result is invalid.");
  }
  return Object.freeze({ status: record.status, routing });
}

function decodeRoutingTargets(input: unknown): PreloadRoutingTargets | undefined {
  const record = exactRecord(input, ["deep", "fast", "standard"]);
  if (record === undefined) {
    return undefined;
  }
  const fast = decodeRoutingTarget(record.fast);
  const standard = decodeRoutingTarget(record.standard);
  const deep = decodeRoutingTarget(record.deep);
  return fast === undefined || standard === undefined || deep === undefined
    ? undefined
    : Object.freeze({ fast, standard, deep });
}

function decodeRoutingTarget(input: unknown): PreloadRoutingTarget | undefined {
  const record = exactRecord(input, ["model", "provider", "reasoningEffort"]);
  if (
    record === undefined ||
    !validBoundedText(record.provider, MAX_PROVIDER_CHARACTERS) ||
    !validBoundedText(record.model, MAX_MODEL_CHARACTERS) ||
    !validBoundedText(record.reasoningEffort, MAX_REASONING_EFFORT_CHARACTERS)
  ) {
    return undefined;
  }
  return Object.freeze({
    provider: record.provider,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
  });
}

function decodeRoutingAvailability(
  input: unknown,
): Readonly<Record<"fast" | "standard" | "deep", string>> | undefined {
  const record = exactRecord(input, ["deep", "fast", "standard"]);
  if (
    record === undefined ||
    ![record.fast, record.standard, record.deep].every(
      (status) => typeof status === "string" && ROUTING_AVAILABILITY_STATUSES.has(status),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    fast: record.fast as string,
    standard: record.standard as string,
    deep: record.deep as string,
  });
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    ? record
    : undefined;
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function isNonNegativeSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

function isPositiveSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 1;
}

function decodeAccountStatus(input: unknown): PreloadAccountStatus | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  const status = record.status;
  const credentialKind = record.credentialKind;
  const planType = record.planType;
  if (
    keys.length !== 3 ||
    !keys.includes("status") ||
    !keys.includes("credentialKind") ||
    !keys.includes("planType") ||
    (status !== "authenticated" &&
      status !== "authentication_required" &&
      status !== "not_required") ||
    (credentialKind !== null &&
      credentialKind !== "amazon_bedrock" &&
      credentialKind !== "api_key" &&
      credentialKind !== "chatgpt") ||
    (planType !== null && (typeof planType !== "string" || !ACCOUNT_PLAN_TYPES.has(planType))) ||
    (status === "authenticated" && credentialKind === null) ||
    (status !== "authenticated" && credentialKind !== null) ||
    (credentialKind === "chatgpt" ? planType === null : planType !== null)
  ) {
    return undefined;
  }
  return Object.freeze({ status, credentialKind, planType });
}

function decodeModelCatalogSummary(input: unknown): PreloadModelCatalogSummary | undefined {
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
    !validBoundedText(record.provider, MAX_PROVIDER_CHARACTERS) ||
    !Number.isSafeInteger(record.totalVisibleModels) ||
    (record.totalVisibleModels as number) < 0 ||
    (record.totalVisibleModels as number) > 10_000 ||
    !Array.isArray(record.models) ||
    record.models.length > MAX_MODEL_CATALOG_PAGE_SIZE ||
    typeof record.hasMore !== "boolean"
  ) {
    return undefined;
  }
  const models = record.models.map(decodeModelCatalogEntry);
  if (models.some((model) => model === undefined)) {
    return undefined;
  }
  const decodedModels = models as PreloadModelCatalogEntry[];
  const totalVisibleModels = record.totalVisibleModels as number;
  if (
    decodedModels.length > totalVisibleModels ||
    (record.hasMore
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
    hasMore: record.hasMore,
  });
}

function decodeModelCatalogEntry(input: unknown): PreloadModelCatalogEntry | undefined {
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
      (modality) => typeof modality === "string" && MODEL_INPUT_MODALITIES.has(modality),
    ) ||
    new Set(record.inputModalities).size !== record.inputModalities.length
  ) {
    return undefined;
  }
  return Object.freeze({
    model: record.model,
    defaultReasoningEffort: record.defaultReasoningEffort,
    supportedReasoningEfforts: Object.freeze([...record.supportedReasoningEfforts]),
    inputModalities: Object.freeze([...record.inputModalities] as ("audio" | "image" | "text")[]),
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

const desktopApi = Object.freeze({
  async getBootstrapState(): Promise<PreloadBootstrapState> {
    return decodeBootstrapState(await ipcRenderer.invoke(GET_BOOTSTRAP_STATE_CHANNEL));
  },
  async setRoutingConfiguration(
    input: PreloadRoutingConfigurationUpdate,
  ): Promise<PreloadRoutingMutationResult> {
    const update = decodeRoutingUpdate(input);
    if (update === undefined) {
      throw new TypeError("A valid desktop routing update is required.");
    }
    return decodeRoutingMutationResult(
      await ipcRenderer.invoke(SET_ROUTING_CONFIGURATION_CHANNEL, update),
    );
  },
  onBootstrapState(listener: (state: PreloadBootstrapState) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("A desktop bootstrap listener is required.");
    }
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(decodeBootstrapState(value));
      } catch {
        listener(Object.freeze({ phase: "failed", code: "internal_error" }));
      }
    };
    ipcRenderer.on(BOOTSTRAP_STATE_CHANGED_CHANNEL, handler);
    return (): void => {
      ipcRenderer.removeListener(BOOTSTRAP_STATE_CHANGED_CHANNEL, handler);
    };
  },
});

contextBridge.exposeInMainWorld("codexHarness", desktopApi);
