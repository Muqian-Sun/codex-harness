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

export type DesktopBootstrapState =
  | Readonly<{ phase: "starting" }>
  | Readonly<{ phase: "ready"; account: DesktopAccountStatus }>
  | Readonly<{ phase: "failed"; code: DesktopBootstrapFailureCode }>
  | Readonly<{ phase: "stopping" }>;

const failureCodes = new Set<string>(DESKTOP_BOOTSTRAP_FAILURE_CODES);
const planTypes = new Set<string>(DESKTOP_ACCOUNT_PLAN_TYPES);

export function decodeDesktopBootstrapState(input: unknown): DesktopBootstrapState | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.phase === "ready") {
    if (keys.length !== 2 || !keys.includes("phase") || !keys.includes("account")) {
      return undefined;
    }
    const account = decodeDesktopAccountStatus(record.account, true);
    return account === undefined ? undefined : Object.freeze({ phase: "ready", account });
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

export function readyBootstrapState(input: unknown): DesktopBootstrapState {
  const account = decodeDesktopAccountStatus(input, false);
  if (account === undefined) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({ phase: "ready", account });
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
      current.account.planType === candidate.account.planType
    );
  }
  return true;
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
