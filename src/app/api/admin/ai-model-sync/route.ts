import { NextResponse } from "next/server";
import { isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { createRepoIfMissing } from "@/lib/github";
import { setProjectEnvVars, createDeployment } from "@/lib/vercel";

export const maxDuration = 300;

/**
 * Admin-only: push the CURRENT AI model env vars to every AI-enabled
 * generated app's Vercel project, and redeploy published apps so the
 * change takes effect (env vars only apply to new deployments).
 */
export async function POST() {
  const user = await getOrCreateCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const textModel = process.env.OPENAI_GENAPP_MODEL ?? "gpt-5.6-terra";
  const imageModel = process.env.OPENAI_GENAPP_IMAGE_MODEL ?? "gpt-image-1";

  const db = getDb();
  const aiApps = await db
    .select()
    .from(apps)
    .where(isNotNull(apps.aiToken));

  const results: Array<{ app: string; action: string }> = [];

  for (const app of aiApps) {
    try {
      if (!app.vercelProjectId) {
        results.push({ app: app.name, action: "skipped (no Vercel project)" });
        continue;
      }
      await setProjectEnvVars({
        projectId: app.vercelProjectId,
        vars: { AI_MODEL: textModel, AI_IMAGE_MODEL: imageModel },
        userId: user.id,
        appId: app.id,
      });

      if (app.productionUrl) {
        // Redeploy current production code so the new env vars apply.
        const repo = await createRepoIfMissing({
          name: `voiceforge-${app.slug}`,
          description: app.description ?? app.name,
          userId: user.id,
          appId: app.id,
        });
        await createDeployment({
          projectName: `voiceforge-${app.slug}`,
          githubRepoId: repo.repoId,
          ref: repo.defaultBranch,
          production: true,
          userId: user.id,
          appId: app.id,
        });
        results.push({ app: app.name, action: `updated + redeploying (${textModel})` });
      } else {
        results.push({ app: app.name, action: `updated (${textModel}); applies on next deploy` });
      }
    } catch (err) {
      results.push({
        app: app.name,
        action: `FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  await audit({
    userId: user.id,
    action: "admin.aiModelSync",
    payload: { textModel, imageModel, results },
  });

  return NextResponse.json({ textModel, imageModel, results });
}
