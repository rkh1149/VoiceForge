import { Agent, run, tool, user } from "@openai/agents";
import { z } from "zod";
import type { AppSpec } from "@/lib/spec";
import { isAgentWritablePath, type FileMap } from "@/lib/build/template";

/**
 * Code Agent + Debug Agent (Stage 2).
 * Both write files exclusively through the write_file tool, which enforces
 * the writable-path policy (src/ only, no configs, no package.json).
 */

const CODER_MODEL = process.env.OPENAI_CODER_MODEL ?? "gpt-5.4";

const SHARED_RULES = `Rules for all files you write:
- This is a Next.js 15 App Router project with TypeScript (strict) and Tailwind CSS 4. React 19.
- You may ONLY write files under src/app/, src/components/, and src/lib/, with .ts or .tsx extensions, via the write_file tool. package.json, configs, and src/app/globals.css are locked — the project's dependencies CANNOT be changed, so import only: react, next (next/link, next/image, next/navigation), and files you write yourself.
- The app must work entirely in the browser: no databases, no API keys, no external services (the ONLY exception is the locked /api/ai endpoint described below when the spec includes AI features). If data must persist, use localStorage inside client components ("use client") with a typed wrapper in src/lib/storage.ts.
- src/app/api/ai/route.ts is a LOCKED platform file — never modify, overwrite, or reimplement it, and never create any other file under src/app/api/.
- CRITICAL: every page is prerendered on the server at build time, where window/localStorage do not exist. Never touch window or localStorage at module scope, in useState initializers, or during render — ONLY inside useEffect. Initialize state to defaults, then load saved data in a useEffect after mount.
- Do not create pages/, src/pages/, 404.tsx, 500.tsx, _document, or _app files — this is App Router only (use not-found.tsx / error.tsx if genuinely needed).
- NEVER reference static asset files (mp3, images, fonts, videos) — you cannot create them, so any such path will 404. For sound, synthesize it with the Web Audio API. For graphics, use inline SVG, CSS, or emoji. For images the user mentions, build an upload feature (stored in localStorage as data URLs) instead of assuming files exist.
- Style with Tailwind utility classes only. Mobile-first, readable, generous touch targets. The app is used by non-technical family members.
- Accessibility: semantic HTML, labels on inputs, alt text, keyboard operability.
- Write tests: for each main feature, add a *.test.tsx or *.test.ts file under src/ using vitest + @testing-library/react (both installed; jest-dom matchers like toBeInTheDocument are set up). Tests must not rely on localStorage persisting between tests.
- Tests must be deterministic: NEVER use vi.useFakeTimers, real delays, or arbitrary waits. Never use setTimeout/setInterval in components for game or app logic — apply state updates synchronously (skip artificial "thinking" pauses; they break tests and add nothing). In tests use fireEvent from @testing-library/react (@testing-library/user-event is NOT installed) then findBy*/waitFor.
- Write robust test assertions: query by role or aria-label on unique interactive elements, never by text that appears in more than one place or is split across elements (e.g. "0:13 / 0:37" rendered from multiple spans). Fewer, stronger assertions beat many brittle ones. Don't assert on intermediate states that depend on effect timing.
- Do not overwrite src/lib/template.test.ts.
- src/app/layout.tsx already exists with correct metadata; only rewrite it if the app truly needs a different shell, and keep the import of "./globals.css".
- Every page must compile under strict TypeScript and pass eslint (next/core-web-vitals). No unused variables, no explicit any.`;

function makeWriteFileTool(files: FileMap, log: string[]) {
  return tool({
    name: "write_file",
    description:
      "Create or overwrite one file in the app. Call once per file with the complete file content.",
    parameters: z.object({
      path: z
        .string()
        .describe("Repo-relative path, e.g. src/app/page.tsx"),
      content: z.string().describe("Complete file content"),
    }),
    execute: async ({ path: p, content }) => {
      const check = isAgentWritablePath(p);
      if (!check.ok) {
        return `REJECTED: ${check.reason}`;
      }
      files[p] = content;
      log.push(p);
      return `Wrote ${p} (${content.length} chars).`;
    },
  });
}

/** Extra guidance injected only when the spec includes AI features. */
export function aiUsageNote(spec: AppSpec): string {
  if (spec.aiFeatures.length === 0) return "";
  return `

THIS APP HAS AI FEATURES. Use the locked platform endpoint for ALL of them:
- POST /api/ai with JSON {prompt: string, system?: string} → responds {text: string}, or {error: string} with status 400/429/502/503.
- Call it with fetch from client components; always show a loading state while waiting.
- If the response is not ok, display the error message to the user politely (a daily AI limit exists — 429 means "come back tomorrow").
- Keep prompts under 4000 characters. Craft a good "system" string so answers fit this app's purpose and audience.
- NEVER call OpenAI or any external AI service directly, never reference API keys, and never modify src/app/api/ai/route.ts.
- In tests, mock global.fetch for /api/ai calls — never let tests hit the network.`;
}

export type CodegenResult = {
  files: FileMap; // newly written files only
  notes: string;
  filesWritten: string[];
};

export async function runCodeAgent(spec: AppSpec): Promise<CodegenResult> {
  const files: FileMap = {};
  const log: string[] = [];

  const agent = new Agent({
    name: "VoiceForge Code Agent",
    model: CODER_MODEL,
    instructions: `You are an expert Next.js developer. Build the app described by the specification, writing every file with the write_file tool. When finished, reply with a short plain-text summary of what you built and any limitations.

${SHARED_RULES}`,
    tools: [makeWriteFileTool(files, log)],
  });

  const specMessage = `Build this app:\n\n${JSON.stringify(spec, null, 2)}\n\nStart by writing src/app/page.tsx (replace the placeholder), then all components, lib files, and tests. Cover every screen and feature in the specification.${aiUsageNote(spec)}`;

  const result = await run(agent, [user(specMessage)], { maxTurns: 40 });

  return {
    files,
    notes: extractText(result.output),
    filesWritten: log,
  };
}

/** Change mode: modify an existing app's source instead of regenerating. */
export async function runChangeCodeAgent(input: {
  spec: AppSpec; // the UPDATED spec
  changeSummary: string;
  currentFiles: FileMap; // current src/ files from the live app
}): Promise<CodegenResult> {
  const files: FileMap = {};
  const log: string[] = [];

  const agent = new Agent({
    name: "VoiceForge Change Agent",
    model: CODER_MODEL,
    instructions: `You are an expert Next.js developer modifying an EXISTING app. Apply the requested change by rewriting only the files that need to differ (always complete file content, via write_file) and adding any new files/tests the change needs. Preserve everything else about the app: its look, behavior, and saved-data format (users must not lose data stored in localStorage — migrate the stored shape in the storage helper if the change requires it). Update or add tests to cover the change. When finished, reply with a short summary of what you changed.

${SHARED_RULES}`,
    tools: [makeWriteFileTool(files, log)],
  });

  const fileList = Object.entries(input.currentFiles)
    .map(([p, c]) => `===== ${p} =====\n${c}`)
    .join("\n\n");

  const message = `THE REQUESTED CHANGE:
${input.changeSummary}

THE UPDATED FULL SPECIFICATION:
${JSON.stringify(input.spec, null, 2)}

THE APP'S CURRENT SOURCE FILES:
${fileList}

Apply the change.${aiUsageNote(input.spec)}`;

  const result = await run(agent, [user(message)], { maxTurns: 40 });

  return {
    files,
    notes: extractText(result.output),
    filesWritten: log,
  };
}

export type DebugResult = {
  files: FileMap; // changed files only
  notes: string;
  filesWritten: string[];
};

export async function runDebugAgent(input: {
  spec: AppSpec;
  currentFiles: FileMap; // src/ files only
  failedStep: string;
  errorOutput: string;
  previousAttempts: string[]; // notes from earlier debug rounds this build
}): Promise<DebugResult> {
  const files: FileMap = {};
  const log: string[] = [];

  const agent = new Agent({
    name: "VoiceForge Debug Agent",
    model: CODER_MODEL,
    instructions: `You are an expert Next.js developer fixing a broken build. Analyze the failing step's output, find the root cause, and rewrite ONLY the files that need to change, using the write_file tool (always the complete file content). Keep changes minimal. When finished, reply with one short paragraph explaining the cause and the fix.

Known failure signatures:
- "next build" failing while prerendering /404, /500, or /_error with "<Html> should not be imported outside of pages/_document": a component threw during server prerendering — almost always window or localStorage accessed at module scope, in a useState initializer, or during render. Find that component and move the access into useEffect. Do NOT create 404.tsx/500.tsx/_document/_error files; they are not valid in the App Router and will not fix this.

Escalation rule: if an earlier attempt this build already rewrote the SAME test file for the same failing test, do not rewrite it again with cleverer queries — that strategy has failed. Instead either (a) fix the COMPONENT: races between effects and assertions, duplicated text without distinguishing roles/labels, state that briefly flickers through wrong values on mount — these are component bugs even when the error appears in a test; or (b) SIMPLIFY the test: delete the brittle assertions and keep only robust role/label-based checks of core behavior. A shorter passing test beats a thorough flaky one.

${SHARED_RULES}`,
    tools: [makeWriteFileTool(files, log)],
  });

  const fileList = Object.entries(input.currentFiles)
    .map(([p, c]) => `===== ${p} =====\n${c}`)
    .join("\n\n");

  const previousSection =
    input.previousAttempts.length > 0
      ? `\n--- EARLIER FIX ATTEMPTS THIS BUILD (did NOT resolve the failure — do something different) ---\n${input.previousAttempts
          .map((n, i) => `Attempt ${i + 1}: ${n}`)
          .join("\n")}\n`
      : "";

  const message = `The step "${input.failedStep}" failed.
${previousSection}
--- ERROR OUTPUT (tail) ---
${input.errorOutput}

--- APP SPECIFICATION ---
${JSON.stringify(input.spec, null, 2)}

--- CURRENT SOURCE FILES ---
${fileList}

Fix the problem.`;

  const result = await run(agent, [user(message)], { maxTurns: 25 });

  return {
    files,
    notes: extractText(result.output),
    filesWritten: log,
  };
}

/** Collect non-empty assistant text (same reasoning-model quirk as planner). */
function extractText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    const msg = item as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (msg.type === "message" && msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "output_text" && c.text?.trim()) parts.push(c.text.trim());
      }
    }
  }
  return parts.join("\n\n");
}
