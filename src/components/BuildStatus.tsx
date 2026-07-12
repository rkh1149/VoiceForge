"use client";

import { useCallback, useEffect, useState } from "react";

type LogEntry = { ts: string; message: string };

type StatusPayload = {
  app: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    githubRepoUrl: string | null;
    previewUrl: string | null;
    productionUrl: string | null;
  };
  buildRun: {
    id: string;
    status: string;
    errorMessage: string | null;
    logs: LogEntry[];
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  testResults: Array<{
    suite: string;
    status: string;
    summary: string | null;
    createdAt: string;
  }>;
  failedOutput: string | null;
};

const ACTIVE_STATUSES = new Set([
  "queued",
  "generating",
  "testing",
  "debugging",
  "deploying",
]);

const runStatusLabels: Record<string, string> = {
  queued: "Waiting to start…",
  generating: "Writing your app's code…",
  testing: "Testing the app…",
  debugging: "Fixing problems found by tests…",
  deploying: "Putting the app online…",
  awaiting_user_test: "Ready for you to try",
  complete: "Build complete",
  failed: "Build failed",
  needs_input: "Needs your input",
};

export default function BuildStatus({ appId }: { appId: string }) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [publishing, setPublishing] = useState(false);

  async function publish() {
    if (publishing) return;
    setPublishing(true);
    try {
      const res = await fetch(`/api/apps/${appId}/publish`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not publish");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not publish");
    } finally {
      setPublishing(false);
    }
  }

  async function rebuild() {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      const res = await fetch(`/api/apps/${appId}/rebuild`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not restart the build");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restart the build");
    } finally {
      setRebuilding(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${appId}/status`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load status");
      setData(json);
      setError(null);
      return json as StatusPayload;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load status");
      return null;
    }
  }, [appId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      const json = await load();
      if (stopped) return;
      const active =
        json?.buildRun && ACTIVE_STATUSES.has(json.buildRun.status);
      timer = setTimeout(tick, active ? 3000 : 15000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-400">
        Loading…
      </div>
    );
  }

  const { buildRun, testResults } = data;
  const isActive = buildRun ? ACTIVE_STATUSES.has(buildRun.status) : false;

  return (
    <div className="space-y-4">
      {/* Current status */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3">
          {isActive && (
            <span className="h-3 w-3 animate-pulse rounded-full bg-amber-500" />
          )}
          {buildRun?.status === "complete" && (
            <span className="h-3 w-3 rounded-full bg-green-500" />
          )}
          {buildRun?.status === "failed" && (
            <span className="h-3 w-3 rounded-full bg-red-500" />
          )}
          <p className="font-semibold text-slate-900">
            {buildRun
              ? (runStatusLabels[buildRun.status] ?? buildRun.status)
              : "No build has run yet."}
          </p>
        </div>
        {buildRun?.status === "failed" && (
          <p className="mt-2 text-sm text-slate-600">
            Something went wrong while building your app — this happens
            sometimes and it&rsquo;s not your fault. Press the button below to
            try again. If it fails a second time, tell Richard which app you
            were making and he&rsquo;ll take a look.
          </p>
        )}
        {buildRun?.errorMessage && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-slate-400">
              Technical details
            </summary>
            <p className="mt-1 text-sm text-red-600">{buildRun.errorMessage}</p>
          </details>
        )}
        {(buildRun?.status === "failed" ||
          buildRun?.status === "awaiting_user_test" ||
          (buildRun?.status === "complete" && !data.app.previewUrl)) && (
          <button
            onClick={rebuild}
            disabled={rebuilding}
            className={
              buildRun?.status === "awaiting_user_test"
                ? "mt-3 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                : "mt-3 rounded-xl bg-forge-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-forge-700 disabled:opacity-50"
            }
          >
            {rebuilding
              ? "Restarting…"
              : buildRun?.status === "failed"
                ? "↻ Try building again"
                : buildRun?.status === "awaiting_user_test"
                  ? "↻ Rebuild from scratch"
                  : "↻ Rebuild & deploy"}
          </button>
        )}
        {data.app.githubRepoUrl && (
          <p className="mt-2 text-sm">
            <a
              href={data.app.githubRepoUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-forge-600 hover:underline"
            >
              View the code on GitHub ↗
            </a>
          </p>
        )}
      </div>

      {/* Live app */}
      {data.app.productionUrl && data.app.status === "deployed" && (
        <div className="rounded-2xl border border-green-200 bg-green-50 p-5 shadow-sm">
          <p className="font-semibold text-green-900">
            🎉 {data.app.name} is live!
          </p>
          <a
            href={data.app.productionUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block rounded-xl bg-green-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-green-700"
          >
            Open your app ↗
          </a>
          <p className="mt-2 text-xs text-green-800">
            Share this link with anyone: {data.app.productionUrl}
          </p>
        </div>
      )}

      {/* Preview + publish */}
      {data.app.previewUrl &&
        buildRun?.status === "awaiting_user_test" && (
          <div className="rounded-2xl border border-forge-100 bg-forge-50 p-5 shadow-sm">
            <p className="font-semibold text-forge-900">
              Your app is ready to try
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Open the preview and test it. If you&rsquo;re happy, publish it
              to get a permanent link you can share. If something&rsquo;s
              wrong, tell VoiceForge what to change.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={data.app.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-forge-600 px-5 py-2 text-sm font-semibold text-forge-700 transition hover:bg-forge-100"
              >
                Try the preview ↗
              </a>
              <button
                onClick={publish}
                disabled={publishing}
                className="rounded-xl bg-forge-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-forge-700 disabled:opacity-50"
              >
                {publishing ? "Publishing…" : "✓ Publish — put it online"}
              </button>
            </div>
          </div>
        )}

      {/* Test results */}
      {testResults.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Checks</h3>
          <ul className="mt-2 space-y-1">
            {testResults.map((t, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span>
                  {t.status === "passed" ? "✅" : t.status === "skipped" ? "⏭️" : "❌"}
                </span>
                <span className="text-slate-600">{t.summary ?? t.suite}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Failing check output (diagnosis) */}
      {data.failedOutput && (
        <details className="rounded-2xl border border-red-200 bg-white p-5 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-red-700">
            Show the failing check&rsquo;s output
          </summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-600">
            {data.failedOutput}
          </pre>
        </details>
      )}

      {/* Build log */}
      {buildRun && buildRun.logs.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Build log</h3>
          <div className="mt-2 max-h-72 space-y-1 overflow-y-auto font-mono text-xs text-slate-500">
            {buildRun.logs.map((l, i) => (
              <p key={i}>
                <span className="text-slate-300">
                  {new Date(l.ts).toLocaleTimeString()}{" "}
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
