# VoiceForge

A voice-controlled app builder for family and friends. Describe an app in plain language; VoiceForge plans it with you, builds it, tests it, and deploys it.

Current progress: **Stage 7a — AI-enabled generated apps.** When a plan includes AI features, the generated app gets a locked `/api/ai` server route (agents cannot touch it or create other API routes). At deploy time VoiceForge sets that app's own Vercel env vars: your OpenAI key (server-side only), a pinned cheap model (`OPENAI_GENAPP_MODEL`, default gpt-5.4-mini), and a per-app secret token. Every AI request is gated against a per-app daily limit (`apps.ai_daily_request_limit`, default 50/day, fail-closed) via VoiceForge's `/api/ai-usage` endpoint, and token usage is reported back — the Admin page shows cumulative AI usage by app. Requires `VOICEFORGE_PUBLIC_URL` in env and a `npm run db:push` (new `ai_usage` table + app columns).

Stage 6 recap — operations and safety: per-user monthly build quotas (`users.monthly_build_limit`, default 10; admins exempt), an **Admin** page for the owner (stats, all apps, recent builds, audit log), **rollback** of any app to an earlier published version (Vercel promote, no rebuild), app deletion across VoiceForge/GitHub/Vercel, stale-build reaping, and **cloud builds**: on the hosted VoiceForge, generated apps are tested inside Vercel Sandbox microVMs instead of a local process. Deployment waits are finalized by status polling rather than blocking, so serverless function time stays low. Note: hosted builds must fit your Vercel plan's function limit (300s on Hobby — long builds with debug rounds may need Vercel Pro's 800s, or run builds locally with `npm run dev`, which remains the default path).

Stage 5 recap — you can plan apps and changes **by voice**: the browser talks to OpenAI Realtime over WebRTC using a short-lived key minted by the backend (the real API key never reaches the browser), the assistant asks clarifying questions out loud, transcripts are saved, and the proposed plan lands in the same approval → build → preview → publish pipeline as text. Voice costs roughly $0.05–0.15 per planning conversation; sessions auto-stop at 10 minutes.

Stage 4 recap — the full loop works for both new apps and changes. Create: describe an idea → approve the plan → pipeline generates, tests, previews → you Publish → live URL. Change: pick a built app on the Change page, describe the change → approve → the Change Agent modifies the app's *current* code (fetched from GitHub, preserving saved user data) → full re-test → new preview → Publish. Every spec is versioned in `requirements`; every change is tracked in `change_requests`; production always requires your explicit approval.

## How builds work (Stage 2)

Generated apps start from a locked template (`templates/nextjs-base`): the AI can only write `.ts`/`.tsx` files under `src/`, never `package.json`, configs, or global styles — so dependencies are pinned and installs run with scripts disabled. Generated apps are client-side only for now (localStorage persistence). Every pipeline step is recorded in `build_runs`, `test_results`, and `audit_logs`. Requires `GITHUB_TOKEN` + `GITHUB_OWNER` in `.env.local` (see `.env.example` for exact token permissions). A typical build costs roughly $0.10–0.50 in OpenAI tokens with the default `gpt-5.4` coder model.

## How the planning conversation works

The Create page runs a planning agent (OpenAI Agents SDK). It asks non-technical questions, suggests an app name, then records a structured spec via a `propose_spec` tool call. That writes three database rows: the `apps` entry, a versioned `requirements` spec, and a **pending `approvals` row** — nothing will ever build without you pressing Approve. Set `OPENAI_API_KEY` in `.env.local`; the model is `OPENAI_PLANNER_MODEL` (default `gpt-5.4-mini`, roughly a cent or two per planning conversation).

## Stack

Next.js 15 (App Router, TypeScript), Tailwind CSS 4, Clerk (auth), Neon Postgres + Drizzle ORM, hosted on Vercel.

## Local setup

Prerequisite: Node.js 20.9+ (`node --version`). Install from https://nodejs.org if needed.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run db:push              # creates all tables in Neon
npm run dev                  # open http://localhost:3000
```

### 1. Clerk (sign-in)

1. Create an application at https://dashboard.clerk.com — name it "VoiceForge".
2. Sign-in method: enable **Email** with **Email verification link** (magic link). Disable everything else for simplicity.
3. Go to **Configure → Restrictions** and set sign-up mode to **Restricted** — this makes VoiceForge invite-only. Invite family/friends from the Clerk dashboard (**Users → Invite**).
4. Copy the **Publishable key** and **Secret key** from **API Keys** into `.env.local`.

### 2. Neon (database)

1. Create a free project at https://console.neon.tech (or in Vercel: **Storage → Create Database → Neon**).
2. Copy the pooled connection string into `DATABASE_URL` in `.env.local`.
3. Run `npm run db:push` to create the tables.

### 3. Admin role

Set `ADMIN_EMAILS` in `.env.local` to your email. Whoever signs in with a listed email becomes an admin.

## Verify

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm run build       # production build
```

## Deploy to Vercel

1. Push this folder to a GitHub repo (e.g. `richardhoyne/voiceforge`).
2. In Vercel: **Add New → Project**, import the repo. Defaults are fine.
3. Add the same environment variables from `.env.local` in **Project → Settings → Environment Variables** (use your Clerk *production* keys once you add a domain; test keys work for previews).
4. Deploy. Pushes to `main` go to production; other branches get preview URLs.

## Database schema

Ten tables mirror the spec: `users`, `apps`, `conversations`, `requirements` (versioned specs), `approvals`, `build_runs` (durable job states), `deployments`, `test_results`, `change_requests`, `audit_logs`. See `src/db/schema.ts`.

## Security notes

- No OpenAI/GitHub/Vercel keys ever reach the browser — server-side only (later stages).
- Sign-up is restricted (invite-only) via Clerk.
- `/dashboard` and `/api` routes require sign-in (see `src/middleware.ts`).
- Every sensitive action in later stages writes to `audit_logs` (`src/lib/audit.ts`).
