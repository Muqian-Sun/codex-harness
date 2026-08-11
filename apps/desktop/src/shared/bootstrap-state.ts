export const DESKTOP_TASK_OPERATION_KINDS = Object.freeze([
  "answer",
  "inspect_workspace",
  "modify_workspace",
  "run_workspace_command",
  "network_read",
  "credential_access",
  "external_write",
  "database_migration",
  "production_change",
  "irreversible_action",
  "permission_boundary_change",
  "public_api_change",
  "concurrent_change",
  "architecture_decision",
  "systemic_diagnosis",
  "user_interaction",
] as const);

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

export const DESKTOP_PROJECT_PLATFORMS = Object.freeze(["macos", "windows", "linux"] as const);
export type DesktopProjectPlatform = (typeof DESKTOP_PROJECT_PLATFORMS)[number];
export type DesktopProjectWorkspace = Readonly<{
  platform: DesktopProjectPlatform;
  absolutePath: string;
  identityStatus: "unverified";
}>;
export type DesktopProjectSummary = Readonly<{
  projectId: string;
  projectVersion: 1;
  displayName: string;
  workspace: DesktopProjectWorkspace;
}>;
export type DesktopProjectCatalog = Readonly<{
  projects: readonly DesktopProjectSummary[];
  hasMore: boolean;
}>;
export type DesktopProjectWorkspaceRegistration = Readonly<{
  displayName: string;
  workspace: Readonly<{
    platform: DesktopProjectPlatform;
    absolutePath: string;
  }>;
}>;
export type DesktopProjectRegistrationProjection = Readonly<{
  registrationStatus: "registered" | "existing";
  project: DesktopProjectSummary;
}>;
export type DesktopProjectSelectionResult =
  | Readonly<{ status: "cancelled" | "unavailable" }>
  | Readonly<{
      status: "selected";
      registrationStatus: "registered" | "existing";
      project: DesktopProjectSummary;
      projects: DesktopProjectCatalog;
    }>;
export type DesktopProjectRoutingBindingStatus = Readonly<{
  projectId: string;
  status: "unbound" | "default_bound" | "other_profile_bound";
  bindingVersion: number | null;
}>;
export type DesktopProjectRoutingBindings = Readonly<{
  bindings: readonly DesktopProjectRoutingBindingStatus[];
}>;
export type DesktopProjectRoutingBindingMutationResult = Readonly<{
  status: "bound" | "existing" | "conflict" | "routing_unconfigured" | "unavailable";
}>;

export const DESKTOP_TASK_STAGES = Object.freeze([
  "requirements_only",
  "candidate_plan",
  "confirmed_plan",
  "active_graph",
  "active_graph_with_candidate",
] as const);
export type DesktopTaskStage = (typeof DESKTOP_TASK_STAGES)[number];
export type DesktopProjectTaskSummary = Readonly<{
  taskId: string;
  projectId: string;
  taskVersion: number;
  title: string;
  objective: string;
  stage: DesktopTaskStage;
}>;
export type DesktopProjectTaskCatalog = Readonly<{
  projectId: string;
  tasks: readonly DesktopProjectTaskSummary[];
  hasMore: boolean;
}>;
export type DesktopProjectTaskCatalogResult =
  | Readonly<{ status: "loaded"; catalog: DesktopProjectTaskCatalog }>
  | Readonly<{ status: "unavailable" }>;
export type DesktopProjectTaskCreation = Readonly<{
  projectId: string;
  title: string;
  sourceText: string;
}>;
export type DesktopProjectTaskMutationResult =
  | Readonly<{
      status: "created" | "existing";
      taskId: string;
      catalog: DesktopProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "routing_unbound" | "unavailable" }>;
export type DesktopProjectTaskRequirement = Readonly<{
  revisionNumber: number;
  sourceText: string;
  objective: string;
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}>;
export type DesktopProjectTaskPlanStep = Readonly<{
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
}>;
export type DesktopProjectTaskPlan = Readonly<{
  revisionNumber: number;
  steps: readonly DesktopProjectTaskPlanStep[];
}>;
export type DesktopProjectTaskCandidatePlanStep = DesktopProjectTaskPlanStep;
export type DesktopProjectTaskCandidatePlan = DesktopProjectTaskPlan;
export type DesktopProjectTaskConfirmedPlan = DesktopProjectTaskPlan;
export type DesktopProjectTaskGraphNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";
export type DesktopProjectTaskGraphNode = Readonly<{
  nodeNumber: number;
  sourcePlanStepNumber: number;
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  dependsOnNodeNumbers: readonly number[];
  status: DesktopProjectTaskGraphNodeStatus;
}>;
export type DesktopProjectTaskSchedulePreview =
  | Readonly<{ state: "dependency_eligible"; nodeNumber: number }>
  | Readonly<{ state: "awaiting_claim"; nodeNumber: number }>
  | Readonly<{ state: "busy"; nodeNumber: number }>
  | Readonly<{ state: "blocked"; blockerNodeNumbers: readonly number[] }>
  | Readonly<{ state: "complete" }>;
export type DesktopProjectTaskOperationKind = (typeof DESKTOP_TASK_OPERATION_KINDS)[number];
export type DesktopProjectTaskOperation = Readonly<{
  operationNumber: number;
  kind: DesktopProjectTaskOperationKind;
}>;
export type DesktopProjectTaskOperationManifest = Readonly<{
  nodeNumber: number;
  stateVersion: number;
  status: "candidate" | "confirmed";
  operations: readonly DesktopProjectTaskOperation[];
}>;
export type DesktopProjectTaskGraph = Readonly<{
  revisionNumber: number;
  nodes: readonly DesktopProjectTaskGraphNode[];
  operationManifest: DesktopProjectTaskOperationManifest | null;
  schedulePreview: DesktopProjectTaskSchedulePreview;
}>;
export type DesktopProjectTaskDetail = Readonly<{
  projectId: string;
  taskId: string;
  taskVersion: number;
  title: string;
  stage: DesktopTaskStage;
  activeRequirement: DesktopProjectTaskRequirement;
  candidatePlan: DesktopProjectTaskCandidatePlan | null;
  confirmedPlan: DesktopProjectTaskConfirmedPlan | null;
  activeGraph: DesktopProjectTaskGraph | null;
}>;
export type DesktopProjectTaskDetailResult =
  | Readonly<{ status: "loaded"; detail: DesktopProjectTaskDetail }>
  | Readonly<{ status: "unavailable" }>;
export type DesktopProjectTaskSelection = Readonly<{
  projectId: string;
  taskId: string;
}>;
export type DesktopProjectTaskRequirementRevision = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  sourceText: string;
}>;
export type DesktopProjectTaskRequirementMutationResult =
  | Readonly<{
      status: "revised" | "existing";
      taskId: string;
      detail: DesktopProjectTaskDetail;
      catalog: DesktopProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;
export type DesktopProjectTaskCandidatePlanGeneration = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
}>;
export type DesktopProjectTaskCandidatePlanMutationResult =
  | Readonly<{
      status: "generated" | "existing";
      taskId: string;
      detail: DesktopProjectTaskDetail;
      catalog: DesktopProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;
export type DesktopProjectTaskCandidatePlanConfirmation = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  candidatePlanRevisionNumber: number;
}>;
export type DesktopProjectTaskCandidatePlanConfirmationResult =
  | Readonly<{
      status: "confirmed" | "existing";
      taskId: string;
      detail: DesktopProjectTaskDetail;
      catalog: DesktopProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;
export type DesktopProjectTaskGraphMaterialization = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  confirmedPlanRevisionNumber: number;
}>;
export type DesktopProjectTaskGraphMaterializationResult =
  | Readonly<{
      status: "materialized" | "existing";
      taskId: string;
      detail: DesktopProjectTaskDetail;
      catalog: DesktopProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;
export type DesktopProjectTaskOperationManifestGeneration = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  nodeNumber: number;
  expectedManifestStateVersion: number;
}>;
export type DesktopProjectTaskOperationManifestGenerationResult =
  | Readonly<{
      status: "generated" | "existing";
      taskId: string;
      detail: DesktopProjectTaskDetail;
      catalog: DesktopProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;
export type DesktopProjectTaskOperationManifestConfirmation = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  nodeNumber: number;
  manifestStateVersion: number;
}>;
export type DesktopProjectTaskOperationManifestConfirmationResult =
  | Readonly<{
      status: "confirmed" | "existing";
      taskId: string;
      detail: DesktopProjectTaskDetail;
      catalog: DesktopProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;

export type DesktopBootstrapState =
  | Readonly<{ phase: "starting" }>
  | Readonly<{
      phase: "ready";
      account: DesktopAccountStatus;
      catalog: DesktopModelCatalogSummary;
      routing: DesktopRoutingConfiguration;
      projects: DesktopProjectCatalog;
      projectRoutingBindings: DesktopProjectRoutingBindings;
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
const MAX_PROJECT_CATALOG_PAGE_SIZE = 12;
const MAX_PROJECT_DISPLAY_NAME_BYTES = 256;
const MAX_PROJECT_PATH_BYTES = 4_096;
const MAX_TASK_CATALOG_PAGE_SIZE = 12;
const MAX_TASK_TITLE_BYTES = 256;
const MAX_TASK_SOURCE_TEXT_BYTES = 16 * 1_024;
const MAX_TASK_REQUIREMENT_ITEM_BYTES = 4 * 1_024;
const MAX_TASK_REQUIREMENT_ITEMS = 100;
const MAX_TASK_REQUIREMENT_TOTAL_BYTES = 256 * 1_024;
const MAX_TASK_PLAN_STEPS = 200;
const MAX_TASK_PLAN_STEP_TITLE_BYTES = 512;
const MAX_TASK_PLAN_STEP_DESCRIPTION_BYTES = 8 * 1_024;
const MAX_TASK_PLAN_TOTAL_BYTES = 256 * 1_024;
const taskStages = new Set<string>(DESKTOP_TASK_STAGES);
const taskNodeStatuses = new Set<string>([
  "pending",
  "ready",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);
const taskOperationKinds = new Set<string>(DESKTOP_TASK_OPERATION_KINDS);

export function decodeDesktopBootstrapState(input: unknown): DesktopBootstrapState | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.phase === "ready") {
    if (
      keys.length !== 6 ||
      !keys.includes("phase") ||
      !keys.includes("account") ||
      !keys.includes("catalog") ||
      !keys.includes("routing") ||
      !keys.includes("projects") ||
      !keys.includes("projectRoutingBindings")
    ) {
      return undefined;
    }
    const account = decodeDesktopAccountStatus(record.account, true);
    const catalog = decodeDesktopModelCatalogSummary(record.catalog);
    const routing = decodeDesktopRoutingConfiguration(record.routing, false);
    const projects = decodeDesktopProjectCatalog(record.projects, false);
    const projectRoutingBindings = decodeDesktopProjectRoutingBindings(
      record.projectRoutingBindings,
      projects?.projects.map((project) => project.projectId),
    );
    return account === undefined ||
      catalog === undefined ||
      routing === undefined ||
      projects === undefined ||
      projectRoutingBindings === undefined
      ? undefined
      : Object.freeze({
          phase: "ready",
          account,
          catalog,
          routing,
          projects,
          projectRoutingBindings,
        });
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
  projectsInput: unknown,
  projectRoutingBindingsInput: unknown,
): DesktopBootstrapState {
  const account = decodeDesktopAccountStatus(accountInput, false);
  const catalog = decodeDesktopModelCatalogSummary(catalogInput);
  const routing = decodeDesktopRoutingConfiguration(routingInput, false);
  const projects = decodeDesktopProjectCatalog(projectsInput, false);
  const projectRoutingBindings = decodeDesktopProjectRoutingBindings(
    projectRoutingBindingsInput,
    projects?.projects.map((project) => project.projectId),
  );
  if (
    account === undefined ||
    catalog === undefined ||
    routing === undefined ||
    projects === undefined ||
    projectRoutingBindings === undefined
  ) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({
    phase: "ready",
    account,
    catalog,
    routing,
    projects,
    projectRoutingBindings,
  });
}

export function projectDesktopProjectCatalog(input: unknown): DesktopProjectCatalog {
  const projects = decodeDesktopProjectCatalog(input, true);
  if (projects === undefined) {
    throw new BootstrapStateTransitionError();
  }
  return projects;
}

export function projectDesktopProjectRegistration(
  input: unknown,
): DesktopProjectRegistrationProjection {
  const record = exactRecord(input, ["project", "schemaVersion", "status"]);
  if (
    record === undefined ||
    record.schemaVersion !== 1 ||
    (record.status !== "registered" && record.status !== "existing")
  ) {
    throw new BootstrapStateTransitionError();
  }
  const project = decodeDesktopProjectSummary(record.project);
  if (project === undefined) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({ registrationStatus: record.status, project });
}

export function projectDesktopProjectRoutingBindings(
  input: unknown,
  expectedProjectIds: readonly string[],
): DesktopProjectRoutingBindings {
  const record = exactRecord(input, ["schemaVersion", "statuses"]);
  if (
    record === undefined ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.statuses) ||
    record.statuses.length !== expectedProjectIds.length ||
    record.statuses.length > MAX_PROJECT_CATALOG_PAGE_SIZE
  ) {
    throw new BootstrapStateTransitionError();
  }
  const bindings = record.statuses.map((status, index) =>
    projectRoutingBindingStatus(status, expectedProjectIds[index]),
  );
  if (bindings.some((binding) => binding === undefined)) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({
    bindings: Object.freeze(bindings as DesktopProjectRoutingBindingStatus[]),
  });
}

export function decodeDesktopProjectRoutingBindingMutationResult(
  input: unknown,
): DesktopProjectRoutingBindingMutationResult | undefined {
  const record = exactRecord(input, ["status"]);
  return record !== undefined &&
    (record.status === "bound" ||
      record.status === "existing" ||
      record.status === "conflict" ||
      record.status === "routing_unconfigured" ||
      record.status === "unavailable")
    ? Object.freeze({ status: record.status })
    : undefined;
}

export function decodeDesktopProjectRoutingBindingProjectId(input: unknown): string | undefined {
  return isUuid(input) ? input : undefined;
}

export function projectDesktopProjectTaskCatalog(
  input: unknown,
  expectedProjectId: string,
): DesktopProjectTaskCatalog {
  const record = exactRecord(input, ["nextCursor", "schemaVersion", "tasks"]);
  if (
    !isUuid(expectedProjectId) ||
    record === undefined ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.tasks) ||
    record.tasks.length > MAX_TASK_CATALOG_PAGE_SIZE ||
    (record.nextCursor !== null && !isUuid(record.nextCursor))
  ) {
    throw new BootstrapStateTransitionError();
  }
  const tasks = record.tasks.map((task) =>
    decodeDesktopProjectTaskSummary(task, expectedProjectId),
  );
  if (
    tasks.some((task) => task === undefined) ||
    new Set(tasks.map((task) => task?.taskId)).size !== tasks.length ||
    (record.nextCursor !== null && record.nextCursor !== tasks.at(-1)?.taskId)
  ) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({
    projectId: expectedProjectId,
    tasks: Object.freeze(tasks as DesktopProjectTaskSummary[]),
    hasMore: record.nextCursor !== null,
  });
}

export function decodeDesktopProjectTaskCatalogResult(
  input: unknown,
  expectedProjectId: string,
): DesktopProjectTaskCatalogResult | undefined {
  if (!isUuid(expectedProjectId)) {
    return undefined;
  }
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  const record = exactRecord(input, ["catalog", "status"]);
  if (record?.status !== "loaded") {
    return undefined;
  }
  const projectId = exactRecord(record.catalog, ["hasMore", "projectId", "tasks"])?.projectId;
  if (projectId !== expectedProjectId) {
    return undefined;
  }
  try {
    return Object.freeze({
      status: "loaded",
      catalog: decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectTaskCreation(
  input: unknown,
): DesktopProjectTaskCreation | undefined {
  const record = exactRecord(input, ["projectId", "sourceText", "title"]);
  if (
    !isUuid(record?.projectId) ||
    !validTaskTitle(record.title) ||
    !validTaskSourceText(record.sourceText)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    title: record.title,
    sourceText: record.sourceText,
  });
}

export function decodeDesktopProjectTaskMutationResult(
  input: unknown,
  expectedProjectId: string,
): DesktopProjectTaskMutationResult | undefined {
  if (!isUuid(expectedProjectId)) {
    return undefined;
  }
  const terminal = exactRecord(input, ["status"]);
  if (
    terminal !== undefined &&
    (terminal.status === "conflict" ||
      terminal.status === "routing_unbound" ||
      terminal.status === "unavailable")
  ) {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "status", "taskId"]);
  if (
    record === undefined ||
    (record.status !== "created" && record.status !== "existing") ||
    !isUuid(record.taskId)
  ) {
    return undefined;
  }
  const catalogRecord = exactRecord(record.catalog, ["hasMore", "projectId", "tasks"]);
  if (catalogRecord?.projectId !== expectedProjectId) {
    return undefined;
  }
  try {
    const catalog = decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId);
    return Object.freeze({ status: record.status, taskId: record.taskId, catalog });
  } catch {
    return undefined;
  }
}

export function projectDesktopProjectTaskDetail(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskDetail {
  const record = exactRecord(input, [
    "activeRequirement",
    "activeGraph",
    "candidatePlan",
    "confirmedPlan",
    "latestPlanRevisionId",
    "ownershipVersion",
    "projectId",
    "schemaVersion",
    "stage",
    "taskId",
    "taskVersion",
    "title",
  ]);
  const requirement = decodeDesktopProjectTaskRequirement(record?.activeRequirement);
  const candidatePlan = decodeDesktopProjectTaskCandidatePlan(record?.candidatePlan, true);
  const confirmedPlan = decodeDesktopProjectTaskCandidatePlan(record?.confirmedPlan, true);
  const activeGraph = projectDesktopProjectTaskGraph(record?.activeGraph, record?.confirmedPlan);
  if (
    !isUuid(expectedProjectId) ||
    !isUuid(expectedTaskId) ||
    record?.schemaVersion !== 1 ||
    record.projectId !== expectedProjectId ||
    record.taskId !== expectedTaskId ||
    !isPositiveSafeInteger(record.ownershipVersion) ||
    !isPositiveSafeInteger(record.taskVersion) ||
    !validTaskTitle(record.title) ||
    typeof record.stage !== "string" ||
    !taskStages.has(record.stage) ||
    requirement === undefined ||
    candidatePlan === undefined ||
    confirmedPlan === undefined ||
    activeGraph === undefined ||
    !plansMatchStage(record.candidatePlan, record.confirmedPlan, record.stage) ||
    !graphMatchesStage(record.activeGraph, record.stage) ||
    (record.latestPlanRevisionId !== null && !isUuid(record.latestPlanRevisionId)) ||
    !plansMatchLatest(record.candidatePlan, record.confirmedPlan, record.latestPlanRevisionId) ||
    !planMatchesRequirement(record.candidatePlan, record.activeRequirement) ||
    !planMatchesRequirement(record.confirmedPlan, record.activeRequirement)
  ) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({
    projectId: expectedProjectId,
    taskId: expectedTaskId,
    taskVersion: record.taskVersion,
    title: record.title,
    stage: record.stage as DesktopTaskStage,
    activeRequirement: requirement,
    candidatePlan,
    confirmedPlan,
    activeGraph,
  });
}

export function decodeDesktopProjectTaskDetailResult(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskDetailResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  const record = exactRecord(input, ["detail", "status"]);
  if (record?.status !== "loaded") {
    return undefined;
  }
  try {
    return Object.freeze({
      status: "loaded",
      detail: decodeProjectedDesktopTaskDetail(record.detail, expectedProjectId, expectedTaskId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectTaskRequirementRevision(
  input: unknown,
): DesktopProjectTaskRequirementRevision | undefined {
  const record = exactRecord(input, ["expectedTaskVersion", "projectId", "sourceText", "taskId"]);
  if (
    !isUuid(record?.projectId) ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.expectedTaskVersion) ||
    !validTaskSourceText(record.sourceText)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    taskId: record.taskId,
    expectedTaskVersion: record.expectedTaskVersion,
    sourceText: record.sourceText,
  });
}

export function decodeDesktopProjectTaskSelection(
  input: unknown,
): DesktopProjectTaskSelection | undefined {
  const record = exactRecord(input, ["projectId", "taskId"]);
  if (!isUuid(record?.projectId) || !isUuid(record.taskId)) {
    return undefined;
  }
  return Object.freeze({ projectId: record.projectId, taskId: record.taskId });
}

export function decodeDesktopProjectTaskCandidatePlanGeneration(
  input: unknown,
): DesktopProjectTaskCandidatePlanGeneration | undefined {
  const record = exactRecord(input, ["expectedTaskVersion", "projectId", "taskId"]);
  if (
    !isUuid(record?.projectId) ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.expectedTaskVersion)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    taskId: record.taskId,
    expectedTaskVersion: record.expectedTaskVersion,
  });
}

export function decodeDesktopProjectTaskCandidatePlanConfirmation(
  input: unknown,
): DesktopProjectTaskCandidatePlanConfirmation | undefined {
  const record = exactRecord(input, [
    "candidatePlanRevisionNumber",
    "expectedTaskVersion",
    "projectId",
    "taskId",
  ]);
  if (
    !isUuid(record?.projectId) ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.expectedTaskVersion) ||
    !isPositiveSafeInteger(record.candidatePlanRevisionNumber)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    taskId: record.taskId,
    expectedTaskVersion: record.expectedTaskVersion,
    candidatePlanRevisionNumber: record.candidatePlanRevisionNumber,
  });
}

export function decodeDesktopProjectTaskGraphMaterialization(
  input: unknown,
): DesktopProjectTaskGraphMaterialization | undefined {
  const record = exactRecord(input, [
    "confirmedPlanRevisionNumber",
    "expectedTaskVersion",
    "projectId",
    "taskId",
  ]);
  if (
    !isUuid(record?.projectId) ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.expectedTaskVersion) ||
    !isPositiveSafeInteger(record.confirmedPlanRevisionNumber)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    taskId: record.taskId,
    expectedTaskVersion: record.expectedTaskVersion,
    confirmedPlanRevisionNumber: record.confirmedPlanRevisionNumber,
  });
}

export function decodeDesktopProjectTaskOperationManifestGeneration(
  input: unknown,
): DesktopProjectTaskOperationManifestGeneration | undefined {
  const record = exactRecord(input, [
    "expectedManifestStateVersion",
    "expectedTaskVersion",
    "nodeNumber",
    "projectId",
    "taskId",
  ]);
  if (
    !isUuid(record?.projectId) ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.expectedTaskVersion) ||
    !isPositiveSafeInteger(record.nodeNumber) ||
    !isNonNegativeSafeInteger(record.expectedManifestStateVersion)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    taskId: record.taskId,
    expectedTaskVersion: record.expectedTaskVersion,
    nodeNumber: record.nodeNumber,
    expectedManifestStateVersion: record.expectedManifestStateVersion,
  });
}

export function decodeDesktopProjectTaskOperationManifestConfirmation(
  input: unknown,
): DesktopProjectTaskOperationManifestConfirmation | undefined {
  const record = exactRecord(input, [
    "expectedTaskVersion",
    "manifestStateVersion",
    "nodeNumber",
    "projectId",
    "taskId",
  ]);
  if (
    !isUuid(record?.projectId) ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.expectedTaskVersion) ||
    !isPositiveSafeInteger(record.nodeNumber) ||
    !isPositiveSafeInteger(record.manifestStateVersion)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    taskId: record.taskId,
    expectedTaskVersion: record.expectedTaskVersion,
    nodeNumber: record.nodeNumber,
    manifestStateVersion: record.manifestStateVersion,
  });
}

export function decodeDesktopProjectTaskCandidatePlanMutationResult(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskCandidatePlanMutationResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  if (
    record === undefined ||
    (record.status !== "generated" && record.status !== "existing") ||
    record.taskId !== expectedTaskId
  ) {
    return undefined;
  }
  try {
    return Object.freeze({
      status: record.status,
      taskId: expectedTaskId,
      detail: decodeProjectedDesktopTaskDetail(record.detail, expectedProjectId, expectedTaskId),
      catalog: decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectTaskCandidatePlanConfirmationResult(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskCandidatePlanConfirmationResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  if (
    record === undefined ||
    (record.status !== "confirmed" && record.status !== "existing") ||
    record.taskId !== expectedTaskId
  ) {
    return undefined;
  }
  try {
    const detail = decodeProjectedDesktopTaskDetail(
      record.detail,
      expectedProjectId,
      expectedTaskId,
    );
    if (
      detail.stage !== "confirmed_plan" ||
      detail.candidatePlan !== null ||
      detail.confirmedPlan === null
    ) {
      return undefined;
    }
    return Object.freeze({
      status: record.status,
      taskId: expectedTaskId,
      detail,
      catalog: decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectTaskGraphMaterializationResult(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskGraphMaterializationResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  if (
    record === undefined ||
    (record.status !== "materialized" && record.status !== "existing") ||
    record.taskId !== expectedTaskId
  ) {
    return undefined;
  }
  try {
    const detail = decodeProjectedDesktopTaskDetail(
      record.detail,
      expectedProjectId,
      expectedTaskId,
    );
    if (
      detail.stage !== "active_graph" ||
      detail.candidatePlan !== null ||
      detail.confirmedPlan === null ||
      detail.activeGraph === null
    ) {
      return undefined;
    }
    return Object.freeze({
      status: record.status,
      taskId: expectedTaskId,
      detail,
      catalog: decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectTaskOperationManifestGenerationResult(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskOperationManifestGenerationResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  if (
    record === undefined ||
    (record.status !== "generated" && record.status !== "existing") ||
    record.taskId !== expectedTaskId
  ) {
    return undefined;
  }
  try {
    const detail = decodeProjectedDesktopTaskDetail(
      record.detail,
      expectedProjectId,
      expectedTaskId,
    );
    if (detail.activeGraph?.operationManifest === null || detail.activeGraph === null) {
      return undefined;
    }
    return Object.freeze({
      status: record.status,
      taskId: expectedTaskId,
      detail,
      catalog: decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectTaskOperationManifestConfirmationResult(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskOperationManifestConfirmationResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  if (
    record === undefined ||
    (record.status !== "confirmed" && record.status !== "existing") ||
    record.taskId !== expectedTaskId
  ) {
    return undefined;
  }
  try {
    const detail = decodeProjectedDesktopTaskDetail(
      record.detail,
      expectedProjectId,
      expectedTaskId,
    );
    if (detail.activeGraph?.operationManifest?.status !== "confirmed") {
      return undefined;
    }
    return Object.freeze({
      status: record.status,
      taskId: expectedTaskId,
      detail,
      catalog: decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectTaskRequirementMutationResult(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskRequirementMutationResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  if (
    record === undefined ||
    (record.status !== "revised" && record.status !== "existing") ||
    record.taskId !== expectedTaskId
  ) {
    return undefined;
  }
  try {
    return Object.freeze({
      status: record.status,
      taskId: expectedTaskId,
      detail: decodeProjectedDesktopTaskDetail(record.detail, expectedProjectId, expectedTaskId),
      catalog: decodeProjectedDesktopTaskCatalog(record.catalog, expectedProjectId),
    });
  } catch {
    return undefined;
  }
}

export function decodeDesktopProjectWorkspaceRegistration(
  input: unknown,
): DesktopProjectWorkspaceRegistration | undefined {
  const record = exactRecord(input, ["displayName", "workspace"]);
  if (!validProjectDisplayName(record?.displayName)) {
    return undefined;
  }
  const workspaceRecord = exactRecord(record.workspace, ["absolutePath", "platform"]);
  if (
    workspaceRecord === undefined ||
    !isDesktopProjectPlatform(workspaceRecord.platform) ||
    typeof workspaceRecord.absolutePath !== "string" ||
    utf8ByteLength(workspaceRecord.absolutePath) > MAX_PROJECT_PATH_BYTES ||
    !isNormalizedProjectPath(workspaceRecord.platform, workspaceRecord.absolutePath)
  ) {
    return undefined;
  }
  return Object.freeze({
    displayName: record.displayName,
    workspace: Object.freeze({
      platform: workspaceRecord.platform,
      absolutePath: workspaceRecord.absolutePath,
    }),
  });
}

export function decodeDesktopProjectSelectionResult(
  input: unknown,
): DesktopProjectSelectionResult | undefined {
  const terminal = exactRecord(input, ["status"]);
  if (
    terminal !== undefined &&
    (terminal.status === "cancelled" || terminal.status === "unavailable")
  ) {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["project", "projects", "registrationStatus", "status"]);
  if (
    record === undefined ||
    record.status !== "selected" ||
    (record.registrationStatus !== "registered" && record.registrationStatus !== "existing")
  ) {
    return undefined;
  }
  const project = decodeDesktopProjectSummary(record.project);
  const projects = decodeDesktopProjectCatalog(record.projects, false);
  return project === undefined || projects === undefined
    ? undefined
    : Object.freeze({
        status: "selected",
        registrationStatus: record.registrationStatus,
        project,
        projects,
      });
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
      routingConfigurationsEqual(current.routing, candidate.routing) &&
      projectCatalogsEqual(current.projects, candidate.projects) &&
      projectRoutingBindingsEqual(current.projectRoutingBindings, candidate.projectRoutingBindings)
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

function decodeDesktopProjectCatalog(
  input: unknown,
  includesSchemaVersion: boolean,
): DesktopProjectCatalog | undefined {
  const expectedKeys = includesSchemaVersion
    ? ["nextCursor", "projects", "schemaVersion"]
    : ["hasMore", "projects"];
  const record = exactRecord(input, expectedKeys);
  if (
    record === undefined ||
    (includesSchemaVersion && record.schemaVersion !== 1) ||
    !Array.isArray(record.projects) ||
    record.projects.length > MAX_PROJECT_CATALOG_PAGE_SIZE
  ) {
    return undefined;
  }
  const hasMore = includesSchemaVersion ? record.nextCursor !== null : record.hasMore;
  if (
    typeof hasMore !== "boolean" ||
    (includesSchemaVersion && record.nextCursor !== null && !isUuid(record.nextCursor))
  ) {
    return undefined;
  }
  const projects = record.projects.map(decodeDesktopProjectSummary);
  if (projects.some((project) => project === undefined)) {
    return undefined;
  }
  const decoded = projects as DesktopProjectSummary[];
  const ids = decoded.map((project) => project.projectId);
  const workspaces = decoded.map(
    (project) => `${project.workspace.platform}\0${project.workspace.absolutePath}`,
  );
  if (
    new Set(ids).size !== ids.length ||
    new Set(workspaces).size !== workspaces.length ||
    (hasMore && decoded.length === 0)
  ) {
    return undefined;
  }
  return Object.freeze({ projects: Object.freeze(decoded), hasMore });
}

function decodeDesktopProjectSummary(input: unknown): DesktopProjectSummary | undefined {
  const record = exactRecord(input, ["displayName", "projectId", "projectVersion", "workspace"]);
  if (
    record === undefined ||
    !isUuid(record.projectId) ||
    record.projectVersion !== 1 ||
    !validProjectDisplayName(record.displayName)
  ) {
    return undefined;
  }
  const workspace = exactRecord(record.workspace, ["absolutePath", "identityStatus", "platform"]);
  if (
    workspace === undefined ||
    workspace.identityStatus !== "unverified" ||
    !isDesktopProjectPlatform(workspace.platform) ||
    typeof workspace.absolutePath !== "string" ||
    utf8ByteLength(workspace.absolutePath) > MAX_PROJECT_PATH_BYTES ||
    !isNormalizedProjectPath(workspace.platform, workspace.absolutePath)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    projectVersion: 1,
    displayName: record.displayName,
    workspace: Object.freeze({
      platform: workspace.platform,
      absolutePath: workspace.absolutePath,
      identityStatus: "unverified",
    }),
  });
}

function decodeDesktopProjectRoutingBindings(
  input: unknown,
  expectedProjectIds: readonly string[] | undefined,
): DesktopProjectRoutingBindings | undefined {
  const record = exactRecord(input, ["bindings"]);
  if (
    record === undefined ||
    expectedProjectIds === undefined ||
    !Array.isArray(record.bindings) ||
    record.bindings.length !== expectedProjectIds.length ||
    record.bindings.length > MAX_PROJECT_CATALOG_PAGE_SIZE
  ) {
    return undefined;
  }
  const bindings = record.bindings.map((binding, index) => {
    const decoded = exactRecord(binding, ["bindingVersion", "projectId", "status"]);
    const expectedProjectId = expectedProjectIds[index];
    if (
      decoded === undefined ||
      decoded.projectId !== expectedProjectId ||
      (decoded.status !== "unbound" &&
        decoded.status !== "default_bound" &&
        decoded.status !== "other_profile_bound") ||
      (decoded.status === "unbound"
        ? decoded.bindingVersion !== null
        : !isPositiveSafeInteger(decoded.bindingVersion))
    ) {
      return undefined;
    }
    return Object.freeze({
      projectId: decoded.projectId as string,
      status: decoded.status,
      bindingVersion: decoded.bindingVersion as number | null,
    });
  });
  return bindings.some((binding) => binding === undefined)
    ? undefined
    : Object.freeze({
        bindings: Object.freeze(bindings as DesktopProjectRoutingBindingStatus[]),
      });
}

function projectRoutingBindingStatus(
  input: unknown,
  expectedProjectId: string | undefined,
): DesktopProjectRoutingBindingStatus | undefined {
  const record = exactRecord(input, ["binding", "projectId", "status"]);
  if (
    record === undefined ||
    expectedProjectId === undefined ||
    record.projectId !== expectedProjectId ||
    (record.status !== "unbound" &&
      record.status !== "default_bound" &&
      record.status !== "other_profile_bound")
  ) {
    return undefined;
  }
  if (record.status === "unbound") {
    return record.binding === null
      ? Object.freeze({
          projectId: expectedProjectId,
          status: "unbound" as const,
          bindingVersion: null,
        })
      : undefined;
  }
  const binding = exactRecord(record.binding, [
    "bindingVersion",
    "configurationRevisionIdAtBinding",
    "profileId",
    "profileVersionAtBinding",
    "projectId",
  ]);
  if (
    binding === undefined ||
    binding.projectId !== expectedProjectId ||
    !isPositiveSafeInteger(binding.bindingVersion) ||
    !isUuid(binding.profileId) ||
    !isPositiveSafeInteger(binding.profileVersionAtBinding) ||
    !isUuid(binding.configurationRevisionIdAtBinding)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: expectedProjectId,
    status: record.status,
    bindingVersion: binding.bindingVersion,
  });
}

function decodeDesktopProjectTaskSummary(
  input: unknown,
  expectedProjectId: string,
): DesktopProjectTaskSummary | undefined {
  const record = exactRecord(input, [
    "objective",
    "projectId",
    "stage",
    "taskId",
    "taskVersion",
    "title",
  ]);
  if (
    record === undefined ||
    record.projectId !== expectedProjectId ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.taskVersion) ||
    !validTaskTitle(record.title) ||
    !validTaskSourceText(record.objective) ||
    typeof record.stage !== "string" ||
    !taskStages.has(record.stage)
  ) {
    return undefined;
  }
  return Object.freeze({
    taskId: record.taskId,
    projectId: expectedProjectId,
    taskVersion: record.taskVersion,
    title: record.title,
    objective: record.objective,
    stage: record.stage as DesktopTaskStage,
  });
}

function decodeDesktopProjectTaskRequirement(
  input: unknown,
): DesktopProjectTaskRequirement | undefined {
  const record = exactRecord(input, [
    "acceptanceCriteria",
    "constraints",
    "objective",
    "revisionId",
    "revisionNumber",
    "sourceText",
  ]);
  if (
    record === undefined ||
    !isUuid(record.revisionId) ||
    !isPositiveSafeInteger(record.revisionNumber) ||
    !validTaskSourceText(record.sourceText) ||
    !validTaskSourceText(record.objective) ||
    !validTaskRequirementItems(record.constraints) ||
    !validTaskRequirementItems(record.acceptanceCriteria)
  ) {
    return undefined;
  }
  const totalBytes = utf8ByteLength(
    [record.sourceText, record.objective, ...record.constraints, ...record.acceptanceCriteria].join(
      "",
    ),
  );
  if (totalBytes > MAX_TASK_REQUIREMENT_TOTAL_BYTES) {
    return undefined;
  }
  return Object.freeze({
    revisionNumber: record.revisionNumber,
    sourceText: record.sourceText,
    objective: record.objective,
    constraints: Object.freeze([...record.constraints]),
    acceptanceCriteria: Object.freeze([...record.acceptanceCriteria]),
  });
}

function decodeProjectedDesktopTaskDetail(
  input: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): DesktopProjectTaskDetail {
  const record = exactRecord(input, [
    "activeRequirement",
    "activeGraph",
    "candidatePlan",
    "confirmedPlan",
    "projectId",
    "stage",
    "taskId",
    "taskVersion",
    "title",
  ]);
  const requirement = decodeProjectedDesktopTaskRequirement(record?.activeRequirement);
  const candidatePlan = decodeDesktopProjectTaskCandidatePlan(record?.candidatePlan, false);
  const confirmedPlan = decodeDesktopProjectTaskCandidatePlan(record?.confirmedPlan, false);
  const activeGraph = decodeProjectedDesktopTaskGraph(record?.activeGraph, confirmedPlan);
  if (
    record?.projectId !== expectedProjectId ||
    record.taskId !== expectedTaskId ||
    !isPositiveSafeInteger(record.taskVersion) ||
    !validTaskTitle(record.title) ||
    typeof record.stage !== "string" ||
    !taskStages.has(record.stage) ||
    requirement === undefined ||
    candidatePlan === undefined ||
    confirmedPlan === undefined ||
    activeGraph === undefined ||
    !plansMatchStage(record.candidatePlan, record.confirmedPlan, record.stage) ||
    !graphMatchesStage(record.activeGraph, record.stage)
  ) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({
    projectId: expectedProjectId,
    taskId: expectedTaskId,
    taskVersion: record.taskVersion,
    title: record.title,
    stage: record.stage as DesktopTaskStage,
    activeRequirement: requirement,
    candidatePlan,
    confirmedPlan,
    activeGraph,
  });
}

function decodeDesktopProjectTaskCandidatePlan(
  input: unknown,
  includesIdentifiers: boolean,
): DesktopProjectTaskCandidatePlan | null | undefined {
  if (input === null) {
    return null;
  }
  const record = exactRecord(
    input,
    includesIdentifiers
      ? ["basedOnRequirementRevisionId", "revisionId", "revisionNumber", "steps"]
      : ["revisionNumber", "steps"],
  );
  if (
    record === undefined ||
    !isPositiveSafeInteger(record.revisionNumber) ||
    !Array.isArray(record.steps) ||
    record.steps.length < 1 ||
    record.steps.length > MAX_TASK_PLAN_STEPS ||
    (includesIdentifiers &&
      (!isUuid(record.revisionId) || !isUuid(record.basedOnRequirementRevisionId)))
  ) {
    return undefined;
  }
  let totalBytes = 0;
  const steps = record.steps.map((inputStep) => {
    const step = exactRecord(
      inputStep,
      includesIdentifiers
        ? ["acceptanceCriteria", "description", "stepId", "title"]
        : ["acceptanceCriteria", "description", "title"],
    );
    if (
      step === undefined ||
      (includesIdentifiers && !isUuid(step.stepId)) ||
      !validTaskPlanStepText(step.title, MAX_TASK_PLAN_STEP_TITLE_BYTES) ||
      !validTaskPlanStepText(step.description, MAX_TASK_PLAN_STEP_DESCRIPTION_BYTES) ||
      !validTaskRequirementItems(step.acceptanceCriteria)
    ) {
      return undefined;
    }
    totalBytes += utf8ByteLength(
      [step.title, step.description, ...step.acceptanceCriteria].join(""),
    );
    return Object.freeze({
      title: step.title,
      description: step.description,
      acceptanceCriteria: Object.freeze([...step.acceptanceCriteria]),
    });
  });
  if (steps.some((step) => step === undefined) || totalBytes > MAX_TASK_PLAN_TOTAL_BYTES) {
    return undefined;
  }
  if (
    includesIdentifiers &&
    new Set(
      record.steps.map(
        (step) =>
          exactRecord(step, ["acceptanceCriteria", "description", "stepId", "title"])?.stepId,
      ),
    ).size !== record.steps.length
  ) {
    return undefined;
  }
  return Object.freeze({
    revisionNumber: record.revisionNumber,
    steps: Object.freeze(steps as DesktopProjectTaskPlanStep[]),
  });
}

function projectDesktopProjectTaskGraph(
  input: unknown,
  confirmedPlanInput: unknown,
): DesktopProjectTaskGraph | null | undefined {
  if (input === null) {
    return null;
  }
  const graph = exactRecord(input, [
    "basedOnPlanRevisionId",
    "nodes",
    "operationManifest",
    "revisionId",
    "revisionNumber",
    "schedulePreview",
    "topologicalOrder",
  ]);
  const confirmedPlan = exactRecord(confirmedPlanInput, [
    "basedOnRequirementRevisionId",
    "revisionId",
    "revisionNumber",
    "steps",
  ]);
  if (
    graph === undefined ||
    confirmedPlan === undefined ||
    !isUuid(graph.revisionId) ||
    !isPositiveSafeInteger(graph.revisionNumber) ||
    graph.basedOnPlanRevisionId !== confirmedPlan.revisionId ||
    !Array.isArray(graph.nodes) ||
    graph.nodes.length < 1 ||
    graph.nodes.length > MAX_TASK_PLAN_STEPS ||
    !Array.isArray(graph.topologicalOrder) ||
    graph.topologicalOrder.length !== graph.nodes.length ||
    !Array.isArray(confirmedPlan.steps)
  ) {
    return undefined;
  }
  const stepIds = confirmedPlan.steps.map(
    (inputStep) =>
      exactRecord(inputStep, ["acceptanceCriteria", "description", "stepId", "title"])?.stepId,
  );
  if (stepIds.some((stepId) => !isUuid(stepId)) || new Set(stepIds).size !== stepIds.length) {
    return undefined;
  }
  const nodeRecords = graph.nodes.map((inputNode) =>
    exactRecord(inputNode, [
      "acceptanceCriteria",
      "dependsOnNodeIds",
      "description",
      "nodeId",
      "sourcePlanStepId",
      "status",
      "title",
    ]),
  );
  if (nodeRecords.some((node) => node === undefined)) {
    return undefined;
  }
  const nodes = nodeRecords as Readonly<Record<string, unknown>>[];
  const nodeIds = nodes.map((node) => node.nodeId);
  const orderIds = graph.topologicalOrder;
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const orderIndex = new Map(orderIds.map((nodeId, index) => [nodeId, index]));
  if (
    nodeIds.some((nodeId) => !isUuid(nodeId)) ||
    new Set(nodeIds).size !== nodes.length ||
    orderIds.some((nodeId) => !isUuid(nodeId) || !nodeById.has(nodeId)) ||
    orderIndex.size !== nodes.length
  ) {
    return undefined;
  }
  let totalBytes = 0;
  const projected = orderIds.map((nodeId, index) => {
    const node = nodeById.get(nodeId);
    if (
      node === undefined ||
      !isUuid(node.sourcePlanStepId) ||
      !validTaskPlanStepText(node.title, MAX_TASK_PLAN_STEP_TITLE_BYTES) ||
      !validTaskPlanStepText(node.description, MAX_TASK_PLAN_STEP_DESCRIPTION_BYTES) ||
      !validTaskRequirementItems(node.acceptanceCriteria) ||
      !Array.isArray(node.dependsOnNodeIds) ||
      node.dependsOnNodeIds.length > MAX_TASK_PLAN_STEPS ||
      typeof node.status !== "string" ||
      !taskNodeStatuses.has(node.status)
    ) {
      return undefined;
    }
    const sourcePlanStepIndex = stepIds.indexOf(node.sourcePlanStepId);
    const dependencyIndexes = node.dependsOnNodeIds.map((dependencyId) =>
      orderIndex.get(dependencyId),
    );
    if (
      sourcePlanStepIndex < 0 ||
      dependencyIndexes.some(
        (dependencyIndex) => dependencyIndex === undefined || dependencyIndex >= index,
      ) ||
      new Set(node.dependsOnNodeIds).size !== node.dependsOnNodeIds.length
    ) {
      return undefined;
    }
    totalBytes += utf8ByteLength(
      [node.title, node.description, ...node.acceptanceCriteria].join(""),
    );
    return Object.freeze({
      nodeNumber: index + 1,
      sourcePlanStepNumber: sourcePlanStepIndex + 1,
      title: node.title,
      description: node.description,
      acceptanceCriteria: Object.freeze([...node.acceptanceCriteria]),
      dependsOnNodeNumbers: Object.freeze(
        dependencyIndexes.map((dependencyIndex) => dependencyIndex! + 1),
      ),
      status: node.status as DesktopProjectTaskGraphNodeStatus,
    });
  });
  if (
    projected.some((node) => node === undefined) ||
    totalBytes > MAX_TASK_PLAN_TOTAL_BYTES ||
    new Set(nodes.map((node) => node.sourcePlanStepId)).size !== stepIds.length ||
    stepIds.some((stepId) => !nodes.some((node) => node.sourcePlanStepId === stepId))
  ) {
    return undefined;
  }
  const schedulePreview = projectDesktopProjectTaskSchedule(graph.schedulePreview, orderIndex);
  const operationManifest = projectDesktopProjectTaskOperationManifest(
    graph.operationManifest,
    orderIndex,
    schedulePreview,
  );
  if (
    schedulePreview === undefined ||
    operationManifest === undefined ||
    !schedulePreviewMatchesDesktopGraph(schedulePreview, projected as DesktopProjectTaskGraphNode[])
  ) {
    return undefined;
  }
  return Object.freeze({
    revisionNumber: graph.revisionNumber,
    nodes: Object.freeze(projected as DesktopProjectTaskGraphNode[]),
    operationManifest,
    schedulePreview,
  });
}

function decodeProjectedDesktopTaskGraph(
  input: unknown,
  confirmedPlan: DesktopProjectTaskConfirmedPlan | null | undefined,
): DesktopProjectTaskGraph | null | undefined {
  if (input === null) {
    return null;
  }
  const graph = exactRecord(input, [
    "nodes",
    "operationManifest",
    "revisionNumber",
    "schedulePreview",
  ]);
  if (
    graph === undefined ||
    confirmedPlan === null ||
    confirmedPlan === undefined ||
    !isPositiveSafeInteger(graph.revisionNumber) ||
    !Array.isArray(graph.nodes) ||
    graph.nodes.length < 1 ||
    graph.nodes.length > MAX_TASK_PLAN_STEPS
  ) {
    return undefined;
  }
  let totalBytes = 0;
  const nodes = graph.nodes.map((inputNode, index) => {
    const node = exactRecord(inputNode, [
      "acceptanceCriteria",
      "dependsOnNodeNumbers",
      "description",
      "nodeNumber",
      "sourcePlanStepNumber",
      "status",
      "title",
    ]);
    if (
      node === undefined ||
      node.nodeNumber !== index + 1 ||
      !isPositiveSafeInteger(node.sourcePlanStepNumber) ||
      node.sourcePlanStepNumber > confirmedPlan.steps.length ||
      !validTaskPlanStepText(node.title, MAX_TASK_PLAN_STEP_TITLE_BYTES) ||
      !validTaskPlanStepText(node.description, MAX_TASK_PLAN_STEP_DESCRIPTION_BYTES) ||
      !validTaskRequirementItems(node.acceptanceCriteria) ||
      !Array.isArray(node.dependsOnNodeNumbers) ||
      node.dependsOnNodeNumbers.length > MAX_TASK_PLAN_STEPS ||
      node.dependsOnNodeNumbers.some(
        (dependency) => !isPositiveSafeInteger(dependency) || dependency >= index + 1,
      ) ||
      new Set(node.dependsOnNodeNumbers).size !== node.dependsOnNodeNumbers.length ||
      typeof node.status !== "string" ||
      !taskNodeStatuses.has(node.status)
    ) {
      return undefined;
    }
    totalBytes += utf8ByteLength(
      [node.title, node.description, ...node.acceptanceCriteria].join(""),
    );
    return Object.freeze({
      nodeNumber: node.nodeNumber,
      sourcePlanStepNumber: node.sourcePlanStepNumber,
      title: node.title,
      description: node.description,
      acceptanceCriteria: Object.freeze([...node.acceptanceCriteria]),
      dependsOnNodeNumbers: Object.freeze([...node.dependsOnNodeNumbers]),
      status: node.status as DesktopProjectTaskGraphNodeStatus,
    });
  });
  const coveredSteps = new Set(
    nodes.map((node) => node?.sourcePlanStepNumber).filter((value) => value !== undefined),
  );
  if (
    nodes.some((node) => node === undefined) ||
    totalBytes > MAX_TASK_PLAN_TOTAL_BYTES ||
    coveredSteps.size !== confirmedPlan.steps.length
  ) {
    return undefined;
  }
  const schedulePreview = decodeProjectedDesktopTaskSchedule(graph.schedulePreview);
  const operationManifest = decodeProjectedDesktopTaskOperationManifest(
    graph.operationManifest,
    schedulePreview,
  );
  if (
    schedulePreview === undefined ||
    operationManifest === undefined ||
    !schedulePreviewMatchesDesktopGraph(schedulePreview, nodes as DesktopProjectTaskGraphNode[])
  ) {
    return undefined;
  }
  return Object.freeze({
    revisionNumber: graph.revisionNumber,
    nodes: Object.freeze(nodes as DesktopProjectTaskGraphNode[]),
    operationManifest,
    schedulePreview,
  });
}

function projectDesktopProjectTaskOperationManifest(
  input: unknown,
  orderIndex: ReadonlyMap<unknown, number>,
  schedulePreview: DesktopProjectTaskSchedulePreview | undefined,
): DesktopProjectTaskOperationManifest | null | undefined {
  if (input === null) {
    return null;
  }
  const manifest = exactRecord(input, [
    "manifestId",
    "nodeId",
    "operations",
    "stateVersion",
    "status",
  ]);
  if (
    manifest === undefined ||
    !isUuid(manifest.manifestId) ||
    !isUuid(manifest.nodeId) ||
    !isPositiveSafeInteger(manifest.stateVersion) ||
    (manifest.status !== "candidate" && manifest.status !== "confirmed") ||
    !Array.isArray(manifest.operations) ||
    manifest.operations.length < 1 ||
    manifest.operations.length > DESKTOP_TASK_OPERATION_KINDS.length
  ) {
    return undefined;
  }
  const nodeIndex = orderIndex.get(manifest.nodeId);
  const operations = manifest.operations.map((inputOperation, index) => {
    const operation = exactRecord(inputOperation, ["kind", "operationId"]);
    return operation === undefined ||
      !isUuid(operation.operationId) ||
      typeof operation.kind !== "string" ||
      !taskOperationKinds.has(operation.kind)
      ? undefined
      : Object.freeze({
          operationNumber: index + 1,
          kind: operation.kind as DesktopProjectTaskOperationKind,
        });
  });
  if (
    nodeIndex === undefined ||
    !scheduleHasNodeNumber(schedulePreview, nodeIndex + 1) ||
    operations.some((operation) => operation === undefined) ||
    new Set(
      manifest.operations.map(
        (operation) => exactRecord(operation, ["kind", "operationId"])?.operationId,
      ),
    ).size !== manifest.operations.length ||
    new Set(operations.map((operation) => operation?.kind)).size !== operations.length
  ) {
    return undefined;
  }
  return Object.freeze({
    nodeNumber: nodeIndex + 1,
    stateVersion: manifest.stateVersion,
    status: manifest.status,
    operations: Object.freeze(operations as DesktopProjectTaskOperation[]),
  });
}

function decodeProjectedDesktopTaskOperationManifest(
  input: unknown,
  schedulePreview: DesktopProjectTaskSchedulePreview | undefined,
): DesktopProjectTaskOperationManifest | null | undefined {
  if (input === null) {
    return null;
  }
  const manifest = exactRecord(input, ["nodeNumber", "operations", "stateVersion", "status"]);
  if (
    manifest === undefined ||
    !isPositiveSafeInteger(manifest.nodeNumber) ||
    !isPositiveSafeInteger(manifest.stateVersion) ||
    (manifest.status !== "candidate" && manifest.status !== "confirmed") ||
    !Array.isArray(manifest.operations) ||
    manifest.operations.length < 1 ||
    manifest.operations.length > DESKTOP_TASK_OPERATION_KINDS.length ||
    !scheduleHasNodeNumber(schedulePreview, manifest.nodeNumber)
  ) {
    return undefined;
  }
  const operations = manifest.operations.map((inputOperation, index) => {
    const operation = exactRecord(inputOperation, ["kind", "operationNumber"]);
    return operation === undefined ||
      operation.operationNumber !== index + 1 ||
      typeof operation.kind !== "string" ||
      !taskOperationKinds.has(operation.kind)
      ? undefined
      : Object.freeze({
          operationNumber: index + 1,
          kind: operation.kind as DesktopProjectTaskOperationKind,
        });
  });
  if (
    operations.some((operation) => operation === undefined) ||
    new Set(operations.map((operation) => operation?.kind)).size !== operations.length
  ) {
    return undefined;
  }
  return Object.freeze({
    nodeNumber: manifest.nodeNumber,
    stateVersion: manifest.stateVersion,
    status: manifest.status,
    operations: Object.freeze(operations as DesktopProjectTaskOperation[]),
  });
}

function scheduleHasNodeNumber(
  preview: DesktopProjectTaskSchedulePreview | undefined,
  nodeNumber: number,
): boolean {
  return (
    preview !== undefined &&
    (preview.state === "dependency_eligible" ||
      preview.state === "awaiting_claim" ||
      preview.state === "busy") &&
    preview.nodeNumber === nodeNumber
  );
}

function projectDesktopProjectTaskSchedule(
  input: unknown,
  orderIndex: ReadonlyMap<unknown, number>,
): DesktopProjectTaskSchedulePreview | undefined {
  const terminal = exactRecord(input, ["state"]);
  if (terminal?.state === "complete") {
    return Object.freeze({ state: "complete" });
  }
  const node = exactRecord(input, ["nodeId", "state"]);
  if (
    node !== undefined &&
    ["dependency_eligible", "awaiting_claim", "busy"].includes(String(node.state))
  ) {
    const index = orderIndex.get(node.nodeId);
    return index === undefined
      ? undefined
      : Object.freeze({
          state: node.state as "dependency_eligible" | "awaiting_claim" | "busy",
          nodeNumber: index + 1,
        });
  }
  const blocked = exactRecord(input, ["blockerNodeIds", "state"]);
  if (
    blocked?.state !== "blocked" ||
    !Array.isArray(blocked.blockerNodeIds) ||
    blocked.blockerNodeIds.length < 1 ||
    blocked.blockerNodeIds.length > MAX_TASK_PLAN_STEPS ||
    new Set(blocked.blockerNodeIds).size !== blocked.blockerNodeIds.length
  ) {
    return undefined;
  }
  const blockerNodeNumbers = blocked.blockerNodeIds.map((nodeId) => {
    const index = orderIndex.get(nodeId);
    return index === undefined ? undefined : index + 1;
  });
  return blockerNodeNumbers.some((nodeNumber) => nodeNumber === undefined)
    ? undefined
    : Object.freeze({
        state: "blocked",
        blockerNodeNumbers: Object.freeze(blockerNodeNumbers as number[]),
      });
}

function decodeProjectedDesktopTaskSchedule(
  input: unknown,
): DesktopProjectTaskSchedulePreview | undefined {
  const terminal = exactRecord(input, ["state"]);
  if (terminal?.state === "complete") {
    return Object.freeze({ state: "complete" });
  }
  const node = exactRecord(input, ["nodeNumber", "state"]);
  if (
    node !== undefined &&
    ["dependency_eligible", "awaiting_claim", "busy"].includes(String(node.state)) &&
    isPositiveSafeInteger(node.nodeNumber)
  ) {
    return Object.freeze({
      state: node.state as "dependency_eligible" | "awaiting_claim" | "busy",
      nodeNumber: node.nodeNumber,
    });
  }
  const blocked = exactRecord(input, ["blockerNodeNumbers", "state"]);
  if (
    blocked?.state !== "blocked" ||
    !Array.isArray(blocked.blockerNodeNumbers) ||
    blocked.blockerNodeNumbers.length < 1 ||
    blocked.blockerNodeNumbers.length > MAX_TASK_PLAN_STEPS ||
    blocked.blockerNodeNumbers.some((nodeNumber) => !isPositiveSafeInteger(nodeNumber)) ||
    new Set(blocked.blockerNodeNumbers).size !== blocked.blockerNodeNumbers.length
  ) {
    return undefined;
  }
  return Object.freeze({
    state: "blocked",
    blockerNodeNumbers: Object.freeze([...blocked.blockerNodeNumbers] as number[]),
  });
}

function schedulePreviewMatchesDesktopGraph(
  preview: DesktopProjectTaskSchedulePreview,
  nodes: readonly DesktopProjectTaskGraphNode[],
): boolean {
  const ready = nodes.filter((node) => node.status === "ready");
  const running = nodes.filter((node) => node.status === "running");
  const dependenciesSucceeded = (node: DesktopProjectTaskGraphNode) =>
    node.dependsOnNodeNumbers.every(
      (dependencyNumber) => nodes[dependencyNumber - 1]?.status === "succeeded",
    );
  if (
    ready.length > 1 ||
    running.length > 1 ||
    (ready.length > 0 && running.length > 0) ||
    [...ready, ...running].some((node) => !dependenciesSucceeded(node))
  ) {
    return false;
  }
  if (running[0] !== undefined) {
    return preview.state === "busy" && preview.nodeNumber === running[0].nodeNumber;
  }
  if (ready[0] !== undefined) {
    return preview.state === "awaiting_claim" && preview.nodeNumber === ready[0].nodeNumber;
  }
  const candidate = nodes.find((node) => node.status === "pending" && dependenciesSucceeded(node));
  if (candidate !== undefined) {
    return preview.state === "dependency_eligible" && preview.nodeNumber === candidate.nodeNumber;
  }
  if (nodes.every((node) => node.status === "succeeded")) {
    return preview.state === "complete";
  }
  const blockerNodeNumbers = nodes
    .filter((node) => ["blocked", "cancelled", "failed", "interrupted"].includes(node.status))
    .map((node) => node.nodeNumber);
  return (
    preview.state === "blocked" &&
    blockerNodeNumbers.length > 0 &&
    blockerNodeNumbers.length === preview.blockerNodeNumbers.length &&
    blockerNodeNumbers.every(
      (nodeNumber, index) => nodeNumber === preview.blockerNodeNumbers[index],
    )
  );
}

function planMatchesRequirement(plan: unknown, requirement: unknown): boolean {
  if (plan === null) {
    return true;
  }
  const planRecord = exactRecord(plan, [
    "basedOnRequirementRevisionId",
    "revisionId",
    "revisionNumber",
    "steps",
  ]);
  const requirementRecord = exactRecord(requirement, [
    "acceptanceCriteria",
    "constraints",
    "objective",
    "revisionId",
    "revisionNumber",
    "sourceText",
  ]);
  return planRecord?.basedOnRequirementRevisionId === requirementRecord?.revisionId;
}

function plansMatchStage(candidate: unknown, confirmed: unknown, stage: unknown): boolean {
  const stageHasCandidate = stage === "candidate_plan" || stage === "active_graph_with_candidate";
  const stageRequiresConfirmed =
    stage === "confirmed_plan" ||
    stage === "active_graph" ||
    stage === "active_graph_with_candidate";
  return (
    (candidate !== null) === stageHasCandidate &&
    (!stageRequiresConfirmed || confirmed !== null) &&
    (stage !== "requirements_only" || confirmed === null)
  );
}

function graphMatchesStage(graph: unknown, stage: unknown): boolean {
  const stageHasGraph = stage === "active_graph" || stage === "active_graph_with_candidate";
  return (graph !== null) === stageHasGraph;
}

function plansMatchLatest(
  candidate: unknown,
  confirmed: unknown,
  latestPlanRevisionId: unknown,
): boolean {
  const latest = candidate ?? confirmed;
  if (latest === null) {
    return latestPlanRevisionId === null;
  }
  return (
    exactRecord(latest, ["basedOnRequirementRevisionId", "revisionId", "revisionNumber", "steps"])
      ?.revisionId === latestPlanRevisionId
  );
}

function decodeProjectedDesktopTaskRequirement(
  input: unknown,
): DesktopProjectTaskRequirement | undefined {
  const record = exactRecord(input, [
    "acceptanceCriteria",
    "constraints",
    "objective",
    "revisionNumber",
    "sourceText",
  ]);
  if (
    record === undefined ||
    !isPositiveSafeInteger(record.revisionNumber) ||
    !validTaskSourceText(record.sourceText) ||
    !validTaskSourceText(record.objective) ||
    !validTaskRequirementItems(record.constraints) ||
    !validTaskRequirementItems(record.acceptanceCriteria)
  ) {
    return undefined;
  }
  if (
    utf8ByteLength(
      [
        record.sourceText,
        record.objective,
        ...record.constraints,
        ...record.acceptanceCriteria,
      ].join(""),
    ) > MAX_TASK_REQUIREMENT_TOTAL_BYTES
  ) {
    return undefined;
  }
  return Object.freeze({
    revisionNumber: record.revisionNumber,
    sourceText: record.sourceText,
    objective: record.objective,
    constraints: Object.freeze([...record.constraints]),
    acceptanceCriteria: Object.freeze([...record.acceptanceCriteria]),
  });
}

function decodeProjectedDesktopTaskCatalog(
  input: unknown,
  expectedProjectId: string,
): DesktopProjectTaskCatalog {
  const record = exactRecord(input, ["hasMore", "projectId", "tasks"]);
  if (
    record === undefined ||
    record.projectId !== expectedProjectId ||
    typeof record.hasMore !== "boolean" ||
    !Array.isArray(record.tasks) ||
    record.tasks.length > MAX_TASK_CATALOG_PAGE_SIZE
  ) {
    throw new BootstrapStateTransitionError();
  }
  const tasks = record.tasks.map((task) =>
    decodeDesktopProjectTaskSummary(task, expectedProjectId),
  );
  if (
    tasks.some((task) => task === undefined) ||
    new Set(tasks.map((task) => task?.taskId)).size !== tasks.length
  ) {
    throw new BootstrapStateTransitionError();
  }
  return Object.freeze({
    projectId: expectedProjectId,
    tasks: Object.freeze(tasks as DesktopProjectTaskSummary[]),
    hasMore: record.hasMore,
  });
}

function validTaskTitle(input: unknown): input is string {
  return (
    validBoundedText(input, MAX_TASK_TITLE_BYTES) && utf8ByteLength(input) <= MAX_TASK_TITLE_BYTES
  );
}

function validTaskSourceText(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    utf8ByteLength(input) <= MAX_TASK_SOURCE_TEXT_BYTES &&
    !input.includes("\0")
  );
}

function validTaskRequirementItems(input: unknown): input is string[] {
  return (
    Array.isArray(input) &&
    input.length <= MAX_TASK_REQUIREMENT_ITEMS &&
    input.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        utf8ByteLength(item) <= MAX_TASK_REQUIREMENT_ITEM_BYTES &&
        !item.includes("\0"),
    )
  );
}

function validTaskPlanStepText(input: unknown, maxBytes: number): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    utf8ByteLength(input) <= maxBytes &&
    !input.includes("\0")
  );
}

function validProjectDisplayName(input: unknown): input is string {
  return (
    validBoundedText(input, MAX_PROJECT_DISPLAY_NAME_BYTES) &&
    utf8ByteLength(input) <= MAX_PROJECT_DISPLAY_NAME_BYTES
  );
}

function isDesktopProjectPlatform(input: unknown): input is DesktopProjectPlatform {
  return input === "macos" || input === "windows" || input === "linux";
}

function utf8ByteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

function isNormalizedProjectPath(platform: DesktopProjectPlatform, input: string): boolean {
  if (input.includes("\0")) {
    return false;
  }
  if (platform !== "windows") {
    if (input === "/") {
      return true;
    }
    return (
      input.startsWith("/") &&
      !input.endsWith("/") &&
      input
        .slice(1)
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }
  if (input.includes("/") || input.startsWith("\\\\?\\") || input.startsWith("\\\\.\\")) {
    return false;
  }
  if (/^[A-Z]:\\/.test(input)) {
    if (input.length === 3) {
      return true;
    }
    return (
      !input.endsWith("\\") &&
      input
        .slice(3)
        .split("\\")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }
  if (!input.startsWith("\\\\")) {
    return false;
  }
  const segments = input.slice(2).split("\\");
  if (
    segments.length < 2 ||
    segments[0]?.length === 0 ||
    segments[1]?.length === 0 ||
    segments[0] === "." ||
    segments[0] === ".." ||
    segments[1] === "." ||
    segments[1] === ".."
  ) {
    return false;
  }
  if (segments.length === 3 && segments[2] === "") {
    return true;
  }
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function projectCatalogsEqual(left: DesktopProjectCatalog, right: DesktopProjectCatalog): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectRoutingBindingsEqual(
  left: DesktopProjectRoutingBindings,
  right: DesktopProjectRoutingBindings,
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
