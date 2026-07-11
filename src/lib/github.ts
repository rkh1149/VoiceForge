import { Octokit } from "@octokit/rest";
import type { FileMap } from "@/lib/build/template";
import { audit } from "@/lib/audit";

/**
 * GitHub tool layer (Stage 2).
 * Auth: fine-grained personal access token in GITHUB_TOKEN, owner in
 * GITHUB_OWNER. Swappable for a GitHub App later — callers only use
 * these functions, never Octokit directly.
 */

function getOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set (see .env.example).");
  }
  return new Octokit({ auth: token });
}

function getOwner(): string {
  const owner = process.env.GITHUB_OWNER;
  if (!owner) {
    throw new Error("GITHUB_OWNER is not set (see .env.example).");
  }
  return owner;
}

export type RepoInfo = {
  owner: string;
  repo: string;
  repoId: number; // numeric GitHub id (needed by Vercel's gitSource)
  htmlUrl: string;
  defaultBranch: string;
};

/** Create a private repo for a generated app (idempotent). */
export async function createRepoIfMissing(opts: {
  name: string;
  description: string;
  userId?: string;
  appId?: string;
}): Promise<RepoInfo> {
  const octokit = getOctokit();
  const owner = getOwner();

  try {
    const { data } = await octokit.repos.get({ owner, repo: opts.name });
    return {
      owner,
      repo: data.name,
      repoId: data.id,
      htmlUrl: data.html_url,
      defaultBranch: data.default_branch,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
  }

  const { data } = await octokit.repos.createForAuthenticatedUser({
    name: opts.name,
    description: opts.description.slice(0, 300),
    private: true,
    auto_init: true, // creates main branch so we can commit against it
  });

  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "github.repoCreated",
    payload: { repo: data.full_name, url: data.html_url },
  });

  return {
    owner,
    repo: data.name,
    repoId: data.id,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch ?? "main",
  };
}

/** Delete a repo (404 counts as already gone). */
export async function deleteRepo(name: string): Promise<void> {
  const octokit = getOctokit();
  const owner = getOwner();
  try {
    await octokit.repos.delete({ owner, repo: name });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return;
    if (status === 403) {
      throw new Error(
        "GitHub refused to delete the repo — your fine-grained token needs 'Administration: Read and write' permission.",
      );
    }
    throw err;
  }
}

/**
 * Fetch the current src/ files of an app repo (change-mode starting point).
 * Only src/**&#47;*.ts(x) matter: configs and package.json always come fresh
 * from the template, and agents may only write under src/ anyway.
 */
export async function getRepoSrcFiles(opts: {
  repo: string;
  branch: string;
}): Promise<FileMap> {
  const octokit = getOctokit();
  const owner = getOwner();

  const ref = await octokit.git.getRef({
    owner,
    repo: opts.repo,
    ref: `heads/${opts.branch}`,
  });
  const commit = await octokit.git.getCommit({
    owner,
    repo: opts.repo,
    commit_sha: ref.data.object.sha,
  });
  const tree = await octokit.git.getTree({
    owner,
    repo: opts.repo,
    tree_sha: commit.data.tree.sha,
    recursive: "1",
  });

  const files: FileMap = {};
  for (const entry of tree.data.tree) {
    if (
      entry.type !== "blob" ||
      !entry.path?.startsWith("src/") ||
      !entry.sha ||
      !/\.(ts|tsx|css)$/.test(entry.path)
    ) {
      continue;
    }
    const blob = await octokit.git.getBlob({
      owner,
      repo: opts.repo,
      file_sha: entry.sha,
    });
    files[entry.path] = Buffer.from(blob.data.content, "base64").toString(
      "utf8",
    );
  }
  return files;
}

/** Create a branch pointing at the current head of the default branch. */
export async function createBranch(opts: {
  repo: string;
  branch: string;
  fromBranch: string;
}): Promise<void> {
  const octokit = getOctokit();
  const owner = getOwner();
  const base = await octokit.git.getRef({
    owner,
    repo: opts.repo,
    ref: `heads/${opts.fromBranch}`,
  });
  try {
    await octokit.git.createRef({
      owner,
      repo: opts.repo,
      ref: `refs/heads/${opts.branch}`,
      sha: base.data.object.sha,
    });
  } catch (err) {
    // 422 = ref already exists (retried build) — reset it to base instead.
    if ((err as { status?: number }).status !== 422) throw err;
    await octokit.git.updateRef({
      owner,
      repo: opts.repo,
      ref: `heads/${opts.branch}`,
      sha: base.data.object.sha,
      force: true,
    });
  }
}

/** Merge a build branch into the default branch (production promote). */
export async function mergeToDefault(opts: {
  repo: string;
  branch: string;
  defaultBranch: string;
  message: string;
  userId?: string;
  appId?: string;
}): Promise<{ mergeSha: string | null }> {
  const octokit = getOctokit();
  const owner = getOwner();
  const { data } = await octokit.repos.merge({
    owner,
    repo: opts.repo,
    base: opts.defaultBranch,
    head: opts.branch,
    commit_message: opts.message,
  });

  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "github.mergedToDefault",
    payload: {
      repo: `${owner}/${opts.repo}`,
      branch: opts.branch,
      mergeSha: data?.sha ?? null,
    },
  });

  return { mergeSha: data?.sha ?? null };
}

/** Commit a set of files as a single commit on a branch (git data API). */
export async function commitFiles(opts: {
  repo: string;
  branch: string;
  files: FileMap;
  message: string;
  userId?: string;
  appId?: string;
}): Promise<{ commitSha: string }> {
  const octokit = getOctokit();
  const owner = getOwner();
  const { repo, branch, files, message } = opts;

  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const parentSha = ref.data.object.sha;

  // No base_tree: each build commit is a COMPLETE snapshot of the app.
  // Overlaying on the previous tree would leave stale files from earlier
  // generations in the repo, breaking deployment builds.
  const tree = await octokit.git.createTree({
    owner,
    repo,
    tree: Object.entries(files).map(([path, content]) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      content,
    })),
  });

  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.data.sha,
    parents: [parentSha],
  });

  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
  });

  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "github.commit",
    payload: {
      repo: `${owner}/${repo}`,
      branch,
      commitSha: commit.data.sha,
      fileCount: Object.keys(files).length,
      message,
    },
  });

  return { commitSha: commit.data.sha };
}
