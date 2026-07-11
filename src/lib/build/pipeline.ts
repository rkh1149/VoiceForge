import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  apps,
  buildRuns,
  changeRequests,
  deployments,
  requirements,
  testResults,
} from "@/db/schema";
import type { AppSpec } from "@/lib/spec";
import { audit } from "@/lib/audit";
import {
  runCodeAgent,
  runChangeCodeAgent,
  runDebugAgent,
} from "@/lib/agents/coder";
import {
  createRepoIfMissing,
  createBranch,
  commitFiles,
  getRepoSrcFiles,
} from "@/lib/github";
import {
  ensureProject,
  createDeployment,
  waitForDeployment,
  smokeTest,
} from "@/lib/vercel";
import { loadTemplate, type FileMap } from "./template";
import { runStep, workspaceDir, writeWorkspace, type StepName } from "./runner";

/**
 * Build pipeline (Stage 2): approved spec -> generated code -> local test
 * gauntlet with a bounded debug loop -> GitHub repo with a passing commit.
 * All state lives in the database so the UI can poll it.
 */

const STEP_ORDER: StepName[] = ["install", "typecheck", "lint", "test", "build"];
const MAX_DEBUG_ROUNDS = 5;

const SUITE_FOR_STEP: Record<StepName, "typecheck" | "lint" | "unit" | "build"> =
  {
    install: "build",
    typecheck: "typecheck",
    lint: "lint",
    test: "unit",
    build: "build",
  };

type LogEntry = { ts: string; message: string };

async function log(buildRunId: string, message: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ logs: buildRuns.logs })
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  const logs = (rows[0]?.logs ?? []) as LogEntry[];
  logs.push({ ts: new Date().toISOString(), message });
  await db
    .update(buildRuns)
    .set({ logs })
    .where(eq(buildRuns.id, buildRunId));
  console.log(`[build ${buildRunId.slice(0, 8)}] ${message}`);
}

async function setStatus(
  buildRunId: string,
  status:
    | "generating"
    | "testing"
    | "debugging"
    | "deploying"
    | "awaiting_user_test"
    | "complete"
    | "failed",
  extra: Partial<{
    errorMessage: string;
    commitSha: string;
    branch: string;
    startedAt: Date;
    finishedAt: Date;
  }> = {},
): Promise<void> {
  const db = getDb();
  await db
    .update(buildRuns)
    .set({ status, ...extra })
    .where(eq(buildRuns.id, buildRunId));
}

function srcOnly(files: FileMap): FileMap {
  return Object.fromEntries(
    Object.entries(files).filter(([p]) => p.startsWith("src/")),
  );
}

/**
 * Runs the full pipeline. Call without awaiting from request handlers:
 *   void startBuildPipeline(id).catch(...)
 */
export async function startBuildPipeline(buildRunId: string): Promise<void> {
  const db = getDb();

  // Serverless functions can't run npm or long jobs. Until the pipeline
  // moves to Vercel Sandbox (planned), builds run from the local server.
  if (process.env.VERCEL) {
    await setStatus(buildRunId, "failed", {
      errorMessage:
        "Builds can't run on the hosted VoiceForge yet — ask Richard to run this build from the VoiceForge computer.",
      finishedAt: new Date(),
    });
    return;
  }

  const [run] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!run) throw new Error(`Build run ${buildRunId} not found`);

  const [app] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, run.appId))
    .limit(1);
  if (!app) throw new Error(`App ${run.appId} not found`);

  const [requirement] = run.requirementId
    ? await db
        .select()
        .from(requirements)
        .where(eq(requirements.id, run.requirementId))
        .limit(1)
    : [];
  if (!requirement) throw new Error(`Requirement missing for build ${buildRunId}`);

  const spec = requirement.spec as AppSpec;

  try {
    await setStatus(buildRunId, "generating", { startedAt: new Date() });
    await db
      .update(apps)
      .set({ status: "building", updatedAt: new Date() })
      .where(eq(apps.id, app.id));
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "build.started",
      payload: { requirementVersion: requirement.version },
    });

    // Change mode: the app was built before, so modify its current code.
    const changeMode = Boolean(app.githubRepoUrl && requirement.version > 1);
    const [changeRequest] = changeMode
      ? await db
          .select()
          .from(changeRequests)
          .where(eq(changeRequests.requirementId, requirement.id))
          .limit(1)
      : [];

    // 1. Assemble files: locked (always-fresh) template + app code.
    await log(buildRunId, "Loading app template…");
    const files = await loadTemplate({
      slug: app.slug,
      name: app.name,
      purpose: spec.purpose,
    });

    let generated;
    if (changeMode) {
      await log(buildRunId, "Fetching the app's current code from GitHub…");
      const repoName = `voiceforge-${app.slug}`;
      const repo = await createRepoIfMissing({
        name: repoName,
        description: app.description ?? app.name,
        userId: app.ownerId,
        appId: app.id,
      });
      const currentSrc = await getRepoSrcFiles({
        repo: repo.repo,
        branch: repo.defaultBranch,
      });
      // Current app code replaces template placeholders; configs stay fresh.
      Object.assign(files, currentSrc);

      await log(
        buildRunId,
        `Applying change: ${changeRequest?.description ?? "updated specification"}`,
      );
      generated = await runChangeCodeAgent({
        spec,
        changeSummary:
          changeRequest?.description ?? "Apply the updated specification.",
        currentFiles: currentSrc,
      });
    } else {
      await log(buildRunId, `Generating code for "${app.name}"…`);
      generated = await runCodeAgent(spec);
    }
    Object.assign(files, generated.files);
    await log(
      buildRunId,
      `Code agent wrote ${generated.filesWritten.length} files: ${generated.filesWritten.join(", ")}`,
    );
    if (generated.notes) await log(buildRunId, `Code agent notes: ${generated.notes}`);
    if (generated.filesWritten.length === 0) {
      throw new Error("Code agent produced no files");
    }

    // 2. Test gauntlet with bounded debug loop.
    const dir = workspaceDir(buildRunId);
    await writeWorkspace(dir, files);
    await setStatus(buildRunId, "testing");

    let debugRounds = 0;
    let stepIdx = 0;
    const debugNotes: string[] = [];
    while (stepIdx < STEP_ORDER.length) {
      const step = STEP_ORDER[stepIdx];
      await log(buildRunId, `Running ${step}…`);
      const result = await runStep(dir, step);

      await db.insert(testResults).values({
        buildRunId,
        suite: SUITE_FOR_STEP[step],
        status: result.ok ? "passed" : "failed",
        summary: `${step} (${Math.round(result.durationMs / 1000)}s)`,
        details: { output: result.output },
      });

      if (result.ok) {
        await log(buildRunId, `${step} passed.`);
        stepIdx++;
        continue;
      }

      debugRounds++;
      if (debugRounds > MAX_DEBUG_ROUNDS) {
        throw new Error(
          `${step} still failing after ${MAX_DEBUG_ROUNDS} debug rounds`,
        );
      }

      await setStatus(buildRunId, "debugging");
      await log(
        buildRunId,
        `${step} failed — debug round ${debugRounds}/${MAX_DEBUG_ROUNDS}…`,
      );
      const fix = await runDebugAgent({
        spec,
        currentFiles: srcOnly(files),
        failedStep: step,
        errorOutput: result.output,
        previousAttempts: debugNotes,
      });
      if (fix.filesWritten.length === 0) {
        throw new Error(`Debug agent could not produce a fix for ${step}`);
      }
      debugNotes.push(fix.notes || `(rewrote ${fix.filesWritten.join(", ")})`);
      Object.assign(files, fix.files);
      await writeWorkspace(dir, fix.files);
      await log(
        buildRunId,
        `Debug agent rewrote: ${fix.filesWritten.join(", ")}. ${fix.notes}`,
      );
      await setStatus(buildRunId, "testing");
      // Re-run from typecheck (install output can't be affected by src changes).
      stepIdx = Math.min(stepIdx, 1);
      if (step === "install") stepIdx = 0;
    }

    // 3. Push the passing code to a build branch on GitHub.
    await log(buildRunId, "All checks passed. Creating GitHub repo…");
    const repoName = `voiceforge-${app.slug}`;
    const repo = await createRepoIfMissing({
      name: repoName,
      description: `${app.name} — built by VoiceForge. ${spec.purpose}`,
      userId: app.ownerId,
      appId: app.id,
    });

    const branch = `build-${buildRunId.slice(0, 8)}`;
    await createBranch({
      repo: repo.repo,
      branch,
      fromBranch: repo.defaultBranch,
    });
    const { commitSha } = await commitFiles({
      repo: repo.repo,
      branch,
      files,
      message: `VoiceForge build (spec v${requirement.version}): ${app.name}`,
      userId: app.ownerId,
      appId: app.id,
    });
    await log(
      buildRunId,
      `Committed ${commitSha.slice(0, 7)} to branch ${branch} (${repo.htmlUrl})`,
    );
    await db
      .update(apps)
      .set({ githubRepoUrl: repo.htmlUrl, updatedAt: new Date() })
      .where(eq(apps.id, app.id));

    // 4. Preview deployment on Vercel + smoke test.
    await setStatus(buildRunId, "deploying", { commitSha, branch });
    await log(buildRunId, "Creating preview deployment on Vercel…");
    const project = await ensureProject({
      name: repoName,
      githubRepo: `${repo.owner}/${repo.repo}`,
      userId: app.ownerId,
      appId: app.id,
    });
    await db
      .update(apps)
      .set({ vercelProjectId: project.id, updatedAt: new Date() })
      .where(eq(apps.id, app.id));

    const deployment = await createDeployment({
      projectName: repoName,
      githubRepoId: repo.repoId,
      ref: branch,
      production: false,
      userId: app.ownerId,
      appId: app.id,
    });
    const [depRow] = await db
      .insert(deployments)
      .values({
        appId: app.id,
        buildRunId,
        environment: "preview",
        vercelDeploymentId: deployment.id,
        status: "building",
      })
      .returning();

    await log(buildRunId, "Waiting for Vercel to build the preview…");
    const finished = await waitForDeployment(deployment.id);
    const previewUrl = `https://${finished.url}`;
    await db
      .update(deployments)
      .set({
        status: finished.readyState === "READY" ? "ready" : "error",
        url: previewUrl,
      })
      .where(eq(deployments.id, depRow.id));
    if (finished.readyState !== "READY") {
      throw new Error(
        `Vercel preview deployment ended in state ${finished.readyState}`,
      );
    }

    const smoke = await smokeTest(finished.url);
    await db.insert(testResults).values({
      buildRunId,
      suite: "smoke",
      status: smoke.ok ? "passed" : "failed",
      summary: `smoke test against preview`,
      details: { output: smoke.detail },
    });
    if (!smoke.ok) {
      throw new Error(`Smoke test failed: ${smoke.detail}`);
    }
    await log(buildRunId, `Smoke test passed: ${smoke.detail}`);

    // 5. Hand over to the user for testing; production needs their approval.
    await db
      .update(apps)
      .set({ previewUrl, status: "testing", updatedAt: new Date() })
      .where(eq(apps.id, app.id));
    await setStatus(buildRunId, "awaiting_user_test");
    if (changeRequest) {
      await db
        .update(changeRequests)
        .set({ status: "complete", updatedAt: new Date() })
        .where(eq(changeRequests.id, changeRequest.id));
    }
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "build.previewReady",
      payload: { commitSha, previewUrl, branch, changeMode },
    });
    await log(
      buildRunId,
      `Preview is live: ${previewUrl} — try the app, then press Publish to put it online for real.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(buildRunId, `Build failed: ${message}`);
    await setStatus(buildRunId, "failed", {
      errorMessage: message,
      finishedAt: new Date(),
    });
    // A failed change build must not mark a live app as failed.
    await db
      .update(apps)
      .set({
        status: app.productionUrl ? "deployed" : "failed",
        updatedAt: new Date(),
      })
      .where(eq(apps.id, app.id));
    if (run.requirementId) {
      await db
        .update(changeRequests)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(changeRequests.requirementId, run.requirementId));
    }
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "build.failed",
      payload: { error: message },
    });
  }
}
