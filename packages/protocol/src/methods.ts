import { z } from "zod";

import { validateJsonValue, type JsonValue } from "./json-value.js";
import { NamespacedTokenSchema, NonNegativeSafeIntegerSchema, StreamIdSchema } from "./schemas.js";
import { protocolFailure, protocolSuccess, type ProtocolResult } from "./result.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_CATALOG_CURSOR_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]+$/;
const MAX_PROVIDER_CHARACTERS = 256;
const MAX_MODEL_CHARACTERS = 4_096;
const MAX_REASONING_EFFORT_CHARACTERS = 128;
const MAX_MODEL_CATALOG_CURSOR_CHARACTERS = 2_048;
const MAX_PROJECT_DISPLAY_NAME_BYTES = 256;
const MAX_PROJECT_PATH_BYTES = 4_096;
const MAX_TASK_TITLE_BYTES = 256;
const MAX_TASK_SOURCE_TEXT_BYTES = 16 * 1_024;
const MAX_TASK_REQUIREMENT_ITEM_BYTES = 4 * 1_024;
const MAX_TASK_REQUIREMENT_TOTAL_BYTES = 256 * 1_024;
const MAX_TASK_PLAN_STEP_TITLE_BYTES = 512;
const MAX_TASK_PLAN_STEP_DESCRIPTION_BYTES = 8 * 1_024;
const MAX_TASK_PLAN_TOTAL_BYTES = 256 * 1_024;
const MAX_TASK_GRAPH_DEPENDENCIES = 2_000;

export const MAX_MODEL_CATALOG_PAGE_SIZE = 16;
export const MAX_MODEL_REASONING_EFFORTS = 64;
export const MAX_PROJECT_CATALOG_PAGE_SIZE = 12;
export const MAX_PROJECT_ROUTING_BINDING_BATCH_SIZE = 16;
export const MAX_TASK_CATALOG_PAGE_SIZE = 12;
export const MAX_TASK_REQUIREMENT_ITEMS = 100;
export const MAX_TASK_PLAN_STEPS = 200;

export const TASK_NODE_STATUSES = Object.freeze([
  "pending",
  "ready",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const);

export const TASK_OPERATION_KINDS = Object.freeze([
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

export const EXECUTION_ADMISSION_REJECTION_REASONS = Object.freeze([
  "user_confirmation_required",
  "task_not_ready",
  "operation_not_allowed",
  "validation_command_required",
  "unsupported_platform",
  "workspace_unavailable",
  "workspace_not_canonical",
  "workspace_not_git_root",
  "workspace_dirty",
  "workspace_changed",
  "model_unavailable",
] as const);

export const SystemHealthParamsSchema = z.object({}).strict();
export const SystemHealthResultSchema = z
  .object({
    status: z.literal("ok"),
    streamId: StreamIdSchema,
    uptimeMs: NonNegativeSafeIntegerSchema,
  })
  .passthrough();

export const SystemShutdownParamsSchema = z
  .object({
    reason: NamespacedTokenSchema.optional(),
  })
  .strict();
export const SystemShutdownResultSchema = z.object({ accepted: z.literal(true) }).passthrough();

export const ACCOUNT_PLAN_TYPES = Object.freeze([
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

export const AccountStatusParamsSchema = z.object({}).strict();
export const AccountStatusResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string().regex(UUID_PATTERN),
    workerSessionId: z.string().regex(UUID_PATTERN),
    observedAtMs: NonNegativeSafeIntegerSchema,
    status: z.enum(["authenticated", "authentication_required", "not_required"]),
    credentialKind: z.enum(["amazon_bedrock", "api_key", "chatgpt"]).nullable(),
    planType: z.enum(ACCOUNT_PLAN_TYPES).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "authenticated" && value.credentialKind === null) ||
      (value.status !== "authenticated" && value.credentialKind !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["credentialKind"],
        message: "Credential kind must match authentication status",
      });
    }
    if (
      (value.credentialKind === "chatgpt" && value.planType === null) ||
      (value.credentialKind !== "chatgpt" && value.planType !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["planType"],
        message: "Plan type is valid only for ChatGPT credentials",
      });
    }
  });

export type HarnessAccountStatusResult = z.infer<typeof AccountStatusResultSchema>;

export const MODEL_INPUT_MODALITIES = Object.freeze(["audio", "image", "text"] as const);
export type HarnessModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

export const ModelCatalogPageParamsSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(MAX_MODEL_CATALOG_CURSOR_CHARACTERS)
      .regex(MODEL_CATALOG_CURSOR_PATTERN)
      .nullable(),
    limit: z.number().int().min(1).max(MAX_MODEL_CATALOG_PAGE_SIZE),
  })
  .strict();

const PublicModelCatalogEntrySchema = z
  .object({
    model: z.string().min(1).max(MAX_MODEL_CHARACTERS),
    defaultReasoningEffort: z.string().min(1).max(MAX_REASONING_EFFORT_CHARACTERS),
    supportedReasoningEfforts: z
      .array(z.string().min(1).max(MAX_REASONING_EFFORT_CHARACTERS))
      .min(1)
      .max(MAX_MODEL_REASONING_EFFORTS),
    inputModalities: z.array(z.enum(MODEL_INPUT_MODALITIES)).min(1).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.supportedReasoningEfforts).size !== value.supportedReasoningEfforts.length) {
      context.addIssue({
        code: "custom",
        path: ["supportedReasoningEfforts"],
        message: "Reasoning efforts must be unique",
      });
    }
    if (!value.supportedReasoningEfforts.includes(value.defaultReasoningEffort)) {
      context.addIssue({
        code: "custom",
        path: ["defaultReasoningEffort"],
        message: "Default reasoning effort must be supported",
      });
    }
    if (new Set(value.inputModalities).size !== value.inputModalities.length) {
      context.addIssue({
        code: "custom",
        path: ["inputModalities"],
        message: "Input modalities must be unique",
      });
    }
  });

export const ModelCatalogPageResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.string().min(1).max(MAX_PROVIDER_CHARACTERS),
    totalVisibleModels: NonNegativeSafeIntegerSchema.max(10_000),
    models: z.array(PublicModelCatalogEntrySchema).max(MAX_MODEL_CATALOG_PAGE_SIZE),
    nextCursor: z
      .string()
      .min(1)
      .max(MAX_MODEL_CATALOG_CURSOR_CHARACTERS)
      .regex(MODEL_CATALOG_CURSOR_PATTERN)
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.models.length > value.totalVisibleModels) {
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "Page cannot exceed the visible model count",
      });
    }
    if (value.nextCursor !== null && value.models.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "An empty page cannot have a next cursor",
      });
    }
    const modelNames = value.models.map((model) => model.model);
    if (new Set(modelNames).size !== modelNames.length) {
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "Page model names must be unique",
      });
    }
  });

export type HarnessModelCatalogPageParams = Readonly<{
  cursor: string | null;
  limit: number;
}>;
export type HarnessPublicModelCatalogEntry = Readonly<{
  model: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly string[];
  inputModalities: readonly HarnessModelInputModality[];
}>;
export type HarnessModelCatalogPageResult = Readonly<{
  schemaVersion: 1;
  provider: string;
  totalVisibleModels: number;
  models: readonly HarnessPublicModelCatalogEntry[];
  nextCursor: string | null;
}>;

export const PROJECT_PLATFORMS = Object.freeze(["macos", "windows", "linux"] as const);
export type HarnessProjectPlatform = (typeof PROJECT_PLATFORMS)[number];

const ProjectWorkspaceSchema = z
  .object({
    platform: z.enum(PROJECT_PLATFORMS),
    absolutePath: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      utf8ByteLength(value.absolutePath) > MAX_PROJECT_PATH_BYTES ||
      !isNormalizedProjectPath(value.platform, value.absolutePath)
    ) {
      context.addIssue({
        code: "custom",
        path: ["absolutePath"],
        message: "Project workspace path is invalid",
      });
    }
  });

const ProjectSummarySchema = z
  .object({
    projectId: z.string().regex(UUID_PATTERN),
    projectVersion: z.literal(1),
    displayName: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim() === value &&
          utf8ByteLength(value) <= MAX_PROJECT_DISPLAY_NAME_BYTES &&
          !containsControlCharacter(value),
        "Project display name is invalid",
      ),
    workspace: ProjectWorkspaceSchema.extend({ identityStatus: z.literal("unverified") }).strict(),
  })
  .strict();

export const ProjectCatalogPageParamsSchema = z
  .object({
    cursor: z.string().regex(UUID_PATTERN).nullable(),
    limit: z.number().int().min(1).max(MAX_PROJECT_CATALOG_PAGE_SIZE),
  })
  .strict();

export const ProjectCatalogPageResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    projects: z.array(ProjectSummarySchema).max(MAX_PROJECT_CATALOG_PAGE_SIZE),
    nextCursor: z.string().regex(UUID_PATTERN).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const projectIds = value.projects.map((project) => project.projectId);
    const workspaces = value.projects.map(
      (project) => `${project.workspace.platform}\0${project.workspace.absolutePath}`,
    );
    if (new Set(projectIds).size !== projectIds.length) {
      context.addIssue({
        code: "custom",
        path: ["projects"],
        message: "Project identifiers must be unique",
      });
    }
    if (new Set(workspaces).size !== workspaces.length) {
      context.addIssue({
        code: "custom",
        path: ["projects"],
        message: "Project workspaces must be unique",
      });
    }
    if (value.nextCursor !== null && value.nextCursor !== value.projects.at(-1)?.projectId) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Project page cursor must identify the final Project",
      });
    }
  });

export const ProjectRegisterParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    displayName: ProjectSummarySchema.shape.displayName,
    workspace: ProjectWorkspaceSchema,
  })
  .strict();

export const ProjectRegisterResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["registered", "existing"]),
    project: ProjectSummarySchema,
  })
  .strict();

export type HarnessProjectWorkspace = Readonly<{
  platform: HarnessProjectPlatform;
  absolutePath: string;
}>;
export type HarnessProjectSummary = Readonly<{
  projectId: string;
  projectVersion: 1;
  displayName: string;
  workspace: HarnessProjectWorkspace & Readonly<{ identityStatus: "unverified" }>;
}>;
export type HarnessProjectCatalogPageParams = Readonly<{
  cursor: string | null;
  limit: number;
}>;
export type HarnessProjectCatalogPageResult = Readonly<{
  schemaVersion: 1;
  projects: readonly HarnessProjectSummary[];
  nextCursor: string | null;
}>;
export type HarnessProjectRegisterParams = Readonly<{
  commandId: string;
  projectId: string;
  displayName: string;
  workspace: HarnessProjectWorkspace;
}>;
export type HarnessProjectRegisterResult = Readonly<{
  schemaVersion: 1;
  status: "registered" | "existing";
  project: HarnessProjectSummary;
}>;

export const TASK_STAGES = Object.freeze([
  "requirements_only",
  "candidate_plan",
  "confirmed_plan",
  "active_graph",
  "active_graph_with_candidate",
] as const);

const TaskTitleSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim() === value &&
      utf8ByteLength(value) <= MAX_TASK_TITLE_BYTES &&
      !containsControlCharacter(value),
    "Task title is invalid",
  );

const TaskSourceTextSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      utf8ByteLength(value) <= MAX_TASK_SOURCE_TEXT_BYTES &&
      !value.includes("\0"),
    "Task source text is invalid",
  );

const TaskRequirementItemSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      utf8ByteLength(value) <= MAX_TASK_REQUIREMENT_ITEM_BYTES &&
      !value.includes("\0"),
    "Task requirement item is invalid",
  );

const TaskRequirementSchema = z
  .object({
    revisionId: z.string().regex(UUID_PATTERN),
    revisionNumber: NonNegativeSafeIntegerSchema.min(1),
    sourceText: TaskSourceTextSchema,
    objective: TaskSourceTextSchema,
    constraints: z.array(TaskRequirementItemSchema).max(MAX_TASK_REQUIREMENT_ITEMS),
    acceptanceCriteria: z.array(TaskRequirementItemSchema).max(MAX_TASK_REQUIREMENT_ITEMS),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      utf8ByteLength(
        [value.sourceText, value.objective, ...value.constraints, ...value.acceptanceCriteria].join(
          "",
        ),
      ) > MAX_TASK_REQUIREMENT_TOTAL_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceText"],
        message: "Task requirement text exceeds the aggregate limit",
      });
    }
  });

const TaskPlanStepSchema = z
  .object({
    stepId: z.string().regex(UUID_PATTERN),
    title: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          utf8ByteLength(value) <= MAX_TASK_PLAN_STEP_TITLE_BYTES &&
          !value.includes("\0"),
        "Task plan step title is invalid",
      ),
    description: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          utf8ByteLength(value) <= MAX_TASK_PLAN_STEP_DESCRIPTION_BYTES &&
          !value.includes("\0"),
        "Task plan step description is invalid",
      ),
    acceptanceCriteria: z.array(TaskRequirementItemSchema).max(MAX_TASK_REQUIREMENT_ITEMS),
  })
  .strict();

const TaskPlanRevisionSchema = z
  .object({
    revisionId: z.string().regex(UUID_PATTERN),
    revisionNumber: NonNegativeSafeIntegerSchema.min(1),
    basedOnRequirementRevisionId: z.string().regex(UUID_PATTERN),
    steps: z.array(TaskPlanStepSchema).min(1).max(MAX_TASK_PLAN_STEPS),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.steps.map((step) => step.stepId)).size !== value.steps.length) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Task plan step identifiers must be unique",
      });
    }
    if (
      utf8ByteLength(
        value.steps
          .flatMap((step) => [step.title, step.description, ...step.acceptanceCriteria])
          .join(""),
      ) > MAX_TASK_PLAN_TOTAL_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Task plan text exceeds the aggregate limit",
      });
    }
  });

const TaskGraphNodeSchema = z
  .object({
    nodeId: z.string().regex(UUID_PATTERN),
    sourcePlanStepId: z.string().regex(UUID_PATTERN),
    title: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          utf8ByteLength(value) <= MAX_TASK_PLAN_STEP_TITLE_BYTES &&
          !value.includes("\0"),
      ),
    description: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          utf8ByteLength(value) <= MAX_TASK_PLAN_STEP_DESCRIPTION_BYTES &&
          !value.includes("\0"),
      ),
    acceptanceCriteria: z.array(TaskRequirementItemSchema).max(MAX_TASK_REQUIREMENT_ITEMS),
    dependsOnNodeIds: z.array(z.string().regex(UUID_PATTERN)).max(MAX_TASK_PLAN_STEPS),
    status: z.enum(TASK_NODE_STATUSES),
  })
  .strict();

const TaskSchedulePreviewSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("dependency_eligible"),
      nodeId: z.string().regex(UUID_PATTERN),
    })
    .strict(),
  z
    .object({
      state: z.literal("awaiting_claim"),
      nodeId: z.string().regex(UUID_PATTERN),
    })
    .strict(),
  z
    .object({
      state: z.literal("busy"),
      nodeId: z.string().regex(UUID_PATTERN),
    })
    .strict(),
  z
    .object({
      state: z.literal("blocked"),
      blockerNodeIds: z.array(z.string().regex(UUID_PATTERN)).min(1).max(MAX_TASK_PLAN_STEPS),
    })
    .strict(),
  z.object({ state: z.literal("complete") }).strict(),
]);

const TaskNodeOperationManifestSchema = z
  .object({
    manifestId: z.string().regex(UUID_PATTERN),
    nodeId: z.string().regex(UUID_PATTERN),
    stateVersion: NonNegativeSafeIntegerSchema.min(1),
    status: z.enum(["candidate", "confirmed"]),
    operations: z
      .array(
        z
          .object({
            operationId: z.string().regex(UUID_PATTERN),
            kind: z.enum(TASK_OPERATION_KINDS),
          })
          .strict(),
      )
      .min(1)
      .max(TASK_OPERATION_KINDS.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.operations.map((operation) => operation.operationId)).size !==
      value.operations.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Task operation identifiers must be unique",
      });
    }
    if (
      new Set(value.operations.map((operation) => operation.kind)).size !== value.operations.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Task operation kinds must be unique",
      });
    }
  });

const TaskGraphRevisionSchema = z
  .object({
    revisionId: z.string().regex(UUID_PATTERN),
    revisionNumber: NonNegativeSafeIntegerSchema.min(1),
    basedOnPlanRevisionId: z.string().regex(UUID_PATTERN),
    nodes: z.array(TaskGraphNodeSchema).min(1).max(MAX_TASK_PLAN_STEPS),
    operationManifest: TaskNodeOperationManifestSchema.nullable(),
    schedulePreview: TaskSchedulePreviewSchema,
    topologicalOrder: z.array(z.string().regex(UUID_PATTERN)).min(1).max(MAX_TASK_PLAN_STEPS),
  })
  .strict()
  .superRefine((value, context) => {
    const nodeIds = value.nodes.map((node) => node.nodeId);
    const nodeIdSet = new Set(nodeIds);
    if (
      value.nodes.reduce((total, node) => total + node.dependsOnNodeIds.length, 0) >
      MAX_TASK_GRAPH_DEPENDENCIES
    ) {
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "Task graph dependency count exceeds the aggregate limit",
      });
    }
    if (nodeIdSet.size !== nodeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "Task graph node identifiers must be unique",
      });
    }
    const orderIndex = new Map(value.topologicalOrder.map((nodeId, index) => [nodeId, index]));
    if (
      orderIndex.size !== nodeIds.length ||
      value.topologicalOrder.length !== nodeIds.length ||
      value.topologicalOrder.some((nodeId) => !nodeIdSet.has(nodeId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["topologicalOrder"],
        message: "Task graph topological order must contain every node exactly once",
      });
    }
    value.nodes.forEach((node, nodeIndex) => {
      const dependencies = new Set(node.dependsOnNodeIds);
      if (
        dependencies.size !== node.dependsOnNodeIds.length ||
        dependencies.has(node.nodeId) ||
        node.dependsOnNodeIds.some((dependencyId) => !nodeIdSet.has(dependencyId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodes", nodeIndex, "dependsOnNodeIds"],
          message: "Task graph dependencies must be unique references to other nodes",
        });
      }
      const nodeOrder = orderIndex.get(node.nodeId);
      if (
        nodeOrder === undefined ||
        node.dependsOnNodeIds.some((dependencyId) => {
          const dependencyOrder = orderIndex.get(dependencyId);
          return dependencyOrder === undefined || dependencyOrder >= nodeOrder;
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["topologicalOrder"],
          message: "Task graph topological order must place dependencies first",
        });
      }
    });
    if (!schedulePreviewMatchesGraph(value.schedulePreview, value.nodes, value.topologicalOrder)) {
      context.addIssue({
        code: "custom",
        path: ["schedulePreview"],
        message: "Task schedule preview must match the authoritative graph state",
      });
    }
    if (!operationManifestMatchesSchedule(value.operationManifest, value.schedulePreview)) {
      context.addIssue({
        code: "custom",
        path: ["operationManifest"],
        message: "Task operation manifest must belong to the scheduled node",
      });
    }
  });

function operationManifestMatchesSchedule(
  manifest: z.infer<typeof TaskNodeOperationManifestSchema> | null,
  preview: z.infer<typeof TaskSchedulePreviewSchema>,
): boolean {
  if (manifest === null) {
    return true;
  }
  return (
    (preview.state === "dependency_eligible" ||
      preview.state === "awaiting_claim" ||
      preview.state === "busy") &&
    manifest.nodeId === preview.nodeId
  );
}

function schedulePreviewMatchesGraph(
  preview: z.infer<typeof TaskSchedulePreviewSchema>,
  nodes: readonly z.infer<typeof TaskGraphNodeSchema>[],
  topologicalOrder: readonly string[],
): boolean {
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const orderedNodes = topologicalOrder.map((nodeId) => nodesById.get(nodeId));
  if (orderedNodes.some((node) => node === undefined)) {
    return false;
  }
  const ordered = orderedNodes as readonly z.infer<typeof TaskGraphNodeSchema>[];
  const ready = ordered.filter((node) => node.status === "ready");
  const running = ordered.filter((node) => node.status === "running");
  const dependenciesSucceeded = (node: z.infer<typeof TaskGraphNodeSchema>) =>
    node.dependsOnNodeIds.every(
      (dependencyId) => nodesById.get(dependencyId)?.status === "succeeded",
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
    return preview.state === "busy" && preview.nodeId === running[0].nodeId;
  }
  if (ready[0] !== undefined) {
    return preview.state === "awaiting_claim" && preview.nodeId === ready[0].nodeId;
  }
  const candidate = ordered.find(
    (node) => node.status === "pending" && dependenciesSucceeded(node),
  );
  if (candidate !== undefined) {
    return preview.state === "dependency_eligible" && preview.nodeId === candidate.nodeId;
  }
  if (ordered.every((node) => node.status === "succeeded")) {
    return preview.state === "complete";
  }
  const blockerNodeIds = ordered
    .filter((node) => ["blocked", "cancelled", "failed", "interrupted"].includes(node.status))
    .map((node) => node.nodeId);
  return (
    preview.state === "blocked" &&
    blockerNodeIds.length > 0 &&
    blockerNodeIds.length === preview.blockerNodeIds.length &&
    blockerNodeIds.every((nodeId, index) => nodeId === preview.blockerNodeIds[index])
  );
}

const TaskSummarySchema = z
  .object({
    taskId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskVersion: NonNegativeSafeIntegerSchema.min(1),
    title: TaskTitleSchema,
    objective: TaskSourceTextSchema,
    stage: z.enum(TASK_STAGES),
  })
  .strict();

export const TaskCatalogPageParamsSchema = z
  .object({
    projectId: z.string().regex(UUID_PATTERN),
    cursor: z.string().regex(UUID_PATTERN).nullable(),
    limit: z.number().int().min(1).max(MAX_TASK_CATALOG_PAGE_SIZE),
  })
  .strict();

export const TaskCatalogPageResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    tasks: z.array(TaskSummarySchema).max(MAX_TASK_CATALOG_PAGE_SIZE),
    nextCursor: z.string().regex(UUID_PATTERN).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const taskIds = value.tasks.map((task) => task.taskId);
    if (new Set(taskIds).size !== taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Task identifiers must be unique",
      });
    }
    if (value.nextCursor !== null && value.nextCursor !== value.tasks.at(-1)?.taskId) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Task page cursor must identify the final Task",
      });
    }
  });

export const TaskCreateParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    ownershipCommandId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    expectedProjectVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedRoutingBindingVersion: NonNegativeSafeIntegerSchema.min(1),
    title: TaskTitleSchema,
    sourceText: TaskSourceTextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set([value.commandId, value.ownershipCommandId, value.taskId]).size !== 3) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "Task command and entity identifiers must be unique",
      });
    }
  });

export const TaskCreateResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["created", "existing"]),
    taskId: z.string().regex(UUID_PATTERN),
  })
  .strict();

export const TaskDetailParamsSchema = z
  .object({
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
  })
  .strict();

export const TaskDetailResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().regex(UUID_PATTERN),
    ownershipVersion: NonNegativeSafeIntegerSchema.min(1),
    taskId: z.string().regex(UUID_PATTERN),
    taskVersion: NonNegativeSafeIntegerSchema.min(1),
    title: TaskTitleSchema,
    stage: z.enum(TASK_STAGES),
    activeRequirement: TaskRequirementSchema,
    latestPlanRevisionId: z.string().regex(UUID_PATTERN).nullable(),
    candidatePlan: TaskPlanRevisionSchema.nullable(),
    confirmedPlan: TaskPlanRevisionSchema.nullable(),
    activeGraph: TaskGraphRevisionSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const stageHasCandidate =
      value.stage === "candidate_plan" || value.stage === "active_graph_with_candidate";
    const stageRequiresConfirmed =
      value.stage === "confirmed_plan" ||
      value.stage === "active_graph" ||
      value.stage === "active_graph_with_candidate";
    const stageHasGraph =
      value.stage === "active_graph" || value.stage === "active_graph_with_candidate";
    if ((value.candidatePlan !== null) !== stageHasCandidate) {
      context.addIssue({
        code: "custom",
        path: ["candidatePlan"],
        message: "Task stage and candidate plan must agree",
      });
    }
    if (
      (stageRequiresConfirmed && value.confirmedPlan === null) ||
      (value.stage === "requirements_only" && value.confirmedPlan !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedPlan"],
        message: "Task stage and confirmed plan must agree",
      });
    }
    if ((value.activeGraph !== null) !== stageHasGraph) {
      context.addIssue({
        code: "custom",
        path: ["activeGraph"],
        message: "Task stage and active graph must agree",
      });
    }
    if (
      value.candidatePlan !== null &&
      (value.candidatePlan.revisionId !== value.latestPlanRevisionId ||
        value.candidatePlan.basedOnRequirementRevisionId !== value.activeRequirement.revisionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidatePlan"],
        message: "Task candidate plan fences must match current detail",
      });
    }
    if (
      value.confirmedPlan !== null &&
      (value.confirmedPlan.basedOnRequirementRevisionId !== value.activeRequirement.revisionId ||
        (value.candidatePlan === null &&
          value.confirmedPlan.revisionId !== value.latestPlanRevisionId) ||
        value.confirmedPlan.revisionId === value.candidatePlan?.revisionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedPlan"],
        message: "Task confirmed plan fences must match current detail",
      });
    }
    if (value.activeGraph !== null && value.confirmedPlan !== null) {
      const planStepIds = new Set(value.confirmedPlan.steps.map((step) => step.stepId));
      const coveredStepIds = new Set(value.activeGraph.nodes.map((node) => node.sourcePlanStepId));
      if (
        value.activeGraph.basedOnPlanRevisionId !== value.confirmedPlan.revisionId ||
        value.activeGraph.nodes.some((node) => !planStepIds.has(node.sourcePlanStepId)) ||
        coveredStepIds.size !== planStepIds.size ||
        [...planStepIds].some((stepId) => !coveredStepIds.has(stepId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["activeGraph"],
          message: "Task graph fences and Plan step coverage must match the confirmed Plan",
        });
      }
    }
  });

export const TaskCandidatePlanGenerateParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    expectedProjectVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedTaskVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedOwnershipVersion: NonNegativeSafeIntegerSchema.min(1),
    previousRequirementRevisionId: z.string().regex(UUID_PATTERN),
    previousPlanRevisionId: z.string().regex(UUID_PATTERN).nullable(),
    expectedRoutingBindingVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedProfileVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedConfigurationRevisionId: z.string().regex(UUID_PATTERN),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = [
      value.commandId,
      value.projectId,
      value.taskId,
      value.previousRequirementRevisionId,
      value.expectedConfigurationRevisionId,
      ...(value.previousPlanRevisionId === null ? [] : [value.previousPlanRevisionId]),
    ];
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "Task candidate plan identifiers must be unique",
      });
    }
  });

export const TaskCandidatePlanGenerateResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["generated", "existing"]),
    taskId: z.string().regex(UUID_PATTERN),
  })
  .strict();

export const TaskCandidatePlanConfirmParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    expectedTaskVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedOwnershipVersion: NonNegativeSafeIntegerSchema.min(1),
    previousRequirementRevisionId: z.string().regex(UUID_PATTERN),
    candidatePlanRevisionId: z.string().regex(UUID_PATTERN),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set([
        value.commandId,
        value.projectId,
        value.taskId,
        value.previousRequirementRevisionId,
        value.candidatePlanRevisionId,
      ]).size !== 5
    ) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "Task candidate Plan confirmation identifiers must be unique",
      });
    }
  });

export const TaskCandidatePlanConfirmResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["confirmed", "existing"]),
    taskId: z.string().regex(UUID_PATTERN),
  })
  .strict();

export const TaskGraphMaterializeParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    expectedTaskVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedOwnershipVersion: NonNegativeSafeIntegerSchema.min(1),
    previousRequirementRevisionId: z.string().regex(UUID_PATTERN),
    confirmedPlanRevisionId: z.string().regex(UUID_PATTERN),
    previousGraphRevisionId: z.string().regex(UUID_PATTERN).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = [
      value.commandId,
      value.projectId,
      value.taskId,
      value.previousRequirementRevisionId,
      value.confirmedPlanRevisionId,
      ...(value.previousGraphRevisionId === null ? [] : [value.previousGraphRevisionId]),
    ];
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "Task graph materialization identifiers must be unique",
      });
    }
  });

export const TaskGraphMaterializeResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["materialized", "existing"]),
    taskId: z.string().regex(UUID_PATTERN),
  })
  .strict();

export const TaskOperationManifestGenerateParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    nodeId: z.string().regex(UUID_PATTERN),
    expectedProjectVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedTaskVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedOwnershipVersion: NonNegativeSafeIntegerSchema.min(1),
    previousRequirementRevisionId: z.string().regex(UUID_PATTERN),
    confirmedPlanRevisionId: z.string().regex(UUID_PATTERN),
    graphRevisionId: z.string().regex(UUID_PATTERN),
    expectedManifestStateVersion: NonNegativeSafeIntegerSchema,
    previousManifestId: z.string().regex(UUID_PATTERN).nullable(),
    expectedRoutingBindingVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedProfileVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedConfigurationRevisionId: z.string().regex(UUID_PATTERN),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.expectedManifestStateVersion === 0) !== (value.previousManifestId === null)) {
      context.addIssue({
        code: "custom",
        path: ["previousManifestId"],
        message: "The previous manifest must match the expected manifest state version",
      });
    }
    const identifiers = [
      value.commandId,
      value.projectId,
      value.taskId,
      value.nodeId,
      value.previousRequirementRevisionId,
      value.confirmedPlanRevisionId,
      value.graphRevisionId,
      value.expectedConfigurationRevisionId,
      ...(value.previousManifestId === null ? [] : [value.previousManifestId]),
    ];
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "Task operation manifest generation identifiers must be unique",
      });
    }
  });

export const TaskOperationManifestGenerateResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["generated", "existing"]),
    taskId: z.string().regex(UUID_PATTERN),
    nodeId: z.string().regex(UUID_PATTERN),
  })
  .strict();

export const TaskOperationManifestConfirmParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    nodeId: z.string().regex(UUID_PATTERN),
    manifestId: z.string().regex(UUID_PATTERN),
    expectedTaskVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedOwnershipVersion: NonNegativeSafeIntegerSchema.min(1),
    previousRequirementRevisionId: z.string().regex(UUID_PATTERN),
    confirmedPlanRevisionId: z.string().regex(UUID_PATTERN),
    graphRevisionId: z.string().regex(UUID_PATTERN),
    expectedManifestStateVersion: NonNegativeSafeIntegerSchema.min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = [
      value.commandId,
      value.projectId,
      value.taskId,
      value.nodeId,
      value.manifestId,
      value.previousRequirementRevisionId,
      value.confirmedPlanRevisionId,
      value.graphRevisionId,
    ];
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "Task operation manifest confirmation identifiers must be unique",
      });
    }
  });

export const TaskOperationManifestConfirmResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["confirmed", "existing"]),
    taskId: z.string().regex(UUID_PATTERN),
    nodeId: z.string().regex(UUID_PATTERN),
  })
  .strict();

const ExecutionRouteSummarySchema = z
  .object({
    tier: z.enum(["fast", "standard", "deep"]),
    provider: routingIdentifier(MAX_PROVIDER_CHARACTERS),
    model: routingIdentifier(MAX_MODEL_CHARACTERS),
    reasoningEffort: routingIdentifier(MAX_REASONING_EFFORT_CHARACTERS),
  })
  .strict();

const ExecutionPermissionSummarySchema = z
  .object({
    workspaceMode: z.enum(["read_only", "workspace_write"]),
    commandExecution: z.boolean(),
    networkAccess: z.literal(false),
    allowedOperationKinds: z.array(z.enum(TASK_OPERATION_KINDS)).min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowedOperationKinds).size !== value.allowedOperationKinds.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedOperationKinds"],
        message: "Execution permission operation kinds must be unique",
      });
    }
  });

export const TaskExecutionActivateParamsSchema = z
  .object({
    activationId: z.string().regex(UUID_PATTERN),
    decisionId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    nodeId: z.string().regex(UUID_PATTERN),
    manifestId: z.string().regex(UUID_PATTERN),
    expectedProjectVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedTaskVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedOwnershipVersion: NonNegativeSafeIntegerSchema.min(1),
    previousRequirementRevisionId: z.string().regex(UUID_PATTERN),
    confirmedPlanRevisionId: z.string().regex(UUID_PATTERN),
    graphRevisionId: z.string().regex(UUID_PATTERN),
    expectedManifestStateVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedRoutingBindingVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedProfileVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedConfigurationRevisionId: z.string().regex(UUID_PATTERN),
    userConfirmed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = [
      value.activationId,
      value.decisionId,
      value.projectId,
      value.taskId,
      value.nodeId,
      value.manifestId,
      value.previousRequirementRevisionId,
      value.confirmedPlanRevisionId,
      value.graphRevisionId,
      value.expectedConfigurationRevisionId,
    ];
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        path: ["activationId"],
        message: "Task execution activation identifiers must be unique",
      });
    }
  });

export const TaskExecutionActivateResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["activated", "existing", "denied", "existing_denial"]),
    activationId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    nodeId: z.string().regex(UUID_PATTERN),
    operationKinds: z.array(z.enum(TASK_OPERATION_KINDS)).min(1).max(256),
    rejectionReason: z.enum(EXECUTION_ADMISSION_REJECTION_REASONS).nullable(),
    route: ExecutionRouteSummarySchema.nullable(),
    permission: ExecutionPermissionSummarySchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const activated = value.status === "activated" || value.status === "existing";
    const activatedFields =
      value.rejectionReason === null && value.route !== null && value.permission !== null;
    const deniedFields =
      value.rejectionReason !== null && value.route === null && value.permission === null;
    const operationKindsAreUnique =
      new Set(value.operationKinds).size === value.operationKinds.length;
    const permissionMatchesOperations =
      value.permission === null ||
      (value.permission.allowedOperationKinds.length === value.operationKinds.length &&
        value.permission.allowedOperationKinds.every(
          (kind, index) => kind === value.operationKinds[index],
        ));
    if (
      (activated && !activatedFields) ||
      (!activated && !deniedFields) ||
      !operationKindsAreUnique ||
      !permissionMatchesOperations
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Task execution activation result fields do not match its status",
      });
    }
  });

export const TaskRequirementReviseParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    taskId: z.string().regex(UUID_PATTERN),
    expectedTaskVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedOwnershipVersion: NonNegativeSafeIntegerSchema.min(1),
    previousRequirementRevisionId: z.string().regex(UUID_PATTERN),
    sourceText: TaskSourceTextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.commandId === value.taskId ||
      value.commandId === value.previousRequirementRevisionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "Task revision identifiers must be unique",
      });
    }
  });

export const TaskRequirementReviseResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["revised", "existing"]),
    taskId: z.string().regex(UUID_PATTERN),
  })
  .strict();

export type HarnessTaskStage = (typeof TASK_STAGES)[number];
export type HarnessTaskSummary = Readonly<{
  taskId: string;
  projectId: string;
  taskVersion: number;
  title: string;
  objective: string;
  stage: HarnessTaskStage;
}>;
export type HarnessTaskCatalogPageParams = Readonly<{
  projectId: string;
  cursor: string | null;
  limit: number;
}>;
export type HarnessTaskCatalogPageResult = Readonly<{
  schemaVersion: 1;
  tasks: readonly HarnessTaskSummary[];
  nextCursor: string | null;
}>;
export type HarnessTaskCreateParams = Readonly<{
  commandId: string;
  ownershipCommandId: string;
  taskId: string;
  projectId: string;
  expectedProjectVersion: number;
  expectedRoutingBindingVersion: number;
  title: string;
  sourceText: string;
}>;
export type HarnessTaskCreateResult = Readonly<{
  schemaVersion: 1;
  status: "created" | "existing";
  taskId: string;
}>;
export type HarnessTaskRequirement = Readonly<{
  revisionId: string;
  revisionNumber: number;
  sourceText: string;
  objective: string;
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}>;
export type HarnessTaskPlanStep = Readonly<{
  stepId: string;
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
}>;
export type HarnessTaskPlanRevision = Readonly<{
  revisionId: string;
  revisionNumber: number;
  basedOnRequirementRevisionId: string;
  steps: readonly HarnessTaskPlanStep[];
}>;
export type HarnessTaskCandidatePlan = HarnessTaskPlanRevision;
export type HarnessTaskConfirmedPlan = HarnessTaskPlanRevision;
export type HarnessTaskNodeStatus = (typeof TASK_NODE_STATUSES)[number];
export type HarnessTaskGraphNode = Readonly<{
  nodeId: string;
  sourcePlanStepId: string;
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  dependsOnNodeIds: readonly string[];
  status: HarnessTaskNodeStatus;
}>;
export type HarnessTaskSchedulePreview =
  | Readonly<{ state: "dependency_eligible"; nodeId: string }>
  | Readonly<{ state: "awaiting_claim"; nodeId: string }>
  | Readonly<{ state: "busy"; nodeId: string }>
  | Readonly<{ state: "blocked"; blockerNodeIds: readonly string[] }>
  | Readonly<{ state: "complete" }>;
export type HarnessTaskOperationKind = (typeof TASK_OPERATION_KINDS)[number];
export type HarnessTaskNodeOperation = Readonly<{
  operationId: string;
  kind: HarnessTaskOperationKind;
}>;
export type HarnessTaskNodeOperationManifest = Readonly<{
  manifestId: string;
  nodeId: string;
  stateVersion: number;
  status: "candidate" | "confirmed";
  operations: readonly HarnessTaskNodeOperation[];
}>;
export type HarnessTaskGraphRevision = Readonly<{
  revisionId: string;
  revisionNumber: number;
  basedOnPlanRevisionId: string;
  nodes: readonly HarnessTaskGraphNode[];
  operationManifest: HarnessTaskNodeOperationManifest | null;
  schedulePreview: HarnessTaskSchedulePreview;
  topologicalOrder: readonly string[];
}>;
export type HarnessTaskDetailParams = Readonly<{
  projectId: string;
  taskId: string;
}>;
export type HarnessTaskDetailResult = Readonly<{
  schemaVersion: 1;
  projectId: string;
  ownershipVersion: number;
  taskId: string;
  taskVersion: number;
  title: string;
  stage: HarnessTaskStage;
  activeRequirement: HarnessTaskRequirement;
  latestPlanRevisionId: string | null;
  candidatePlan: HarnessTaskCandidatePlan | null;
  confirmedPlan: HarnessTaskConfirmedPlan | null;
  activeGraph: HarnessTaskGraphRevision | null;
}>;
export type HarnessTaskCandidatePlanGenerateParams = Readonly<{
  commandId: string;
  projectId: string;
  taskId: string;
  expectedProjectVersion: number;
  expectedTaskVersion: number;
  expectedOwnershipVersion: number;
  previousRequirementRevisionId: string;
  previousPlanRevisionId: string | null;
  expectedRoutingBindingVersion: number;
  expectedProfileVersion: number;
  expectedConfigurationRevisionId: string;
}>;
export type HarnessTaskCandidatePlanGenerateResult = Readonly<{
  schemaVersion: 1;
  status: "generated" | "existing";
  taskId: string;
}>;
export type HarnessTaskCandidatePlanConfirmParams = Readonly<{
  commandId: string;
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  expectedOwnershipVersion: number;
  previousRequirementRevisionId: string;
  candidatePlanRevisionId: string;
}>;
export type HarnessTaskCandidatePlanConfirmResult = Readonly<{
  schemaVersion: 1;
  status: "confirmed" | "existing";
  taskId: string;
}>;
export type HarnessTaskGraphMaterializeParams = Readonly<{
  commandId: string;
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  expectedOwnershipVersion: number;
  previousRequirementRevisionId: string;
  confirmedPlanRevisionId: string;
  previousGraphRevisionId: string | null;
}>;
export type HarnessTaskGraphMaterializeResult = Readonly<{
  schemaVersion: 1;
  status: "materialized" | "existing";
  taskId: string;
}>;
export type HarnessTaskOperationManifestGenerateParams = Readonly<{
  commandId: string;
  projectId: string;
  taskId: string;
  nodeId: string;
  expectedProjectVersion: number;
  expectedTaskVersion: number;
  expectedOwnershipVersion: number;
  previousRequirementRevisionId: string;
  confirmedPlanRevisionId: string;
  graphRevisionId: string;
  expectedManifestStateVersion: number;
  previousManifestId: string | null;
  expectedRoutingBindingVersion: number;
  expectedProfileVersion: number;
  expectedConfigurationRevisionId: string;
}>;
export type HarnessTaskOperationManifestGenerateResult = Readonly<{
  schemaVersion: 1;
  status: "generated" | "existing";
  taskId: string;
  nodeId: string;
}>;
export type HarnessTaskOperationManifestConfirmParams = Readonly<{
  commandId: string;
  projectId: string;
  taskId: string;
  nodeId: string;
  manifestId: string;
  expectedTaskVersion: number;
  expectedOwnershipVersion: number;
  previousRequirementRevisionId: string;
  confirmedPlanRevisionId: string;
  graphRevisionId: string;
  expectedManifestStateVersion: number;
}>;
export type HarnessTaskOperationManifestConfirmResult = Readonly<{
  schemaVersion: 1;
  status: "confirmed" | "existing";
  taskId: string;
  nodeId: string;
}>;
export type HarnessExecutionAdmissionRejectionReason =
  (typeof EXECUTION_ADMISSION_REJECTION_REASONS)[number];
export type HarnessTaskExecutionActivateParams = z.infer<typeof TaskExecutionActivateParamsSchema>;
export type HarnessTaskExecutionActivateResult = z.infer<typeof TaskExecutionActivateResultSchema>;
export type HarnessTaskRequirementReviseParams = Readonly<{
  commandId: string;
  projectId: string;
  taskId: string;
  expectedTaskVersion: number;
  expectedOwnershipVersion: number;
  previousRequirementRevisionId: string;
  sourceText: string;
}>;
export type HarnessTaskRequirementReviseResult = Readonly<{
  schemaVersion: 1;
  status: "revised" | "existing";
  taskId: string;
}>;

const ProjectRoutingBindingRecordSchema = z
  .object({
    projectId: z.string().regex(UUID_PATTERN),
    bindingVersion: NonNegativeSafeIntegerSchema.min(1),
    profileId: z.string().regex(UUID_PATTERN),
    profileVersionAtBinding: NonNegativeSafeIntegerSchema.min(1),
    configurationRevisionIdAtBinding: z.string().regex(UUID_PATTERN),
  })
  .strict();

const ProjectRoutingBindingStatusSchema = z.union([
  z
    .object({
      projectId: z.string().regex(UUID_PATTERN),
      status: z.literal("unbound"),
      binding: z.null(),
    })
    .strict(),
  z
    .object({
      projectId: z.string().regex(UUID_PATTERN),
      status: z.literal("default_bound"),
      binding: ProjectRoutingBindingRecordSchema,
    })
    .strict(),
  z
    .object({
      projectId: z.string().regex(UUID_PATTERN),
      status: z.literal("other_profile_bound"),
      binding: ProjectRoutingBindingRecordSchema,
    })
    .strict(),
]);

export const ProjectRoutingBindingStatusBatchParamsSchema = z
  .object({
    projectIds: z.array(z.string().regex(UUID_PATTERN)).max(MAX_PROJECT_ROUTING_BINDING_BATCH_SIZE),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.projectIds).size !== value.projectIds.length) {
      context.addIssue({
        code: "custom",
        path: ["projectIds"],
        message: "Project identifiers must be unique",
      });
    }
  });

export const ProjectRoutingBindingStatusBatchResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    statuses: z
      .array(ProjectRoutingBindingStatusSchema)
      .max(MAX_PROJECT_ROUTING_BINDING_BATCH_SIZE),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.statuses.map((status) => status.projectId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["statuses"],
        message: "Project binding statuses must be unique",
      });
    }
    value.statuses.forEach((status, index) => {
      if (status.binding !== null && status.binding.projectId !== status.projectId) {
        context.addIssue({
          code: "custom",
          path: ["statuses", index, "binding", "projectId"],
          message: "Project binding must match its status",
        });
      }
    });
  });

export const ProjectRoutingBindingBindDefaultParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    projectId: z.string().regex(UUID_PATTERN),
    expectedBindingVersion: NonNegativeSafeIntegerSchema,
    previousProfileId: z.string().regex(UUID_PATTERN).nullable(),
    expectedProfileVersion: NonNegativeSafeIntegerSchema.min(1),
    expectedConfigurationRevisionId: z.string().regex(UUID_PATTERN),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.expectedBindingVersion === 0) !== (value.previousProfileId === null)) {
      context.addIssue({
        code: "custom",
        path: ["previousProfileId"],
        message: "The previous profile must match the expected binding version",
      });
    }
    if (value.commandId === value.expectedConfigurationRevisionId) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "A binding command cannot reuse a configuration revision identifier",
      });
    }
  });

export const ProjectRoutingBindingBindDefaultResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["bound", "existing"]),
    binding: ProjectRoutingBindingRecordSchema,
  })
  .strict();

export type HarnessProjectRoutingBindingRecord = Readonly<{
  projectId: string;
  bindingVersion: number;
  profileId: string;
  profileVersionAtBinding: number;
  configurationRevisionIdAtBinding: string;
}>;
export type HarnessProjectRoutingBindingStatus =
  | Readonly<{ projectId: string; status: "unbound"; binding: null }>
  | Readonly<{
      projectId: string;
      status: "default_bound" | "other_profile_bound";
      binding: HarnessProjectRoutingBindingRecord;
    }>;
export type HarnessProjectRoutingBindingStatusBatchParams = Readonly<{
  projectIds: readonly string[];
}>;
export type HarnessProjectRoutingBindingStatusBatchResult = Readonly<{
  schemaVersion: 1;
  statuses: readonly HarnessProjectRoutingBindingStatus[];
}>;
export type HarnessProjectRoutingBindingBindDefaultParams = Readonly<{
  commandId: string;
  projectId: string;
  expectedBindingVersion: number;
  previousProfileId: string | null;
  expectedProfileVersion: number;
  expectedConfigurationRevisionId: string;
}>;
export type HarnessProjectRoutingBindingBindDefaultResult = Readonly<{
  schemaVersion: 1;
  status: "bound" | "existing";
  binding: HarnessProjectRoutingBindingRecord;
}>;

export const ROUTING_AVAILABILITY_STATUSES = Object.freeze([
  "model_unavailable",
  "observed_available",
  "provider_unobserved",
  "reasoning_effort_unsupported",
] as const);

const RoutingTierTargetSchema = z
  .object({
    provider: routingIdentifier(MAX_PROVIDER_CHARACTERS),
    model: routingIdentifier(MAX_MODEL_CHARACTERS),
    reasoningEffort: routingIdentifier(MAX_REASONING_EFFORT_CHARACTERS),
  })
  .strict();

const RoutingTierTargetsSchema = z
  .object({
    fast: RoutingTierTargetSchema,
    standard: RoutingTierTargetSchema,
    deep: RoutingTierTargetSchema,
  })
  .strict();

const RoutingAvailabilitySchema = z
  .object({
    fast: z.enum(ROUTING_AVAILABILITY_STATUSES),
    standard: z.enum(ROUTING_AVAILABILITY_STATUSES),
    deep: z.enum(ROUTING_AVAILABILITY_STATUSES),
  })
  .strict();

export const RoutingConfigurationGetParamsSchema = z.object({}).strict();

export const RoutingConfigurationSetParamsSchema = z
  .object({
    commandId: z.string().regex(UUID_PATTERN),
    expectedProfileVersion: NonNegativeSafeIntegerSchema,
    previousConfigurationRevisionId: z.string().regex(UUID_PATTERN).nullable(),
    tiers: RoutingTierTargetsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.expectedProfileVersion === 0) !== (value.previousConfigurationRevisionId === null)) {
      context.addIssue({
        code: "custom",
        path: ["previousConfigurationRevisionId"],
        message: "The previous revision must match the expected profile version",
      });
    }
    if (value.commandId === value.previousConfigurationRevisionId) {
      context.addIssue({
        code: "custom",
        path: ["commandId"],
        message: "A command cannot reuse the previous revision identifier",
      });
    }
  });

export const RoutingConfigurationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    configured: z.boolean(),
    profileVersion: NonNegativeSafeIntegerSchema,
    configurationRevisionId: z.string().regex(UUID_PATTERN).nullable(),
    tiers: RoutingTierTargetsSchema.nullable(),
    availability: RoutingAvailabilitySchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const configuredShape =
      value.profileVersion >= 1 &&
      value.configurationRevisionId !== null &&
      value.tiers !== null &&
      value.availability !== null;
    const unconfiguredShape =
      value.profileVersion === 0 &&
      value.configurationRevisionId === null &&
      value.tiers === null &&
      value.availability === null;
    if ((value.configured && !configuredShape) || (!value.configured && !unconfiguredShape)) {
      context.addIssue({
        code: "custom",
        path: ["configured"],
        message: "Configured routing state fields are inconsistent",
      });
    }
  });

export type HarnessRoutingAvailabilityStatus = (typeof ROUTING_AVAILABILITY_STATUSES)[number];
export type HarnessRoutingTierTarget = Readonly<{
  provider: string;
  model: string;
  reasoningEffort: string;
}>;
export type HarnessRoutingTierTargets = Readonly<{
  fast: HarnessRoutingTierTarget;
  standard: HarnessRoutingTierTarget;
  deep: HarnessRoutingTierTarget;
}>;
export type HarnessRoutingConfigurationSetParams = Readonly<{
  commandId: string;
  expectedProfileVersion: number;
  previousConfigurationRevisionId: string | null;
  tiers: HarnessRoutingTierTargets;
}>;
export type HarnessRoutingConfigurationResult = Readonly<{
  schemaVersion: 1;
  configured: boolean;
  profileVersion: number;
  configurationRevisionId: string | null;
  tiers: HarnessRoutingTierTargets | null;
  availability: Readonly<
    Record<"fast" | "standard" | "deep", HarnessRoutingAvailabilityStatus>
  > | null;
}>;

export const EVENT_CONTRACTS = Object.freeze({
  "account.status_changed": AccountStatusResultSchema,
});

export type RpcEventMethodName = keyof typeof EVENT_CONTRACTS;

export const METHOD_CONTRACTS = Object.freeze({
  "account.status": Object.freeze({
    params: AccountStatusParamsSchema,
    result: AccountStatusResultSchema,
  }),
  "model.catalog_page": Object.freeze({
    params: ModelCatalogPageParamsSchema,
    result: ModelCatalogPageResultSchema,
  }),
  "project.catalog_page": Object.freeze({
    params: ProjectCatalogPageParamsSchema,
    result: ProjectCatalogPageResultSchema,
  }),
  "project.register": Object.freeze({
    params: ProjectRegisterParamsSchema,
    result: ProjectRegisterResultSchema,
  }),
  "project.routing_binding.bind_default": Object.freeze({
    params: ProjectRoutingBindingBindDefaultParamsSchema,
    result: ProjectRoutingBindingBindDefaultResultSchema,
  }),
  "project.routing_binding.status_batch": Object.freeze({
    params: ProjectRoutingBindingStatusBatchParamsSchema,
    result: ProjectRoutingBindingStatusBatchResultSchema,
  }),
  "routing.configuration.get": Object.freeze({
    params: RoutingConfigurationGetParamsSchema,
    result: RoutingConfigurationResultSchema,
  }),
  "routing.configuration.set": Object.freeze({
    params: RoutingConfigurationSetParamsSchema,
    result: RoutingConfigurationResultSchema,
  }),
  "task.catalog_page": Object.freeze({
    params: TaskCatalogPageParamsSchema,
    result: TaskCatalogPageResultSchema,
  }),
  "task.create": Object.freeze({
    params: TaskCreateParamsSchema,
    result: TaskCreateResultSchema,
  }),
  "task.detail": Object.freeze({
    params: TaskDetailParamsSchema,
    result: TaskDetailResultSchema,
  }),
  "task.plan.generate_candidate": Object.freeze({
    params: TaskCandidatePlanGenerateParamsSchema,
    result: TaskCandidatePlanGenerateResultSchema,
  }),
  "task.plan.confirm_candidate": Object.freeze({
    params: TaskCandidatePlanConfirmParamsSchema,
    result: TaskCandidatePlanConfirmResultSchema,
  }),
  "task.graph.materialize": Object.freeze({
    params: TaskGraphMaterializeParamsSchema,
    result: TaskGraphMaterializeResultSchema,
  }),
  "task.operation_manifest.generate_candidate": Object.freeze({
    params: TaskOperationManifestGenerateParamsSchema,
    result: TaskOperationManifestGenerateResultSchema,
  }),
  "task.operation_manifest.confirm_candidate": Object.freeze({
    params: TaskOperationManifestConfirmParamsSchema,
    result: TaskOperationManifestConfirmResultSchema,
  }),
  "task.execution.activate": Object.freeze({
    params: TaskExecutionActivateParamsSchema,
    result: TaskExecutionActivateResultSchema,
  }),
  "task.requirement.revise": Object.freeze({
    params: TaskRequirementReviseParamsSchema,
    result: TaskRequirementReviseResultSchema,
  }),
  "system.health": Object.freeze({
    params: SystemHealthParamsSchema,
    result: SystemHealthResultSchema,
  }),
  "system.shutdown": Object.freeze({
    params: SystemShutdownParamsSchema,
    result: SystemShutdownResultSchema,
  }),
});

export type RpcMethodName = keyof typeof METHOD_CONTRACTS;

function routingIdentifier(maxCharacters: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maxCharacters)
    .refine(
      (value) => value.trim() === value && !containsControlCharacter(value),
      "Routing identifiers cannot contain surrounding whitespace or control characters",
    );
}

function containsControlCharacter(input: string): boolean {
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

function isNormalizedProjectPath(platform: HarnessProjectPlatform, input: string): boolean {
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

function hasMethod(method: string): method is RpcMethodName {
  return Object.prototype.hasOwnProperty.call(METHOD_CONTRACTS, method);
}

function hasEvent(method: string): method is RpcEventMethodName {
  return Object.prototype.hasOwnProperty.call(EVENT_CONTRACTS, method);
}

function decodeMethodValue(
  method: string,
  input: unknown,
  side: "params" | "result",
): ProtocolResult<JsonValue> {
  if (!hasMethod(method)) {
    return protocolFailure("unknown_method");
  }
  if (!validateJsonValue(input).ok) {
    return protocolFailure(side === "params" ? "invalid_params" : "invalid_result");
  }

  const parsed = METHOD_CONTRACTS[method][side].safeParse(input);
  if (!parsed.success) {
    return protocolFailure(side === "params" ? "invalid_params" : "invalid_result");
  }

  return protocolSuccess(parsed.data as JsonValue);
}

export function decodeRequestParams(method: string, params: unknown): ProtocolResult<JsonValue> {
  return decodeMethodValue(method, params, "params");
}

export function decodeResponseResult(method: string, result: unknown): ProtocolResult<JsonValue> {
  return decodeMethodValue(method, result, "result");
}

export function decodeEventParams(method: string, params: unknown): ProtocolResult<JsonValue> {
  if (!hasEvent(method)) {
    return protocolFailure("unknown_event");
  }
  if (!validateJsonValue(params).ok) {
    return protocolFailure("invalid_event");
  }

  const parsed = EVENT_CONTRACTS[method].safeParse(params);
  return parsed.success
    ? protocolSuccess(Object.freeze(parsed.data) as JsonValue)
    : protocolFailure("invalid_event");
}
