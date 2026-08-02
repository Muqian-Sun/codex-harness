import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(256);
const PathSchema = z.string().min(1).max(16_384);
const OptionalNullableStringSchema = z.string().max(4096).nullable().optional();
const ApprovalPolicySchema = z.enum(["untrusted", "on-request", "never"]);
const ApprovalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);

export const InitializeParamsSchema = z
  .object({
    clientInfo: z
      .object({
        name: z.string().min(1).max(128),
        title: z.string().min(1).max(256).nullable(),
        version: z.string().min(1).max(64),
      })
      .strict(),
    capabilities: z
      .object({
        experimentalApi: z.literal(false),
        requestAttestation: z.literal(false),
      })
      .strict(),
  })
  .strict();

export const InitializeResponseSchema = z
  .object({
    userAgent: z.string().min(1).max(1024),
    codexHome: PathSchema,
    platformFamily: z.string().min(1).max(128),
    platformOs: z.string().min(1).max(128),
  })
  .passthrough();

const ModelSelectionSchema = {
  model: OptionalNullableStringSchema,
  modelProvider: OptionalNullableStringSchema,
  serviceTier: OptionalNullableStringSchema,
};

const ThreadPolicySchema = {
  cwd: PathSchema.nullable().optional(),
  approvalPolicy: ApprovalPolicySchema.nullable().optional(),
  approvalsReviewer: ApprovalsReviewerSchema.nullable().optional(),
  sandbox: z.enum(["read-only", "workspace-write"]).nullable().optional(),
};

export const ModelListParamsSchema = z
  .object({
    cursor: z.string().max(4096).nullable().optional(),
    limit: z.number().int().min(1).max(1000).nullable().optional(),
    includeHidden: z.boolean().nullable().optional(),
  })
  .strict();

export const AccountReadParamsSchema = z.object({ refreshToken: z.literal(false) }).strict();

export const AccountPlanTypeSchema = z.enum([
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

const AccountProjectionSchema = z.union([
  z
    .object({ type: z.literal("apiKey") })
    .passthrough()
    .transform(() => Object.freeze({ type: "apiKey" as const })),
  z
    .object({
      type: z.literal("chatgpt"),
      email: z.string().max(4096).nullable(),
      planType: AccountPlanTypeSchema,
    })
    .passthrough()
    .transform((value) => Object.freeze({ type: value.type, planType: value.planType })),
  z
    .object({
      type: z.literal("amazonBedrock"),
      usesCodexManagedCredentials: z.boolean().optional(),
    })
    .passthrough()
    .transform(() => Object.freeze({ type: "amazonBedrock" as const })),
]);

export const AccountReadResponseSchema = z
  .object({
    account: AccountProjectionSchema.nullable().optional(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough()
  .transform((value) =>
    Object.freeze({
      account: value.account ?? null,
      requiresOpenaiAuth: value.requiresOpenaiAuth,
    }),
  );

export const ThreadStartParamsSchema = z
  .object({
    ...ModelSelectionSchema,
    ...ThreadPolicySchema,
    ephemeral: z.boolean().nullable().optional(),
  })
  .strict();

export const ThreadResumeParamsSchema = z
  .object({
    threadId: IdentifierSchema,
    ...ModelSelectionSchema,
    ...ThreadPolicySchema,
  })
  .strict();

export const ThreadForkParamsSchema = z
  .object({
    threadId: IdentifierSchema,
    lastTurnId: IdentifierSchema.nullable().optional(),
    ...ModelSelectionSchema,
    ...ThreadPolicySchema,
    ephemeral: z.boolean().optional(),
  })
  .strict();

export const ThreadReadParamsSchema = z
  .object({
    threadId: IdentifierSchema,
    includeTurns: z.boolean().optional(),
  })
  .strict();

export const ThreadListParamsSchema = z
  .object({
    cursor: z.string().max(4096).nullable().optional(),
    limit: z.number().int().min(1).max(1000).nullable().optional(),
    sortKey: z.enum(["created_at", "updated_at", "recency_at"]).nullable().optional(),
    sortDirection: z.enum(["asc", "desc"]).nullable().optional(),
    modelProviders: z.array(z.string().min(1).max(256)).max(128).nullable().optional(),
    archived: z.boolean().nullable().optional(),
    isPinned: z.boolean().nullable().optional(),
    cwd: z
      .union([PathSchema, z.array(PathSchema).max(128)])
      .nullable()
      .optional(),
    useStateDbOnly: z.boolean().optional(),
    searchTerm: z.string().max(4096).nullable().optional(),
  })
  .strict();

export const ThreadCompactStartParamsSchema = z.object({ threadId: IdentifierSchema }).strict();

const UserInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(1_000_000),
      text_elements: z.array(z.never()),
    })
    .strict(),
  z.object({ type: z.literal("image"), url: z.string().min(1).max(1_000_000) }).strict(),
  z.object({ type: z.literal("localImage"), path: PathSchema }).strict(),
  z.object({ type: z.literal("audio"), url: z.string().min(1).max(1_000_000) }).strict(),
  z.object({ type: z.literal("localAudio"), path: PathSchema }).strict(),
  z.object({ type: z.literal("skill"), name: IdentifierSchema, path: PathSchema }).strict(),
  z.object({ type: z.literal("mention"), name: IdentifierSchema, path: PathSchema }).strict(),
]);

const SandboxPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("readOnly"), networkAccess: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(PathSchema).max(128),
      networkAccess: z.boolean(),
      excludeTmpdirEnvVar: z.boolean(),
      excludeSlashTmp: z.boolean(),
    })
    .strict(),
]);

export const TurnStartParamsSchema = z
  .object({
    threadId: IdentifierSchema,
    clientUserMessageId: IdentifierSchema.nullable().optional(),
    input: z.array(UserInputSchema).min(1).max(128),
    cwd: PathSchema.nullable().optional(),
    approvalPolicy: ApprovalPolicySchema.nullable().optional(),
    approvalsReviewer: ApprovalsReviewerSchema.nullable().optional(),
    sandboxPolicy: SandboxPolicySchema.nullable().optional(),
    model: z.string().min(1).max(4096).nullable().optional(),
    serviceTier: z.string().max(4096).nullable().optional(),
    effort: z.string().min(1).max(128).nullable().optional(),
    summary: z.enum(["auto", "concise", "detailed", "none"]).nullable().optional(),
  })
  .strict();

export const TurnSteerParamsSchema = z
  .object({
    threadId: IdentifierSchema,
    clientUserMessageId: IdentifierSchema.nullable().optional(),
    input: z.array(UserInputSchema).min(1).max(128),
    expectedTurnId: IdentifierSchema,
  })
  .strict();

export const TurnInterruptParamsSchema = z
  .object({ threadId: IdentifierSchema, turnId: IdentifierSchema })
  .strict();

const ThreadProjectionSchema = z.object({ id: IdentifierSchema }).passthrough();
const TurnProjectionSchema = z.object({ id: IdentifierSchema }).passthrough();

export const ModelListResponseSchema = z
  .object({
    data: z.array(z.object({ id: IdentifierSchema, model: IdentifierSchema }).passthrough()),
    nextCursor: z.string().nullable(),
  })
  .passthrough();

export const ThreadResponseSchema = z.object({ thread: ThreadProjectionSchema }).passthrough();
export const ThreadListResponseSchema = z
  .object({
    data: z.array(ThreadProjectionSchema),
    nextCursor: z.string().nullable(),
    backwardsCursor: z.string().nullable(),
  })
  .passthrough();
export const EmptyResponseSchema = z.object({}).strict();
export const TurnStartResponseSchema = z.object({ turn: TurnProjectionSchema }).passthrough();
export const TurnSteerResponseSchema = z.object({ turnId: IdentifierSchema }).passthrough();
