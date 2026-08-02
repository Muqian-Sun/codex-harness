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

export type DesktopBootstrapState =
  | Readonly<{ phase: "starting" }>
  | Readonly<{ phase: "ready" }>
  | Readonly<{ phase: "failed"; code: DesktopBootstrapFailureCode }>
  | Readonly<{ phase: "stopping" }>;

const failureCodes = new Set<string>(DESKTOP_BOOTSTRAP_FAILURE_CODES);

export function decodeDesktopBootstrapState(input: unknown): DesktopBootstrapState | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
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
    (record.phase !== "starting" && record.phase !== "ready" && record.phase !== "stopping")
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
    if (
      this.#state.phase === decoded.phase &&
      (decoded.phase !== "failed" ||
        (this.#state.phase === "failed" && this.#state.code === decoded.code))
    ) {
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
