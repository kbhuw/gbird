import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROBE_TIMEOUT_MS = 15_000;

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/** Remote URLs that can reach <owner/repo>, most- to least-likely. */
export function remoteCandidates(repo: string): string[] {
  const candidates: string[] = [];
  if (process.env.GBIRD_GIT_URL) candidates.push(process.env.GBIRD_GIT_URL);
  // Devin cloud VMs authenticate through the org Git Manager proxy.
  candidates.push(`https://git-manager.devin.ai/proxy/github.com/${repo}.git`);
  candidates.push(`https://github.com/${repo}.git`);
  candidates.push(`git@github.com:${repo}.git`);
  return candidates;
}

function probe(url: string): boolean {
  try {
    execFileSync("git", ["ls-remote", url, "HEAD"], {
      stdio: "ignore",
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch {
    return false;
  }
}

/** First remote that answers ls-remote; throws if none do. */
export function resolveRemote(repo: string): string {
  for (const url of remoteCandidates(repo)) {
    if (probe(url)) return url;
  }
  throw new Error(`No git remote could reach ${repo} (tried ${remoteCandidates(repo).join(", ")}).`);
}

function copyTree(src: string, dst: string): number {
  let files = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      files += copyTree(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      files++;
    }
  }
  return files;
}

export interface PushOptions {
  /** owner/repo traces repository. */
  repo: string;
  /** Directory of session files to copy in (nested layout preserved). */
  dir: string;
  /** Subdir inside the repo (default "sessions"). */
  dest?: string;
  /** Existing checkout to use instead of cloning. */
  workdir?: string;
  /** Commit message override. */
  message?: string;
}

export interface PushResult {
  remote: string;
  files: number;
  committed: boolean;
  pushed: boolean;
}

export function pushDirToRepo(opts: PushOptions): PushResult {
  const src = path.resolve(opts.dir);
  if (!fs.existsSync(src)) throw new Error(`--dir ${src} does not exist.`);
  const dest = opts.dest ?? "sessions";

  let workdir = opts.workdir ? path.resolve(opts.workdir) : undefined;
  let remote: string;
  if (workdir && fs.existsSync(path.join(workdir, ".git"))) {
    remote = git(["remote", "get-url", "origin"], workdir);
    try {
      git(["pull", "--ff-only"], workdir);
    } catch {
      // proceed on the existing checkout even if it cannot fast-forward
    }
  } else {
    remote = resolveRemote(opts.repo);
    workdir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gbird-push-")), "repo");
    git(["clone", remote, workdir]);
  }

  const files = copyTree(src, path.join(workdir, dest));
  git(["add", "-A", dest], workdir);
  const dirty = git(["status", "--porcelain", dest], workdir);
  if (!dirty) {
    return { remote, files, committed: false, pushed: false };
  }
  const message = opts.message ?? `gbird: sync ${files} trace file${files === 1 ? "" : "s"}`;
  git(["commit", "-m", message], workdir);
  git(["push", "origin", "HEAD"], workdir);
  return { remote, files, committed: true, pushed: true };
}
