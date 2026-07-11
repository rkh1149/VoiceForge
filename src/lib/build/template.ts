import { promises as fs } from "fs";
import path from "path";

/** Repo-relative path -> file content. */
export type FileMap = Record<string, string>;

const TEMPLATE_DIR = path.join(process.cwd(), "templates", "nextjs-base");

/** Paths the Code/Debug agents are allowed to create or overwrite. */
const WRITABLE_PREFIXES = ["src/app/", "src/components/", "src/lib/"];

/** Files agents must never touch (template integrity). */
const PROTECTED_FILES = new Set([
  "src/app/globals.css",
  "src/lib/template.test.ts",
  "src/app/api/ai/route.ts", // locked AI endpoint (Stage 7)
]);

const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx"]);

export function isAgentWritablePath(p: string): {
  ok: boolean;
  reason?: string;
} {
  const normalized = path.posix.normalize(p.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return { ok: false, reason: "Path must be relative, without '..'" };
  }
  if (PROTECTED_FILES.has(normalized)) {
    return { ok: false, reason: `${normalized} is protected` };
  }
  if (!WRITABLE_PREFIXES.some((pre) => normalized.startsWith(pre))) {
    return {
      ok: false,
      reason: `Files may only be written under: ${WRITABLE_PREFIXES.join(", ")}`,
    };
  }
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(normalized))) {
    return { ok: false, reason: "Only .ts and .tsx files are allowed" };
  }
  return { ok: true };
}

/** Escape a value for safe substitution into template string literals. */
function sanitize(value: string): string {
  return value.replace(/[\\"`]/g, "'").replace(/\s+/g, " ").trim();
}

async function walk(dir: string, base = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(dir, entry.name), rel)));
    } else {
      files.push(rel);
    }
  }
  return files;
}

/** Load the base template with app name/slug/purpose substituted in. */
export async function loadTemplate(vars: {
  slug: string;
  name: string;
  purpose: string;
}): Promise<FileMap> {
  const paths = await walk(TEMPLATE_DIR);
  const map: FileMap = {};
  for (const rel of paths) {
    const raw = await fs.readFile(path.join(TEMPLATE_DIR, rel), "utf8");
    map[rel] = raw
      .replaceAll("__APP_SLUG__", sanitize(vars.slug))
      .replaceAll("__APP_NAME__", sanitize(vars.name))
      .replaceAll("__APP_PURPOSE__", sanitize(vars.purpose));
  }
  return map;
}
