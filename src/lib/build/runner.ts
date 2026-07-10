import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { FileMap } from "./template";

/**
 * Local test runner (Stage 2).
 * Runs install/typecheck/lint/test/build for a generated app in a temp
 * workspace. Safety comes from the template constraints: agents cannot
 * change package.json or configs, and installs run with scripts disabled.
 * The same step interface can be backed by Vercel Sandbox later.
 */

export type StepName = "install" | "typecheck" | "lint" | "test" | "build";

export type StepResult = {
  step: StepName;
  ok: boolean;
  output: string; // tail of combined stdout+stderr
  durationMs: number;
};

const OUTPUT_TAIL = 8000;

const STEPS: Record<
  StepName,
  { cmd: string; args: string[]; timeoutMs: number }
> = {
  install: {
    cmd: "npm",
    args: ["install", "--no-audit", "--no-fund", "--ignore-scripts"],
    timeoutMs: 5 * 60_000,
  },
  typecheck: { cmd: "npm", args: ["run", "typecheck"], timeoutMs: 3 * 60_000 },
  lint: { cmd: "npm", args: ["run", "lint"], timeoutMs: 3 * 60_000 },
  test: { cmd: "npm", args: ["run", "test"], timeoutMs: 5 * 60_000 },
  build: { cmd: "npm", args: ["run", "build"], timeoutMs: 8 * 60_000 },
};

export function workspaceDir(buildRunId: string): string {
  const base =
    process.env.BUILD_WORKSPACE_DIR ??
    path.join(os.tmpdir(), "voiceforge-builds");
  return path.join(base, buildRunId);
}

/** Write (or overwrite) files into the build workspace. */
export async function writeWorkspace(
  dir: string,
  files: FileMap,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

export async function runStep(
  dir: string,
  step: StepName,
): Promise<StepResult> {
  const { cmd, args, timeoutMs } = STEPS[step];
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: dir,
      // Deliberately no NODE_ENV: setting it to "development" makes
      // `next build` fail with a misleading prerender/<Html> error, and
      // npm installs devDependencies by default regardless.
      // (Cast needed: Next.js augments ProcessEnv to require NODE_ENV.)
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "true",
        NEXT_TELEMETRY_DISABLED: "1",
      } as unknown as NodeJS.ProcessEnv,
      shell: false,
    });

    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL * 2);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output += `\n[voiceforge] step "${step}" timed out after ${timeoutMs / 1000}s`;
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        step,
        ok: code === 0,
        output: output.slice(-OUTPUT_TAIL),
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        step,
        ok: false,
        output: `Failed to start ${cmd}: ${err.message}`,
        durationMs: Date.now() - started,
      });
    });
  });
}
