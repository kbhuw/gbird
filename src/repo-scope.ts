import { execFileSync } from "node:child_process";
import { TimelineStore } from "./store.js";

export interface RepoScope {
  canonical: string;
  repositories: string[];
}

const canonicalCache = new Map<string, string>();

export function canonicalRepo(repo: string): string {
  const cached = canonicalCache.get(repo);
  if (cached) return cached;
  try {
    const canonical = execFileSync("gh", ["repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim() || repo;
    canonicalCache.set(repo, canonical);
    return canonical;
  } catch {
    canonicalCache.set(repo, repo);
    return repo;
  }
}

export function resolveRepoScope(store: TimelineStore, requested: string): RepoScope {
  const canonical = canonicalRepo(requested);
  const owner = canonical.split("/")[0]?.toLowerCase();
  const candidates = store.listRepos()
    .map((entry) => entry.repo)
    .filter((repo) => repo.includes("/") && repo.split("/")[0]?.toLowerCase() === owner);
  const repositories = [...new Set([canonical, requested, ...candidates]
    .filter((repo) => canonicalRepo(repo).toLowerCase() === canonical.toLowerCase()))];
  repositories.sort((left, right) => {
    if (left === canonical) return -1;
    if (right === canonical) return 1;
    return left.localeCompare(right);
  });
  return { canonical, repositories };
}
