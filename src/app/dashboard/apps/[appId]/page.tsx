import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import BuildStatus from "@/components/BuildStatus";
import DeleteAppButton from "@/components/DeleteAppButton";

export const dynamic = "force-dynamic";

export default async function AppDetailPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;

  const { appId } = await params;
  const db = getDb();
  const rows = await db
    .select()
    .from(apps)
    .where(
      user.role === "admin"
        ? eq(apps.id, appId)
        : and(eq(apps.id, appId), eq(apps.ownerId, user.id)),
    )
    .limit(1);
  const app = rows[0];
  if (!app) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-forge-900">{app.name}</h1>
      {app.description && (
        <p className="mt-1 mb-6 text-sm text-slate-500">{app.description}</p>
      )}
      <BuildStatus appId={app.id} />
      {app.ownerId === user.id && (
        <DeleteAppButton appId={app.id} appName={app.name} />
      )}
    </div>
  );
}
