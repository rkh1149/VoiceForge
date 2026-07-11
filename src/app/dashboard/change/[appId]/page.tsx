import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import PlannerChat from "@/components/PlannerChat";

export const dynamic = "force-dynamic";

export default async function ChangeAppChatPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;

  const { appId } = await params;
  const db = getDb();
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.ownerId, user.id)))
    .limit(1);
  if (!app || !app.githubRepoUrl) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-forge-900">
        Change {app.name}
      </h1>
      <p className="mt-1 mb-6 text-sm text-slate-500">
        Describe what you&rsquo;d like different. VoiceForge will confirm the
        change, then rebuild and give you a preview before anything goes live.
      </p>
      <PlannerChat appId={app.id} appName={app.name} />
    </div>
  );
}
