import { notFound } from "next/navigation";
import Link from "next/link";
import { and, count, desc, eq, gte, max, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { aiUsage, apps, auditLogs, buildRuns, users } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";

export const dynamic = "force-dynamic";

const statusColors: Record<string, string> = {
  complete: "text-green-600",
  awaiting_user_test: "text-blue-600",
  failed: "text-red-600",
};

export default async function AdminPage() {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;
  if (user.role !== "admin") notFound();

  const db = getDb();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    [{ userCount }],
    [{ appCount }],
    [{ buildsThisMonth }],
    [{ failuresThisMonth }],
    allApps,
    recentRuns,
    recentAudit,
    aiByApp,
  ] = await Promise.all([
    db.select({ userCount: count() }).from(users),
    db.select({ appCount: count() }).from(apps),
    db
      .select({ buildsThisMonth: count() })
      .from(buildRuns)
      .where(gte(buildRuns.createdAt, monthStart)),
    db
      .select({ failuresThisMonth: count() })
      .from(buildRuns)
      .where(
        and(gte(buildRuns.createdAt, monthStart), eq(buildRuns.status, "failed")),
      ),
    db
      .select({
        id: apps.id,
        name: apps.name,
        status: apps.status,
        productionUrl: apps.productionUrl,
        ownerEmail: users.email,
        updatedAt: apps.updatedAt,
      })
      .from(apps)
      .innerJoin(users, eq(apps.ownerId, users.id))
      .orderBy(desc(apps.updatedAt))
      .limit(50),
    db
      .select({
        id: buildRuns.id,
        status: buildRuns.status,
        errorMessage: buildRuns.errorMessage,
        createdAt: buildRuns.createdAt,
        appName: apps.name,
        appId: apps.id,
      })
      .from(buildRuns)
      .innerJoin(apps, eq(buildRuns.appId, apps.id))
      .orderBy(desc(buildRuns.createdAt))
      .limit(20),
    db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(50),
    db
      .select({
        appId: apps.id,
        appName: apps.name,
        ownerEmail: users.email,
        requests: count(),
        inputTokens: sum(aiUsage.inputTokens),
        outputTokens: sum(aiUsage.outputTokens),
        lastUsed: max(aiUsage.createdAt),
      })
      .from(aiUsage)
      .innerJoin(apps, eq(aiUsage.appId, apps.id))
      .innerJoin(users, eq(apps.ownerId, users.id))
      .groupBy(apps.id, apps.name, users.email)
      .orderBy(desc(count())),
  ]);

  const stats = [
    { label: "Users", value: userCount },
    { label: "Apps", value: appCount },
    { label: "Builds this month", value: buildsThisMonth },
    { label: "of which failed", value: failuresThisMonth },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-forge-900">Admin</h1>
      <p className="mt-1 text-sm text-slate-500">
        Everything across all users. Only you can see this page.
      </p>

      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border border-slate-200 bg-white p-4 text-center shadow-sm"
          >
            <p className="text-2xl font-bold text-forge-900">{s.value}</p>
            <p className="mt-1 text-xs text-slate-500">{s.label}</p>
          </div>
        ))}
      </div>

      {/* All apps */}
      <h2 className="mt-8 text-lg font-semibold text-forge-900">All apps</h2>
      <div className="mt-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-xs text-slate-400">
            <tr>
              <th className="px-4 py-2">App</th>
              <th className="px-4 py-2">Owner</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Live</th>
            </tr>
          </thead>
          <tbody>
            {allApps.map((a) => (
              <tr key={a.id} className="border-b border-slate-50">
                <td className="px-4 py-2">
                  <Link
                    href={`/dashboard/apps/${a.id}`}
                    className="font-medium text-forge-700 hover:underline"
                  >
                    {a.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-500">{a.ownerEmail}</td>
                <td className="px-4 py-2 text-slate-500">{a.status}</td>
                <td className="px-4 py-2">
                  {a.productionUrl ? (
                    <a
                      href={a.productionUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-forge-600 hover:underline"
                    >
                      open ↗
                    </a>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI usage by app */}
      <h2 className="mt-8 text-lg font-semibold text-forge-900">
        AI usage by app (cumulative)
      </h2>
      {aiByApp.length === 0 ? (
        <p className="mt-2 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-400">
          No AI-enabled apps have made requests yet.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 text-xs text-slate-400">
              <tr>
                <th className="px-4 py-2">App</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2 text-right">Requests</th>
                <th className="px-4 py-2 text-right">Tokens in</th>
                <th className="px-4 py-2 text-right">Tokens out</th>
                <th className="px-4 py-2">Last used</th>
              </tr>
            </thead>
            <tbody>
              {aiByApp.map((a) => (
                <tr key={a.appId} className="border-b border-slate-50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/dashboard/apps/${a.appId}`}
                      className="font-medium text-forge-700 hover:underline"
                    >
                      {a.appName}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{a.ownerEmail}</td>
                  <td className="px-4 py-2 text-right">{a.requests}</td>
                  <td className="px-4 py-2 text-right">
                    {Number(a.inputTokens ?? 0).toLocaleString("en-CA")}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {Number(a.outputTokens ?? 0).toLocaleString("en-CA")}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400">
                    {a.lastUsed
                      ? new Date(a.lastUsed).toISOString().replace("T", " ").slice(0, 16)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent builds */}
      <h2 className="mt-8 text-lg font-semibold text-forge-900">
        Recent builds
      </h2>
      <div className="mt-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <ul className="space-y-2 text-sm">
          {recentRuns.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3">
              <span>
                <Link
                  href={`/dashboard/apps/${r.appId}`}
                  className="font-medium text-forge-700 hover:underline"
                >
                  {r.appName}
                </Link>
                <span
                  className={`ml-2 ${statusColors[r.status] ?? "text-amber-600"}`}
                >
                  {r.status}
                </span>
                {r.errorMessage && (
                  <span className="ml-2 text-xs text-slate-400">
                    {r.errorMessage.slice(0, 80)}
                  </span>
                )}
              </span>
              <span className="whitespace-nowrap text-xs text-slate-400">
                {r.createdAt.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Audit log */}
      <h2 className="mt-8 text-lg font-semibold text-forge-900">
        Audit log (latest 50)
      </h2>
      <div className="mt-2 mb-8 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <ul className="space-y-1 font-mono text-xs text-slate-500">
          {recentAudit.map((l) => (
            <li key={l.id}>
              <span className="text-slate-300">
                {l.createdAt.toISOString().replace("T", " ").slice(0, 19)}
              </span>{" "}
              <span className="font-semibold text-slate-600">{l.action}</span>{" "}
              {l.payload ? JSON.stringify(l.payload).slice(0, 120) : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
