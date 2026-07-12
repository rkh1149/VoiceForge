"use client";

import { useState } from "react";

export default function AiModelSyncButton() {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<
    Array<{ app: string; action: string }> | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    if (busy) return;
    if (
      !confirm(
        "Push the current AI models to every AI-enabled app and redeploy the published ones?",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ai-model-sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      setResults(data.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        onClick={sync}
        disabled={busy}
        className="rounded-xl border border-forge-600 px-4 py-2 text-sm font-medium text-forge-700 transition hover:bg-forge-50 disabled:opacity-50"
      >
        {busy ? "Updating apps…" : "Sync AI model to all AI-enabled apps"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {results && (
        <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
          {results.map((r, i) => (
            <li key={i}>
              <span className="font-medium text-slate-700">{r.app}</span>:{" "}
              {r.action}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
