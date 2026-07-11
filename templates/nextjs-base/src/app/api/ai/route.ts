import { NextResponse } from "next/server";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * The single AI endpoint for this generated app. The OpenAI key exists only
 * as a server env var set by VoiceForge at deploy time; the model is pinned;
 * every request is gated against a per-app daily limit and its token usage
 * is reported back to VoiceForge for the owner's dashboard.
 */

const MAX_PROMPT_CHARS = 4000;
const MAX_SYSTEM_CHARS = 1000;
const MAX_OUTPUT_TOKENS = 1000;

type AiRequestBody = { prompt?: unknown; system?: unknown };
type GateResponse = { allowed?: boolean; reason?: string; usageId?: string };
type ResponsesUsage = { input_tokens?: number; output_tokens?: number };
type ResponsesContent = { type?: string; text?: string };
type ResponsesOutputItem = { content?: ResponsesContent[] };
type ResponsesBody = {
  output_text?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
};

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI is not enabled for this app." },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => null)) as AiRequestBody | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const system =
    typeof body?.system === "string"
      ? body.system.slice(0, MAX_SYSTEM_CHARS)
      : undefined;
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { error: `Prompt must be 1–${MAX_PROMPT_CHARS} characters.` },
      { status: 400 },
    );
  }

  // Daily-limit gate (fail-closed: if VoiceForge can't be reached, deny —
  // cost safety beats availability for a family app).
  const gateBase = process.env.VOICEFORGE_PUBLIC_URL;
  const gateToken = process.env.VOICEFORGE_APP_TOKEN;
  let usageId: string | null = null;
  if (gateBase && gateToken) {
    let gate: GateResponse | null = null;
    try {
      const res = await fetch(`${gateBase}/api/ai-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: gateToken, phase: "gate" }),
      });
      gate = (await res.json()) as GateResponse;
    } catch {
      gate = null;
    }
    if (!gate?.allowed) {
      return NextResponse.json(
        {
          error:
            gate?.reason ??
            "The AI helper is unavailable right now. Please try again later.",
        },
        { status: 429 },
      );
    }
    usageId = gate.usageId ?? null;
  }

  const model = process.env.AI_MODEL ?? "gpt-5.4-mini";
  const aiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      instructions: system,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
  });
  const data = (await aiRes.json().catch(() => ({}))) as ResponsesBody;
  if (!aiRes.ok) {
    return NextResponse.json(
      { error: "The AI helper hit a problem. Please try again." },
      { status: 502 },
    );
  }

  const text =
    data.output_text ??
    (data.output ?? [])
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");

  // Report token usage (fire-and-forget; failures don't affect the user).
  if (gateBase && gateToken && usageId) {
    void fetch(`${gateBase}/api/ai-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: gateToken,
        phase: "report",
        usageId,
        model,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      }),
    }).catch(() => {});
  }

  return NextResponse.json({ text });
}
