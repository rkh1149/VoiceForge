import { z } from "zod";

/**
 * The structured app specification produced by the planning conversation.
 * Stored as `requirements.spec` (jsonb) and versioned per app.
 *
 * Note: every field is required (no .optional()) because the OpenAI
 * structured-outputs format requires strict JSON schemas. Use empty
 * arrays / empty strings for "none".
 */
export const appSpecSchema = z.object({
  appName: z
    .string()
    .describe("Short friendly app name, e.g. 'Family Recipe Keeper'"),
  purpose: z.string().describe("One or two sentences: what the app is for"),
  targetUsers: z
    .string()
    .describe("Who will use it, e.g. 'Richard's family, about 6 people'"),
  screens: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
      }),
    )
    .describe("Main screens/pages of the app"),
  features: z
    .array(z.string())
    .describe("Main things users can do, in plain language"),
  dataToStore: z
    .array(z.string())
    .describe("What information the app saves, e.g. 'recipes with photos'"),
  needsLogin: z
    .boolean()
    .describe("Whether users must sign in to use the app"),
  sharingModel: z
    .enum(["private", "shared", "public"])
    .describe(
      "private: each user sees only their own data; shared: all invited users share data; public: anyone can view",
    ),
  aiFeatures: z
    .array(z.string())
    .describe("AI-powered features, if any (empty array if none)"),
  testPlan: z
    .array(z.string())
    .describe("Plain-language list of things to test before release"),
  deploymentNotes: z
    .string()
    .describe("Anything special about hosting/devices, or empty string"),
});

export type AppSpec = z.infer<typeof appSpecSchema>;

/** Change proposals carry the full UPDATED spec plus a summary of the change. */
export const changeProposalSchema = appSpecSchema.extend({
  changeSummary: z
    .string()
    .describe(
      "Plain-language summary of what is changing versus the current app, e.g. 'Add a print button to each recipe'",
    ),
});

export type ChangeProposal = z.infer<typeof changeProposalSchema>;
