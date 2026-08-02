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

export const MAX_MODEL_CATALOG_PAGE_SIZE = 16;
export const MAX_MODEL_REASONING_EFFORTS = 64;
export const MAX_PROJECT_CATALOG_PAGE_SIZE = 12;

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
  "routing.configuration.get": Object.freeze({
    params: RoutingConfigurationGetParamsSchema,
    result: RoutingConfigurationResultSchema,
  }),
  "routing.configuration.set": Object.freeze({
    params: RoutingConfigurationSetParamsSchema,
    result: RoutingConfigurationResultSchema,
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
