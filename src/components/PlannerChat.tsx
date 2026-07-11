"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ChatMessage = { role: "user" | "assistant"; content: string };

type Proposal = {
  appId: string;
  appName: string;
  requirementId: string;
  approvalId: string;
  version: number;
};

export default function PlannerChat({
  appId,
  appName,
}: {
  /** When set, this chat plans a CHANGE to an existing app. */
  appId?: string;
  appName?: string;
} = {}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollDown = () =>
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setError(null);
    setBusy(true);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message }]);
    scrollDown();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message, appId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setConversationId(data.conversationId);
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      if (data.proposal) {
        setProposal(data.proposal);
        setDecision(null); // a revised spec resets any earlier decision
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
      scrollDown();
    }
  }

  async function decide(d: "approved" | "rejected") {
    if (!proposal || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/approvals/${proposal.approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: d }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setDecision(d);
      if (d === "approved" && proposal) {
        setTimeout(() => router.push(`/dashboard/apps/${proposal.appId}`), 1500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Messages */}
      <div className="max-h-[55vh] min-h-48 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-400">
            {appId
              ? `Describe the change you want to ${appName ?? "this app"}, e.g. “Add a reset button for the scores.”`
              : "Describe the app you want, e.g. “Build me an app for tracking family recipes.”"}
          </p>
        )}
        <div className="space-y-3">
          {messages.map((m, i) => (
            <div
              key={i}
              className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-sm bg-forge-600 px-4 py-2.5 text-sm text-white"
                    : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2.5 text-sm text-slate-800"
                }
              >
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-400">
                Thinking…
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Approval card */}
      {proposal && decision !== "approved" && (
        <div className="border-t border-slate-200 bg-forge-50 p-4">
          <p className="text-sm font-semibold text-forge-900">
            {appId ? "Change plan ready" : "Build plan ready"}: {proposal.appName}
            {!appId && proposal.version > 1
              ? ` (revision ${proposal.version})`
              : ""}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Read the plan above. Approve it to queue the build, or keep
            chatting to change it.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide("approved")}
              disabled={busy}
              className="rounded-xl bg-green-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-green-700 disabled:opacity-50"
            >
              {appId ? "✓ Approve — make this change" : "✓ Approve — build this app"}
            </button>
            <button
              onClick={() => decide("rejected")}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Not yet
            </button>
          </div>
          {decision === "rejected" && (
            <p className="mt-2 text-xs text-slate-500">
              No problem — tell me what you’d like to change.
            </p>
          )}
        </div>
      )}
      {decision === "approved" && (
        <div className="border-t border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800">
          Approved! VoiceForge is building your app — taking you to the build
          page so you can watch…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Input */}
      <div className="flex gap-2 border-t border-slate-200 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          maxLength={2000}
          placeholder="Type your message…"
          className="max-h-32 flex-1 resize-y rounded-xl border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-forge-500 focus:outline-none"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="rounded-xl bg-forge-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-forge-700 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
