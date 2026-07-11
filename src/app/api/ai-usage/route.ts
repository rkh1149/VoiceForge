import { NextResponse } from "next/server";
import { and, count, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { aiUsage, apps } from "@/db/schema";

/**
 * Server-to-server endpoint called by GENERATED APPS (not browsers, not
 * Clerk users): authenticates via the per-app secret token minted at
 * deploy time. "gate" enforces the app's daily AI request limit and
 * reserves a usage row; "report" fills in the token counts afterwards.
 * Exempted from Clerk middleware.
 */

const bodySchema = z.object({
  token: z.string().min(20).max(200),
  phase: z.enum(["gate", "report"]),
  usageId: z.string().uuid().nullish(),
  model: z.string().max(80).nullish(),
  inputTokens: z.number().int().min(0).max(10_000_000).nullish(),
  outputTokens: z.number().int().min(0).max(10_000_000).nullish(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { token, phase, usageId, model, inputTokens, outputTokens } =
    parsed.data;

  const db = getDb();
  const [app] = await db
    .select({
      id: apps.id,
      limit: apps.aiDailyRequestLimit,
      status: apps.status,
    })
    .from(apps)
    .where(eq(apps.aiToken, token))
    .limit(1);
  if (!app) {
    return NextResponse.json({ error: "Unknown app" }, { status: 401 });
  }

  if (phase === "gate") {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [row] = await db
      .select({ used: count() })
      .from(aiUsage)
      .where(
        and(eq(aiUsage.appId, app.id), gte(aiUsage.createdAt, dayStart)),
      );
    const used = row?.used ?? 0;
    if (used >= app.limit) {
      return NextResponse.json({
        allowed: false,
        reason: `This app has reached its daily AI limit (${app.limit} requests). It resets at midnight UTC.`,
      });
    }
    const [inserted] = await db
      .insert(aiUsage)
      .values({ appId: app.id })
      .returning({ id: aiUsage.id });
    return NextResponse.json({
      allowed: true,
      usageId: inserted.id,
      remainingToday: app.limit - used - 1,
    });
  }

  // phase === "report"
  if (!usageId) {
    return NextResponse.json({ error: "usageId required" }, { status: 400 });
  }
  await db
    .update(aiUsage)
    .set({
      model: model ?? null,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    })
    .where(and(eq(aiUsage.id, usageId), eq(aiUsage.appId, app.id)));
  return NextResponse.json({ ok: true });
}
