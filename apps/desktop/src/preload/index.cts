const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const GET_BOOTSTRAP_STATE_CHANNEL = "desktop.bootstrap.get";
const BOOTSTRAP_STATE_CHANGED_CHANNEL = "desktop.bootstrap.changed";
const SET_ROUTING_CONFIGURATION_CHANNEL = "desktop.routing.set";
const CHOOSE_PROJECT_WORKSPACE_CHANNEL = "desktop.project.choose";
const BIND_PROJECT_DEFAULT_ROUTING_CHANNEL = "desktop.project.routing.bind_default";
const READ_PROJECT_TASK_CATALOG_CHANNEL = "desktop.task.catalog_page";
const CREATE_PROJECT_TASK_CHANNEL = "desktop.task.create";
const READ_PROJECT_TASK_DETAIL_CHANNEL = "desktop.task.detail";
const GENERATE_PROJECT_TASK_CANDIDATE_PLAN_CHANNEL = "desktop.task.plan.generate_candidate";
const REVISE_PROJECT_TASK_REQUIREMENT_CHANNEL = "desktop.task.requirement.revise";
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
const TASK_STAGES = new Set([
  "requirements_only",
  "candidate_plan",
  "confirmed_plan",
  "active_graph",
  "active_graph_with_candidate",
]);
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

type PreloadProjectPlatform = "macos" | "windows" | "linux";
type PreloadProjectSummary = Readonly<{
  projectId: string;
  projectVersion: 1;
  displayName: string;
  workspace: Readonly<{
    platform: PreloadProjectPlatform;
    absolutePath: string;
    identityStatus: "unverified";
  }>;
}>;
type PreloadProjectCatalog = Readonly<{
  projects: readonly PreloadProjectSummary[];
  hasMore: boolean;
}>;
type PreloadProjectSelectionResult =
  | Readonly<{ status: "cancelled" | "unavailable" }>
  | Readonly<{
      status: "selected";
      registrationStatus: "registered" | "existing";
      project: PreloadProjectSummary;
      projects: PreloadProjectCatalog;
    }>;
type PreloadProjectRoutingBindingStatus = Readonly<{
  projectId: string;
  status: "unbound" | "default_bound" | "other_profile_bound";
  bindingVersion: number | null;
}>;
type PreloadProjectRoutingBindings = Readonly<{
  bindings: readonly PreloadProjectRoutingBindingStatus[];
}>;
type PreloadProjectRoutingBindingMutationResult = Readonly<{
  status: "bound" | "existing" | "conflict" | "routing_unconfigured" | "unavailable";
}>;
type PreloadProjectTaskSummary = Readonly<{
  taskId: string;
  projectId: string;
  taskVersion: number;
  title: string;
  objective: string;
  stage:
    | "requirements_only"
    | "candidate_plan"
    | "confirmed_plan"
    | "active_graph"
    | "active_graph_with_candidate";
}>;
type PreloadProjectTaskCatalog = Readonly<{
  projectId: string;
  tasks: readonly PreloadProjectTaskSummary[];
  hasMore: boolean;
}>;
type PreloadProjectTaskCatalogResult =
  | Readonly<{ status: "loaded"; catalog: PreloadProjectTaskCatalog }>
  | Readonly<{ status: "unavailable" }>;
type PreloadProjectTaskCreation = Readonly<{
  projectId: string;
  title: string;
  sourceText: string;
}>;
type PreloadProjectTaskMutationResult =
  | Readonly<{
      status: "created" | "existing";
      taskId: string;
      catalog: PreloadProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "routing_unbound" | "unavailable" }>;
type PreloadProjectTaskRequirement = Readonly<{
  revisionNumber: number;
  sourceText: string;
  objective: string;
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}>;
type PreloadProjectTaskCandidatePlanStep = Readonly<{
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
}>;
type PreloadProjectTaskCandidatePlan = Readonly<{
  revisionNumber: number;
  steps: readonly PreloadProjectTaskCandidatePlanStep[];
}>;
type PreloadProjectTaskDetail = Readonly<{
  projectId: string;
  taskId: string;
  taskVersion: number;
  title: string;
  stage: PreloadProjectTaskSummary["stage"];
  activeRequirement: PreloadProjectTaskRequirement;
  candidatePlan: PreloadProjectTaskCandidatePlan | null;
}>;
type PreloadProjectTaskSelection = Readonly<{ projectId: string; taskId: string }>;
type PreloadProjectTaskDetailResult =
  | Readonly<{ status: "loaded"; detail: PreloadProjectTaskDetail }>
  | Readonly<{ status: "unavailable" }>;
type PreloadProjectTaskRequirementRevision = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  sourceText: string;
}>;
type PreloadProjectTaskRequirementMutationResult =
  | Readonly<{
      status: "revised" | "existing";
      taskId: string;
      detail: PreloadProjectTaskDetail;
      catalog: PreloadProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;
type PreloadProjectTaskCandidatePlanGeneration = Readonly<{
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
}>;
type PreloadProjectTaskCandidatePlanMutationResult =
  | Readonly<{
      status: "generated" | "existing";
      taskId: string;
      detail: PreloadProjectTaskDetail;
      catalog: PreloadProjectTaskCatalog;
    }>
  | Readonly<{ status: "conflict" | "unavailable" }>;

type PreloadBootstrapState =
  | Readonly<{ phase: "starting" | "stopping" }>
  | Readonly<{
      phase: "ready";
      account: PreloadAccountStatus;
      catalog: PreloadModelCatalogSummary;
      routing: PreloadRoutingConfiguration;
      projects: PreloadProjectCatalog;
      projectRoutingBindings: PreloadProjectRoutingBindings;
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
    keys.length === 6 &&
    keys.includes("phase") &&
    keys.includes("account") &&
    keys.includes("catalog") &&
    keys.includes("routing") &&
    keys.includes("projects") &&
    keys.includes("projectRoutingBindings")
  ) {
    const account = decodeAccountStatus(record.account);
    const catalog = decodeModelCatalogSummary(record.catalog);
    const routing = decodeRoutingConfiguration(record.routing);
    const projects = decodeProjectCatalog(record.projects);
    const projectRoutingBindings = decodeProjectRoutingBindings(
      record.projectRoutingBindings,
      projects?.projects.map((project) => project.projectId),
    );
    if (
      account !== undefined &&
      catalog !== undefined &&
      routing !== undefined &&
      projects !== undefined &&
      projectRoutingBindings !== undefined
    ) {
      return Object.freeze({
        phase: "ready",
        account,
        catalog,
        routing,
        projects,
        projectRoutingBindings,
      });
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

function decodeProjectSelectionResult(input: unknown): PreloadProjectSelectionResult {
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
    throw new Error("The desktop Project selection result is invalid.");
  }
  const project = decodeProjectSummary(record.project);
  const projects = decodeProjectCatalog(record.projects);
  if (project === undefined || projects === undefined) {
    throw new Error("The desktop Project selection result is invalid.");
  }
  return Object.freeze({
    status: "selected",
    registrationStatus: record.registrationStatus,
    project,
    projects,
  });
}

function decodeProjectRoutingBindingMutationResult(
  input: unknown,
): PreloadProjectRoutingBindingMutationResult {
  const record = exactRecord(input, ["status"]);
  if (
    record === undefined ||
    (record.status !== "bound" &&
      record.status !== "existing" &&
      record.status !== "conflict" &&
      record.status !== "routing_unconfigured" &&
      record.status !== "unavailable")
  ) {
    throw new Error("The desktop Project routing binding result is invalid.");
  }
  return Object.freeze({ status: record.status });
}

function decodeProjectTaskCatalogResult(
  input: unknown,
  expectedProjectId: string,
): PreloadProjectTaskCatalogResult {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  const record = exactRecord(input, ["catalog", "status"]);
  if (record?.status !== "loaded") {
    throw new Error("The desktop Project Task catalog result is invalid.");
  }
  const catalog = decodeProjectTaskCatalog(record.catalog);
  if (catalog === undefined || catalog.projectId !== expectedProjectId) {
    throw new Error("The desktop Project Task catalog result is invalid.");
  }
  return Object.freeze({ status: "loaded", catalog });
}

function decodeProjectTaskCreation(input: unknown): PreloadProjectTaskCreation | undefined {
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

function decodeProjectTaskMutationResult(
  input: unknown,
  expectedProjectId: string,
): PreloadProjectTaskMutationResult {
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
  const catalog = decodeProjectTaskCatalog(record?.catalog);
  if (
    record === undefined ||
    (record.status !== "created" && record.status !== "existing") ||
    !isUuid(record.taskId) ||
    catalog === undefined ||
    catalog.projectId !== expectedProjectId
  ) {
    throw new Error("The desktop Project Task creation result is invalid.");
  }
  return Object.freeze({ status: record.status, taskId: record.taskId, catalog });
}

function decodeProjectTaskSelection(input: unknown): PreloadProjectTaskSelection | undefined {
  const record = exactRecord(input, ["projectId", "taskId"]);
  return isUuid(record?.projectId) && isUuid(record.taskId)
    ? Object.freeze({ projectId: record.projectId, taskId: record.taskId })
    : undefined;
}

function decodeProjectTaskDetailResult(
  input: unknown,
  expected: PreloadProjectTaskSelection,
): PreloadProjectTaskDetailResult {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  const record = exactRecord(input, ["detail", "status"]);
  const detail = decodeProjectTaskDetail(record?.detail);
  if (
    record?.status !== "loaded" ||
    detail === undefined ||
    detail.projectId !== expected.projectId ||
    detail.taskId !== expected.taskId
  ) {
    throw new Error("The desktop Project Task detail result is invalid.");
  }
  return Object.freeze({ status: "loaded", detail });
}

function decodeProjectTaskRequirementRevision(
  input: unknown,
): PreloadProjectTaskRequirementRevision | undefined {
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

function decodeProjectTaskRequirementMutationResult(
  input: unknown,
  expected: PreloadProjectTaskSelection,
): PreloadProjectTaskRequirementMutationResult {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  const detail = decodeProjectTaskDetail(record?.detail);
  const catalog = decodeProjectTaskCatalog(record?.catalog);
  if (
    record === undefined ||
    (record.status !== "revised" && record.status !== "existing") ||
    record.taskId !== expected.taskId ||
    detail?.projectId !== expected.projectId ||
    detail.taskId !== expected.taskId ||
    catalog?.projectId !== expected.projectId
  ) {
    throw new Error("The desktop Project Task Requirement result is invalid.");
  }
  return Object.freeze({ status: record.status, taskId: expected.taskId, detail, catalog });
}

function decodeProjectTaskCandidatePlanGeneration(
  input: unknown,
): PreloadProjectTaskCandidatePlanGeneration | undefined {
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

function decodeProjectTaskCandidatePlanMutationResult(
  input: unknown,
  expected: PreloadProjectTaskCandidatePlanGeneration,
): PreloadProjectTaskCandidatePlanMutationResult {
  const terminal = exactRecord(input, ["status"]);
  if (terminal?.status === "conflict" || terminal?.status === "unavailable") {
    return Object.freeze({ status: terminal.status });
  }
  const record = exactRecord(input, ["catalog", "detail", "status", "taskId"]);
  const detail = decodeProjectTaskDetail(record?.detail);
  const catalog = decodeProjectTaskCatalog(record?.catalog);
  if (
    record === undefined ||
    (record.status !== "generated" && record.status !== "existing") ||
    record.taskId !== expected.taskId ||
    detail?.projectId !== expected.projectId ||
    detail.taskId !== expected.taskId ||
    catalog?.projectId !== expected.projectId
  ) {
    throw new Error("The desktop Project Task candidate Plan result is invalid.");
  }
  return Object.freeze({
    status: record.status,
    taskId: expected.taskId,
    detail,
    catalog,
  });
}

function decodeProjectTaskDetail(input: unknown): PreloadProjectTaskDetail | undefined {
  const record = exactRecord(input, [
    "activeRequirement",
    "candidatePlan",
    "projectId",
    "stage",
    "taskId",
    "taskVersion",
    "title",
  ]);
  const requirement = decodeProjectTaskRequirement(record?.activeRequirement);
  const candidatePlan = decodeProjectTaskCandidatePlan(record?.candidatePlan);
  if (
    !isUuid(record?.projectId) ||
    !isUuid(record.taskId) ||
    !isPositiveSafeInteger(record.taskVersion) ||
    !validTaskTitle(record.title) ||
    typeof record.stage !== "string" ||
    !TASK_STAGES.has(record.stage) ||
    requirement === undefined ||
    candidatePlan === undefined ||
    !candidatePlanMatchesStage(record.candidatePlan, record.stage)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    taskId: record.taskId,
    taskVersion: record.taskVersion,
    title: record.title,
    stage: record.stage as PreloadProjectTaskSummary["stage"],
    activeRequirement: requirement,
    candidatePlan,
  });
}

function decodeProjectTaskCandidatePlan(
  input: unknown,
): PreloadProjectTaskCandidatePlan | null | undefined {
  if (input === null) {
    return null;
  }
  const record = exactRecord(input, ["revisionNumber", "steps"]);
  if (
    record === undefined ||
    !isPositiveSafeInteger(record.revisionNumber) ||
    !Array.isArray(record.steps) ||
    record.steps.length < 1 ||
    record.steps.length > MAX_TASK_PLAN_STEPS
  ) {
    return undefined;
  }
  let totalBytes = 0;
  const steps = record.steps.map((inputStep) => {
    const step = exactRecord(inputStep, ["acceptanceCriteria", "description", "title"]);
    if (
      step === undefined ||
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
  return steps.some((step) => step === undefined) || totalBytes > MAX_TASK_PLAN_TOTAL_BYTES
    ? undefined
    : Object.freeze({
        revisionNumber: record.revisionNumber,
        steps: Object.freeze(steps as PreloadProjectTaskCandidatePlanStep[]),
      });
}

function candidatePlanMatchesStage(candidate: unknown, stage: unknown): boolean {
  const stageHasCandidate = stage === "candidate_plan" || stage === "active_graph_with_candidate";
  return (candidate !== null) === stageHasCandidate;
}

function decodeProjectTaskRequirement(input: unknown): PreloadProjectTaskRequirement | undefined {
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
    !validTaskRequirementItems(record.acceptanceCriteria) ||
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

function decodeProjectTaskCatalog(input: unknown): PreloadProjectTaskCatalog | undefined {
  const record = exactRecord(input, ["hasMore", "projectId", "tasks"]);
  if (
    record === undefined ||
    !isUuid(record.projectId) ||
    typeof record.hasMore !== "boolean" ||
    !Array.isArray(record.tasks) ||
    record.tasks.length > MAX_TASK_CATALOG_PAGE_SIZE
  ) {
    return undefined;
  }
  const tasks = record.tasks.map((task) =>
    decodeProjectTaskSummary(task, record.projectId as string),
  );
  if (
    tasks.some((task) => task === undefined) ||
    new Set(tasks.map((task) => task?.taskId)).size !== tasks.length
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: record.projectId,
    tasks: Object.freeze(tasks as PreloadProjectTaskSummary[]),
    hasMore: record.hasMore,
  });
}

function decodeProjectTaskSummary(
  input: unknown,
  expectedProjectId: string,
): PreloadProjectTaskSummary | undefined {
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
    !TASK_STAGES.has(record.stage)
  ) {
    return undefined;
  }
  return Object.freeze({
    taskId: record.taskId,
    projectId: expectedProjectId,
    taskVersion: record.taskVersion,
    title: record.title,
    objective: record.objective,
    stage: record.stage as PreloadProjectTaskSummary["stage"],
  });
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

function decodeProjectCatalog(input: unknown): PreloadProjectCatalog | undefined {
  const record = exactRecord(input, ["hasMore", "projects"]);
  if (
    record === undefined ||
    typeof record.hasMore !== "boolean" ||
    !Array.isArray(record.projects) ||
    record.projects.length > MAX_PROJECT_CATALOG_PAGE_SIZE ||
    (record.hasMore && record.projects.length === 0)
  ) {
    return undefined;
  }
  const projects = record.projects.map(decodeProjectSummary);
  if (projects.some((project) => project === undefined)) {
    return undefined;
  }
  const decoded = projects as PreloadProjectSummary[];
  const ids = decoded.map((project) => project.projectId);
  const workspaces = decoded.map(
    (project) => `${project.workspace.platform}\0${project.workspace.absolutePath}`,
  );
  return new Set(ids).size !== ids.length || new Set(workspaces).size !== workspaces.length
    ? undefined
    : Object.freeze({ projects: Object.freeze(decoded), hasMore: record.hasMore });
}

function decodeProjectSummary(input: unknown): PreloadProjectSummary | undefined {
  const record = exactRecord(input, ["displayName", "projectId", "projectVersion", "workspace"]);
  const workspace = exactRecord(record?.workspace, ["absolutePath", "identityStatus", "platform"]);
  if (
    record === undefined ||
    !isUuid(record.projectId) ||
    record.projectVersion !== 1 ||
    !validBoundedText(record.displayName, MAX_PROJECT_DISPLAY_NAME_BYTES) ||
    utf8ByteLength(record.displayName) > MAX_PROJECT_DISPLAY_NAME_BYTES ||
    workspace === undefined ||
    workspace.identityStatus !== "unverified" ||
    !isProjectPlatform(workspace.platform) ||
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

function decodeProjectRoutingBindings(
  input: unknown,
  expectedProjectIds: readonly string[] | undefined,
): PreloadProjectRoutingBindings | undefined {
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
      expectedProjectId === undefined ||
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
      projectId: expectedProjectId,
      status: decoded.status,
      bindingVersion: decoded.bindingVersion as number | null,
    });
  });
  return bindings.some((binding) => binding === undefined)
    ? undefined
    : Object.freeze({
        bindings: Object.freeze(bindings as PreloadProjectRoutingBindingStatus[]),
      });
}

function isProjectPlatform(input: unknown): input is PreloadProjectPlatform {
  return input === "macos" || input === "windows" || input === "linux";
}

function utf8ByteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

function isNormalizedProjectPath(platform: PreloadProjectPlatform, input: string): boolean {
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
  async chooseProjectWorkspace(): Promise<PreloadProjectSelectionResult> {
    return decodeProjectSelectionResult(await ipcRenderer.invoke(CHOOSE_PROJECT_WORKSPACE_CHANNEL));
  },
  async bindProjectToDefaultRouting(
    projectId: string,
  ): Promise<PreloadProjectRoutingBindingMutationResult> {
    if (!isUuid(projectId)) {
      throw new TypeError("A valid desktop Project identifier is required.");
    }
    return decodeProjectRoutingBindingMutationResult(
      await ipcRenderer.invoke(BIND_PROJECT_DEFAULT_ROUTING_CHANNEL, projectId),
    );
  },
  async readProjectTaskCatalog(projectId: string): Promise<PreloadProjectTaskCatalogResult> {
    if (!isUuid(projectId)) {
      throw new TypeError("A valid desktop Project identifier is required.");
    }
    return decodeProjectTaskCatalogResult(
      await ipcRenderer.invoke(READ_PROJECT_TASK_CATALOG_CHANNEL, projectId),
      projectId,
    );
  },
  async createProjectTask(
    input: PreloadProjectTaskCreation,
  ): Promise<PreloadProjectTaskMutationResult> {
    const creation = decodeProjectTaskCreation(input);
    if (creation === undefined) {
      throw new TypeError("A valid desktop Project Task is required.");
    }
    return decodeProjectTaskMutationResult(
      await ipcRenderer.invoke(CREATE_PROJECT_TASK_CHANNEL, creation),
      creation.projectId,
    );
  },
  async readProjectTaskDetail(
    input: PreloadProjectTaskSelection,
  ): Promise<PreloadProjectTaskDetailResult> {
    const selection = decodeProjectTaskSelection(input);
    if (selection === undefined) {
      throw new TypeError("A valid desktop Project Task selection is required.");
    }
    return decodeProjectTaskDetailResult(
      await ipcRenderer.invoke(READ_PROJECT_TASK_DETAIL_CHANNEL, selection),
      selection,
    );
  },
  async reviseProjectTaskRequirement(
    input: PreloadProjectTaskRequirementRevision,
  ): Promise<PreloadProjectTaskRequirementMutationResult> {
    const revision = decodeProjectTaskRequirementRevision(input);
    if (revision === undefined) {
      throw new TypeError("A valid desktop Project Task Requirement revision is required.");
    }
    return decodeProjectTaskRequirementMutationResult(
      await ipcRenderer.invoke(REVISE_PROJECT_TASK_REQUIREMENT_CHANNEL, revision),
      revision,
    );
  },
  async generateProjectTaskCandidatePlan(
    input: PreloadProjectTaskCandidatePlanGeneration,
  ): Promise<PreloadProjectTaskCandidatePlanMutationResult> {
    const generation = decodeProjectTaskCandidatePlanGeneration(input);
    if (generation === undefined) {
      throw new TypeError("A valid desktop Project Task candidate Plan request is required.");
    }
    return decodeProjectTaskCandidatePlanMutationResult(
      await ipcRenderer.invoke(GENERATE_PROJECT_TASK_CANDIDATE_PLAN_CHANNEL, generation),
      generation,
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
