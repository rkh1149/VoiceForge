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

/** Poll a deployment until READY / ERROR / CANCELED (or timeout). */
export async function waitForDeployment(
  deploymentId: string,
  timeoutMs = 8 * 60_000,
): Promise<DeploymentInfo> {
  const started = Date.now();
  for (;;) {
    const res = await vercelFetch<DeploymentInfo>(
      `/v13/deployments/${deploymentId}${teamQuery()}`,
    );
    if (res.ok) {
      const state = res.data.readyState;
      if (state === "READY" || state === "ERROR" || state === "CANCELED") {
        return res.data;
      }
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Deployment timed out after ${timeoutMs / 60000} minutes`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
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
