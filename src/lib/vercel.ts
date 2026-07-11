import { audit } from "@/lib/audit";

/**
 * Vercel tool layer (Stage 3).
 * Talks to the Vercel REST API with a bearer token (server-side only).
 * One Vercel project per generated app, linked to its GitHub repo.
 */

const API = "https://api.vercel.com";

function authHeaders(): Record<string, string> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set (see .env.example).");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function teamQuery(): string {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

async function vercelFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

type VercelProject = { id: string; name: string };

/** Create (or fetch) the Vercel project for an app, linked to its repo. */
export async function ensureProject(opts: {
  name: string; // e.g. voiceforge-tic-tac-buddy
  githubRepo: string; // owner/name
  userId?: string;
  appId?: string;
}): Promise<VercelProject> {
  // Existing?
  const existing = await vercelFetch<VercelProject>(
    `/v9/projects/${encodeURIComponent(opts.name)}${teamQuery()}`,
  );
  if (existing.ok) return existing.data;

  const created = await vercelFetch<VercelProject & { error?: { message?: string } }>(
    `/v11/projects${teamQuery()}`,
    {
      method: "POST",
      body: JSON.stringify({
        name: opts.name,
        framework: "nextjs",
        gitRepository: { type: "github", repo: opts.githubRepo },
      }),
    },
  );
  if (!created.ok) {
    throw new Error(
      `Vercel project creation failed (${created.status}): ${created.data.error?.message ?? "unknown error"}`,
    );
  }

  // Make preview links shareable with family (no Vercel login wall).
  // Non-fatal if the API rejects it.
  await vercelFetch(`/v9/projects/${created.data.id}${teamQuery()}`, {
    method: "PATCH",
    body: JSON.stringify({ ssoProtection: null }),
  });

  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "vercel.projectCreated",
    payload: { projectId: created.data.id, name: opts.name },
  });

  return created.data;
}

/** Upsert environment variables on a project (production + preview). */
export async function setProjectEnvVars(opts: {
  projectId: string;
  vars: Record<string, string>;
  userId?: string;
  appId?: string;
}): Promise<void> {
  const payload = Object.entries(opts.vars).map(([key, value]) => ({
    key,
    value,
    type: "encrypted",
    target: ["production", "preview"],
  }));
  const res = await fetch(
    `${API}/v10/projects/${opts.projectId}/env?upsert=true${teamQuery() ? "&" + teamQuery().slice(1) : ""}`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(
      `Setting project env vars failed (${res.status}): ${data.error?.message ?? "unknown error"}`,
    );
  }
  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "vercel.envVarsSet",
    payload: { projectId: opts.projectId, keys: Object.keys(opts.vars) }, // keys only — never values
  });
}

/** Delete a project (404 counts as already gone). */
export async function deleteProject(name: string): Promise<void> {
  const res = await fetch(
    `${API}/v9/projects/${encodeURIComponent(name)}${teamQuery()}`,
    { method: "DELETE", headers: authHeaders() },
  );
  if (!res.ok && res.status !== 404) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(
      `Vercel project deletion failed (${res.status}): ${data.error?.message ?? "unknown error"}`,
    );
  }
}

export type DeploymentInfo = {
  id: string;
  url: string; // hostname without protocol
  readyState: string; // QUEUED | BUILDING | READY | ERROR | CANCELED
};

/** Create a deployment from a git branch (preview) or main (production). */
export async function createDeployment(opts: {
  projectName: string;
  githubRepoId: number;
  ref: string; // branch name
  production: boolean;
  userId?: string;
  appId?: string;
}): Promise<DeploymentInfo> {
  const res = await vercelFetch<
    DeploymentInfo & { error?: { message?: string } }
  >(`/v13/deployments${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify({
      name: opts.projectName,
      project: opts.projectName,
      target: opts.production ? "production" : undefined,
      gitSource: {
        type: "github",
        repoId: opts.githubRepoId,
        ref: opts.ref,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Vercel deployment failed (${res.status}): ${res.data.error?.message ?? "unknown error"}`,
    );
  }

  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "vercel.deploymentCreated",
    payload: {
      deploymentId: res.data.id,
      target: opts.production ? "production" : "preview",
      ref: opts.ref,
    },
  });

  return res.data;
}

/** Which deployment does production currently point at? (null if unknown)
 * After an instant rollback the truth lives in lastRollbackTarget, not
 * targets.production (which keeps reporting the newest deployment). */
export async function getCurrentProductionDeploymentId(
  projectId: string,
): Promise<string | null> {
  const res = await vercelFetch<{
    targets?: { production?: { id?: string } };
    lastRollbackTarget?: { deploymentId?: string } | null;
  }>(`/v9/projects/${projectId}${teamQuery()}`);
  if (!res.ok) return null;
  return (
    res.data.lastRollbackTarget?.deploymentId ??
    res.data.targets?.production?.id ??
    null
  );
}

/** One-shot deployment status check (null on fetch failure). */
export async function getDeployment(
  deploymentId: string,
): Promise<(DeploymentInfo & { alias?: string[] }) | null> {
  const res = await vercelFetch<DeploymentInfo & { alias?: string[] }>(
    `/v13/deployments/${deploymentId}${teamQuery()}`,
  );
  return res.ok ? res.data : null;
}

/** Point production traffic at an existing deployment (no rebuild).
 * Tries Vercel's Instant Rollback endpoint first (works in both
 * directions, including back to the newest deployment); falls back to
 * promote for cases rollback doesn't accept. */
export async function restoreDeployment(opts: {
  projectId: string;
  deploymentId: string;
  userId?: string;
  appId?: string;
}): Promise<void> {
  const attempts: string[] = [];

  for (const path of [
    `/v1/projects/${opts.projectId}/rollback/${opts.deploymentId}`,
    `/v10/projects/${opts.projectId}/promote/${opts.deploymentId}`,
  ]) {
    const res = await fetch(`${API}${path}${teamQuery()}`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (res.ok) {
      await audit({
        userId: opts.userId,
        appId: opts.appId,
        action: "vercel.deploymentRestored",
        payload: { deploymentId: opts.deploymentId, via: path.split("/")[3] },
      });
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    attempts.push(`${res.status}: ${data.error?.message ?? "unknown error"}`);
  }

  throw new Error(`Restore failed (${attempts.join(" / ")})`);
}

/** Simple smoke test: the deployed URL responds with an HTML page. */
export async function smokeTest(
  url: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`https://${url}`, {
      redirect: "follow",
      headers: { "User-Agent": "VoiceForge-smoke-test" },
    });
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        detail: `HTTP ${res.status} from ${url} — Vercel Deployment Protection is likely enabled for this project. Disable it in Vercel: project Settings → Deployment Protection → Vercel Authentication → Disabled.`,
      };
    }
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status} from ${url}` };
    }
    if (!body.toLowerCase().includes("<html")) {
      return { ok: false, detail: `No HTML content from ${url}` };
    }
    return { ok: true, detail: `HTTP 200, HTML page served (${body.length} bytes)` };
  } catch (err) {
    return {
      ok: false,
      detail: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
