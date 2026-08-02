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

type PreloadAccountStatus = Readonly<{
  status: "authenticated" | "authentication_required" | "not_required";
  credentialKind: "amazon_bedrock" | "api_key" | "chatgpt" | null;
  planType: string | null;
}>;

type PreloadBootstrapState =
  | Readonly<{ phase: "starting" | "stopping" }>
  | Readonly<{ phase: "ready"; account: PreloadAccountStatus }>
  | Readonly<{ phase: "failed"; code: string }>;

function decodeBootstrapState(input: unknown): PreloadBootstrapState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("The desktop bootstrap state is invalid.");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    record.phase === "ready" &&
    keys.length === 2 &&
    keys.includes("phase") &&
    keys.includes("account")
  ) {
    const account = decodeAccountStatus(record.account);
    if (account !== undefined) {
      return Object.freeze({ phase: "ready", account });
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
