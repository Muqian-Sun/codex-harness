const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const GET_BOOTSTRAP_STATE_CHANNEL = "desktop.bootstrap.get";
const BOOTSTRAP_STATE_CHANGED_CHANNEL = "desktop.bootstrap.changed";
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

type PreloadBootstrapState =
  | Readonly<{ phase: "starting" | "stopping" }>
  | Readonly<{
      phase: "ready";
      account: PreloadAccountStatus;
      catalog: PreloadModelCatalogSummary;
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
    keys.length === 3 &&
    keys.includes("phase") &&
    keys.includes("account") &&
    keys.includes("catalog")
  ) {
    const account = decodeAccountStatus(record.account);
    const catalog = decodeModelCatalogSummary(record.catalog);
    if (account !== undefined && catalog !== undefined) {
      return Object.freeze({ phase: "ready", account, catalog });
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
