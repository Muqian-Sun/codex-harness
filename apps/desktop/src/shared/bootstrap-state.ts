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

export const DESKTOP_ROUTING_TIERS = Object.freeze(["fast", "standard", "deep"] as const);
export const DESKTOP_ROUTING_AVAILABILITY_STATUSES = Object.freeze([
  "model_unavailable",
  "observed_available",
  "provider_unobserved",
  "reasoning_effort_unsupported",
] as const);

export type DesktopRoutingTier = (typeof DESKTOP_ROUTING_TIERS)[number];
export type DesktopRoutingAvailabilityStatus =
  (typeof DESKTOP_ROUTING_AVAILABILITY_STATUSES)[number];
export type DesktopRoutingTierTarget = Readonly<{
  provider: string;
  model: string;
  reasoningEffort: string;
}>;
export type DesktopRoutingTierTargets = Readonly<
  Record<DesktopRoutingTier, DesktopRoutingTierTarget>
>;
export type DesktopRoutingConfiguration = Readonly<{
  configured: boolean;
  profileVersion: number;
  configurationRevisionId: string | null;
  tiers: DesktopRoutingTierTargets | null;
  availability: Readonly<Record<DesktopRoutingTier, DesktopRoutingAvailabilityStatus>> | null;
}>;
export type DesktopRoutingConfigurationUpdate = Readonly<{
  expectedProfileVersion: number;
  previousConfigurationRevisionId: string | null;
  tiers: DesktopRoutingTierTargets;
}>;
export type DesktopRoutingConfigurationMutationResult =
  | Readonly<{
      status: "saved" | "conflict";
      routing: DesktopRoutingConfiguration;
    }>
  | Readonly<{ status: "unavailable" }>;

export type DesktopBootstrapState =
  | Readonly<{ phase: "starting" }>
  | Readonly<{
      phase: "ready";
      account: DesktopAccountStatus;
      catalog: DesktopModelCatalogSummary;
      routing: DesktopRoutingConfiguration;
    }>
  | Readonly<{ phase: "failed"; code: DesktopBootstrapFailureCode }>
  | Readonly<{ phase: "stopping" }>;

const failureCodes = new Set<string>(DESKTOP_BOOTSTRAP_FAILURE_CODES);
const planTypes = new Set<string>(DESKTOP_ACCOUNT_PLAN_TYPES);
const modelInputModalities = new Set<string>(["audio", "image", "text"]);
const routingAvailabilityStatuses = new Set<string>(DESKTOP_ROUTING_AVAILABILITY_STATUSES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
      keys.length !== 4 ||
      !keys.includes("phase") ||
      !keys.includes("account") ||
      !keys.includes("catalog") ||
      !keys.includes("routing")
    ) {
      return undefined;
    }
    const account = decodeDesktopAccountStatus(record.account, true);
    const catalog = decodeDesktopModelCatalogSummary(record.catalog);
    const routing = decodeDesktopRoutingConfiguration(record.routing, false);
    return account === undefined || catalog === undefined || routing === undefined
      ? undefined
      : Object.freeze({ phase: "ready", account, catalog, routing });
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
  routingInput: unknown,
): DesktopBootstrapState {
  const account = decodeDesktopAccountStatus(accountInput, false);
  const catalog = decodeDesktopModelCatalogSummary(catalogInput);
  const routing = decodeDesktopRoutingConfiguration(routingInput, false);
  if (account === undefined || catalog === undefined || routing === undefined) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({ phase: "ready", account, catalog, routing });
}

export function projectDesktopRoutingConfiguration(input: unknown): DesktopRoutingConfiguration {
  const routing = decodeDesktopRoutingConfiguration(input, true);
  if (routing === undefined) {
    throw new BootstrapStateTransitionError();
  }
  return routing;
}

export function decodeDesktopRoutingConfigurationUpdate(
  input: unknown,
): DesktopRoutingConfigurationUpdate | undefined {
  const record = exactRecord(input, [
    "expectedProfileVersion",
    "previousConfigurationRevisionId",
    "tiers",
  ]);
  if (record === undefined) {
    return undefined;
  }
  const expectedProfileVersion = record.expectedProfileVersion;
  const previousConfigurationRevisionId = record.previousConfigurationRevisionId;
  const tiers = decodeRoutingTierTargets(record.tiers);
  if (
    !isNonNegativeSafeInteger(expectedProfileVersion) ||
    (previousConfigurationRevisionId !== null && !isUuid(previousConfigurationRevisionId)) ||
    (expectedProfileVersion === 0) !== (previousConfigurationRevisionId === null) ||
    tiers === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ expectedProfileVersion, previousConfigurationRevisionId, tiers });
}

export function decodeDesktopRoutingConfigurationMutationResult(
  input: unknown,
): DesktopRoutingConfigurationMutationResult | undefined {
  const unavailable = exactRecord(input, ["status"]);
  if (unavailable !== undefined && unavailable.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  const record = exactRecord(input, ["routing", "status"]);
  if (record === undefined || (record.status !== "saved" && record.status !== "conflict")) {
    return undefined;
  }
  const routing = decodeDesktopRoutingConfiguration(record.routing, false);
  return routing === undefined ? undefined : Object.freeze({ status: record.status, routing });
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
      modelCatalogSummariesEqual(current.catalog, candidate.catalog) &&
      routingConfigurationsEqual(current.routing, candidate.routing)
    );
  }
  return true;
}

function decodeDesktopRoutingConfiguration(
  input: unknown,
  includesSchemaVersion: boolean,
): DesktopRoutingConfiguration | undefined {
  const expectedKeys = includesSchemaVersion
    ? [
        "availability",
        "configurationRevisionId",
        "configured",
        "profileVersion",
        "schemaVersion",
        "tiers",
      ]
    : ["availability", "configurationRevisionId", "configured", "profileVersion", "tiers"];
  const record = exactRecord(input, expectedKeys);
  if (record === undefined || (includesSchemaVersion && record.schemaVersion !== 1)) {
    return undefined;
  }
  const configured = record.configured;
  const profileVersion = record.profileVersion;
  const configurationRevisionId = record.configurationRevisionId;
  const tiers = record.tiers === null ? null : decodeRoutingTierTargets(record.tiers);
  const availability =
    record.availability === null ? null : decodeRoutingAvailability(record.availability);
  const configuredShape =
    configured === true &&
    isPositiveSafeInteger(profileVersion) &&
    isUuid(configurationRevisionId) &&
    tiers !== null &&
    tiers !== undefined &&
    availability !== null &&
    availability !== undefined;
  const unconfiguredShape =
    configured === false &&
    profileVersion === 0 &&
    configurationRevisionId === null &&
    tiers === null &&
    availability === null;
  if (!configuredShape && !unconfiguredShape) {
    return undefined;
  }
  return Object.freeze({
    configured: configured as boolean,
    profileVersion: profileVersion as number,
    configurationRevisionId: configurationRevisionId as string | null,
    tiers: tiers ?? null,
    availability: availability ?? null,
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

function decodeRoutingTierTargets(input: unknown): DesktopRoutingTierTargets | undefined {
  const record = exactRecord(input, ["deep", "fast", "standard"]);
  if (record === undefined) {
    return undefined;
  }
  const fast = decodeRoutingTierTarget(record.fast);
  const standard = decodeRoutingTierTarget(record.standard);
  const deep = decodeRoutingTierTarget(record.deep);
  return fast === undefined || standard === undefined || deep === undefined
    ? undefined
    : Object.freeze({ fast, standard, deep });
}

function decodeRoutingTierTarget(input: unknown): DesktopRoutingTierTarget | undefined {
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
): Readonly<Record<DesktopRoutingTier, DesktopRoutingAvailabilityStatus>> | undefined {
  const record = exactRecord(input, ["deep", "fast", "standard"]);
  if (
    record === undefined ||
    !DESKTOP_ROUTING_TIERS.every(
      (tier) => typeof record[tier] === "string" && routingAvailabilityStatuses.has(record[tier]),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    fast: record.fast as DesktopRoutingAvailabilityStatus,
    standard: record.standard as DesktopRoutingAvailabilityStatus,
    deep: record.deep as DesktopRoutingAvailabilityStatus,
  });
}

function routingConfigurationsEqual(
  left: DesktopRoutingConfiguration,
  right: DesktopRoutingConfiguration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
