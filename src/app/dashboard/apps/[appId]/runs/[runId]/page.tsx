import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps, buildRuns, testResults } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";

export const dynamic = "force-dynamic";

type LogEntry = { ts: string; message: string };

const statusLabel: Record<string, string> = {
  complete: "Completed",
  awaiting_user_test: "Waiting for testing",
  failed: "Failed",
};

/** Historical view of one specific build run (read-only, no polling). */
export default async function BuildRunPage({
  params,
}: {
  params: Promise<{ appId: string; runId: string }>;
}) {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;

  const { appId, runId } = await params;
  const db = getDb();

  const [app] = await db
    .select()
    .from(apps)
    .where(
      user.role === "admin"
        ? eq(apps.id, appId)
        : and(eq(apps.id, appId), eq(apps.ownerId, user.id)),
    )
    .limit(1);
  if (!app) notFound();

  const [run] = await db
    .select()
    .from(buildRuns)
    .where(and(eq(buildRuns.id, runId), eq(buildRuns.appId, appId)))
    .limit(1);
  if (!run) notFound();

  const results = await db
    .select()
    .from(testResults)
    .where(eq(testResults.buildRunId, run.id))
    .orderBy(testResults.createdAt);

  const logs = (run.logs ?? []) as LogEntry[];
  const lastFailed = [...results].reverse().find((r) => r.status === "failed");
  const failedOutput =
    run.status === "failed"
      ? ((lastFailed?.details as { output?: string } | null)?.output ?? null)
      : null;

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href={`/dashboard/apps/${app.id}`}
        className="text-sm text-forge-600 hover:underline"
      >
        ← Back to {app.name}
      </Link>
      <h1 className="mt-2 text-2xl font-bold text-forge-900">
        Build from{" "}
        {run.createdAt.toLocaleString("en-CA", {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        {statusLabel[run.status] ?? run.status}
        {run.branch ? ` · branch ${run.branch}` : ""}
        {run.commitSha ? ` · commit ${run.commitSha.slice(0, 7)}` : ""}
      </p>

      {run.errorMessage && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {run.errorMessage}
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Checks</h3>
          <ul className="mt-2 space-y-1">
            {results.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-sm">
                <span>{t.status === "passed" ? "✅" : "❌"}</span>
                <span className="text-slate-600">{t.summary ?? t.suite}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {failedOutput && (
        <details className="mt-4 rounded-2xl border border-red-200 bg-white p-5 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-red-700">
            Show the failing check&rsquo;s output
          </summary>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-600">
            {failedOutput}
          </pre>
        </details>
      )}

      {logs.length > 0 && (
        <div className="mt-4 mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Build log</h3>
          <div className="mt-2 max-h-[32rem] space-y-1 overflow-y-auto font-mono text-xs text-slate-500">
            {logs.map((l, i) => (
              <p key={i}>
                <span className="text-slate-300">
                  {new Date(l.ts).toISOString().slice(11, 19)}{" "}
                </span>
                {l.message}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
