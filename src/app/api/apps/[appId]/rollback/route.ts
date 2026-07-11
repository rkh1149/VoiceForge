import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apps, deployments } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { restoreDeployment } from "@/lib/vercel";

const bodySchema = z.object({
  deploymentId: z.string().uuid(), // VoiceForge deployments.id
});

/** Roll production back to an earlier deployment (no rebuild). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { appId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!z.string().uuid().safeParse(appId).success || !parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const db = getDb();
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.ownerId, user.id)))
    .limit(1);
  if (!app?.vercelProjectId) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const [dep] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.id, parsed.data.deploymentId),
        eq(deployments.appId, appId),
        eq(deployments.environment, "production"),
        eq(deployments.status, "ready"),
      ),
    )
    .limit(1);
  if (!dep?.vercelDeploymentId) {
    return NextResponse.json(
      { error: "That version can't be restored." },
      { status: 404 },
    );
  }

  try {
    await restoreDeployment({
      projectId: app.vercelProjectId,
      deploymentId: dep.vercelDeploymentId,
      userId: user.id,
      appId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Rollback failed for app ${appId}:`, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  await audit({
    userId: user.id,
    appId,
    action: "app.rolledBack",
    payload: { toDeployment: dep.vercelDeploymentId, createdAt: dep.createdAt },
  });

  return NextResponse.json({ ok: true });
}
