import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", ["admin", "user"]);

export const appStatus = pgEnum("app_status", [
  "draft", // idea captured, spec not approved
  "spec_approved", // user approved the build plan
  "building",
  "testing",
  "deployed",
  "failed",
  "archived",
]);

export const conversationChannel = pgEnum("conversation_channel", [
  "text",
  "voice",
]);

export const approvalType = pgEnum("approval_type", [
  "build", // approve building a new app
  "change", // approve a change to an existing app
  "deploy_production", // approve promoting preview to production
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
]);

export const buildRunStatus = pgEnum("build_run_status", [
  "queued",
  "generating",
  "testing",
  "debugging",
  "deploying",
  "awaiting_user_test",
  "complete",
  "failed",
  "needs_input",
]);

export const deploymentEnvironment = pgEnum("deployment_environment", [
  "preview",
  "production",
]);

export const deploymentStatus = pgEnum("deployment_status", [
  "queued",
  "building",
  "ready",
  "error",
  "canceled",
]);

export const testSuite = pgEnum("test_suite", [
  "typecheck",
  "lint",
  "unit",
  "component",
  "e2e",
  "accessibility",
  "security",
  "build",
  "smoke",
]);

export const testStatus = pgEnum("test_status", [
  "passed",
  "failed",
  "skipped",
]);

export const changeRequestStatus = pgEnum("change_request_status", [
  "intake",
  "clarifying",
  "awaiting_approval",
  "building",
  "complete",
  "rejected",
  "failed",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Auth accounts. Identity comes from Clerk; this row adds app-level data. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("user"),
    monthlyBuildLimit: integer("monthly_build_limit").notNull().default(10),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_clerk_user_id_idx").on(t.clerkUserId)],
);

/** Generated apps: one row per app a user has created (or is creating). */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: appStatus("status").notNull().default("draft"),
    githubRepoUrl: text("github_repo_url"),
    vercelProjectId: text("vercel_project_id"),
    previewUrl: text("preview_url"),
    productionUrl: text("production_url"),
    // AI-enabled generated apps (Stage 7)
    aiToken: text("ai_token"), // secret the app uses to report/gate AI usage
    aiDailyRequestLimit: integer("ai_daily_request_limit").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("apps_owner_slug_idx").on(t.ownerId, t.slug),
    index("apps_owner_idx").on(t.ownerId),
  ],
);

/** Voice/text transcript for each app creation or change session. */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").references(() => apps.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    channel: conversationChannel("channel").notNull().default("text"),
    transcript: jsonb("transcript").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("conversations_app_idx").on(t.appId)],
);

/** Versioned structured app specs produced by the Product Spec agent. */
export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer("version").notNull().default(1),
    spec: jsonb("spec").notNull(), // structured requirements
    plainSummary: text("plain_summary"), // plain-English build summary shown to user
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("requirements_app_version_idx").on(t.appId, t.version)],
);

/** What the user approved, and when. Nothing builds without one. */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    requirementId: uuid("requirement_id").references(() => requirements.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: approvalType("type").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("approvals_app_idx").on(t.appId)],
);

/** Code generation jobs: durable state machine for the build pipeline. */
export const buildRuns = pgTable(
  "build_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    requirementId: uuid("requirement_id").references(() => requirements.id),
    approvalId: uuid("approval_id").references(() => approvals.id),
    status: buildRunStatus("status").notNull().default("queued"),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    logs: jsonb("logs").notNull().default([]),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("build_runs_app_idx").on(t.appId),
    index("build_runs_status_idx").on(t.status),
  ],
);

/** Preview/production deployments and their URLs. */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    buildRunId: uuid("build_run_id").references(() => buildRuns.id),
    environment: deploymentEnvironment("environment").notNull(),
    vercelDeploymentId: text("vercel_deployment_id"),
    url: text("url"),
    status: deploymentStatus("status").notNull().default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("deployments_app_idx").on(t.appId)],
);

/** Results of every test suite run inside a build. */
export const testResults = pgTable(
  "test_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    buildRunId: uuid("build_run_id")
      .notNull()
      .references(() => buildRuns.id),
    suite: testSuite("suite").notNull(),
    status: testStatus("status").notNull(),
    summary: text("summary"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("test_results_build_run_idx").on(t.buildRunId)],
);

/** "Change my recipe app to add printing" — future modifications by app. */
export const changeRequests = pgTable(
  "change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    description: text("description").notNull(),
    status: changeRequestStatus("status").notNull().default("intake"),
    requirementId: uuid("requirement_id").references(() => requirements.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("change_requests_app_idx").on(t.appId)],
);

/** One row per AI request made by a generated app (gate + usage report). */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_usage_app_created_idx").on(t.appId, t.createdAt)],
);

/** Every tool call, credential use, repo change, and deployment. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id),
    appId: uuid("app_id").references(() => apps.id),
    buildRunId: uuid("build_run_id").references(() => buildRuns.id),
    action: text("action").notNull(), // e.g. "createGitHubRepo", "user.signIn"
    payload: jsonb("payload"), // sanitized arguments / results — never secrets
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_user_idx").on(t.userId),
    index("audit_logs_app_idx").on(t.appId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type App = typeof apps.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Requirement = typeof requirements.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type BuildRun = typeof buildRuns.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type ChangeRequest = typeof changeRequests.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
