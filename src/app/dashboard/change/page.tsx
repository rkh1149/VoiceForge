import Link from "next/link";
import { desc, eq, isNotNull, and } from "drizzle-orm";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function ChangeAppPage() {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;

  const db = getDb();
  // Only apps that have been built at least once can be changed.
  const changeable = await db
    .select()
    .from(apps)
    .where(and(eq(apps.ownerId, user.id), isNotNull(apps.githubRepoUrl)))
    .orderBy(desc(apps.updatedAt));

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold text-forge-900">Change an app</h1>
      <p className="mt-1 text-sm text-slate-500">
        Pick an app, then tell VoiceForge what you&rsquo;d like changed.
        You&rsquo;ll see a plan and a preview before anything goes live.
      </p>

      {changeable.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <p className="text-3xl">🛠️</p>
          <p className="mt-3 text-sm text-slate-500">
            You don&rsquo;t have any built apps yet.{" "}
            <Link
              href="/dashboard/create"
              className="font-medium text-forge-600 hover:underline"
            >
              Create your first app
            </Link>{" "}
            and it will show up here.
          </p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {changeable.map((app) => (
            <li key={app.id}>
              <Link
                href={`/dashboard/change/${app.id}`}
                className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-forge-500 hover:shadow"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-slate-900">{app.name}</p>
                    {app.description && (
                      <p className="mt-0.5 line-clamp-1 text-sm text-slate-500">
                        {app.description}
                      </p>
                    )}
                  </div>
                  <span className="text-forge-600">→</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
