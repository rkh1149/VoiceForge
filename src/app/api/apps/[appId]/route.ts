import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  apps,
  approvals,
  auditLogs,
  buildRuns,
  changeRequests,
  conversations,
  deployments,
  requirements,
  testResults,
} from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { deleteRepo } from "@/lib/github";
import { deleteProject } from "@/lib/vercel";

/**
 * Delete an app everywhere: Vercel project, GitHub repo, and VoiceForge
 * records. Audit logs and conversation transcripts are kept as history
 * (their app reference is cleared). External deletions are best-effort:
 * failures are reported as warnings, VoiceForge records go regardless.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { appId } = await params;
  if (!z.string().uuid().safeParse(appId).success) {
    return NextResponse.json({ error: "Invalid app id" }, { status: 400 });
  }

  const db = getDb();
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.ownerId, user.id)))
    .limit(1);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  // Refuse while a build is running.
  const active = await db
    .select({ id: buildRuns.id })
    .from(buildRuns)
    .where(
      and(
        eq(buildRuns.appId, appId),
        inArray(buildRuns.status, [
          "queued",
          "generating",
          "testing",
          "debugging",
          "deploying",
        ]),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    return NextResponse.json(
      { error: "A build is running for this app — wait for it to finish." },
      { status: 409 },
    );
  }

  const repoName = `voiceforge-${app.slug}`;
  const warnings: string[] = [];

  // 1. Vercel project (removes its deployments and URLs).
  try {
    await deleteProject(repoName);
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }

  // 2. GitHub repo.
  try {
    await deleteRepo(repoName);
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }

  // 3. VoiceForge records (order respects foreign keys).
  const runs = await db
    .select({ id: buildRuns.id })
    .from(buildRuns)
    .where(eq(buildRuns.appId, appId));
  const runIds = runs.map((r) => r.id);

  if (runIds.length > 0) {
    await db
      .delete(testResults)
      .where(inArray(testResults.buildRunId, runIds));
    await db
      .update(auditLogs)
      .set({ buildRunId: null })
      .where(inArray(auditLogs.buildRunId, runIds));
  }
  await db.delete(deployments).where(eq(deployments.appId, appId));
  await db.delete(buildRuns).where(eq(buildRuns.appId, appId));
  await db.delete(changeRequests).where(eq(changeRequests.appId, appId));
  await db.delete(approvals).where(eq(approvals.appId, appId));
  await db.delete(requirements).where(eq(requirements.appId, appId));
  // Keep transcripts and audit history; clear their app reference.
  await db
    .update(conversations)
    .set({ appId: null })
    .where(eq(conversations.appId, appId));
  await db
    .update(auditLogs)
    .set({ appId: null })
    .where(eq(auditLogs.appId, appId));
  await db.delete(apps).where(eq(apps.id, appId));

  await audit({
    userId: user.id,
    action: "app.deleted",
    payload: {
      appName: app.name,
      slug: app.slug,
      repo: repoName,
      warnings,
    },
  });

  return NextResponse.json({ ok: true, warnings });
}
