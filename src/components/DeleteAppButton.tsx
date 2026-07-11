"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteAppButton({
  appId,
  appName,
}: {
  appId: string;
  appName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/apps/${appId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not delete the app");
      if (data.warnings?.length) {
        alert(
          `${appName} was removed from VoiceForge, but with warnings:\n\n${data.warnings.join("\n")}`,
        );
      }
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the app");
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 rounded-2xl border border-red-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-red-700">Danger zone</h3>
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="mt-2 rounded-xl border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
        >
          Delete this app…
        </button>
      ) : (
        <div className="mt-2">
          <p className="text-sm text-slate-600">
            This permanently deletes <strong>{appName}</strong> — its live
            website, its code on GitHub, and its history here. This cannot be
            undone.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={doDelete}
              disabled={busy}
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? "Deleting…" : `Yes, delete ${appName}`}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
