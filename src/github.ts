import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asJsonObject, isoTimestamp, stableId, type TimelineEvent } from "./schema.js";

const execFileAsync = promisify(execFile);

interface GitHubUser {
  login?: string;
}

interface GitHubPullRequest {
  id: number;
  number: number;
  html_url: string;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  title: string;
  body?: string | null;
  user?: GitHubUser;
  base?: { ref?: string; sha?: string };
  head?: { ref?: string; sha?: string };
  [key: string]: unknown;
}

interface GitHubCommit {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { date?: string | null; name?: string | null } | null;
    committer?: { date?: string | null; name?: string | null } | null;
  };
  author?: GitHubUser | null;
  [key: string]: unknown;
}

interface GitHubComment {
  id: number;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  html_url?: string;
  path?: string | null;
  commit_id?: string | null;
  user?: GitHubUser;
  [key: string]: unknown;
}

interface GitHubReview extends GitHubComment {
  state?: string;
  submitted_at?: string | null;
  commit_id?: string | null;
}

interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string;
  details_url?: string;
  head_sha?: string;
  app?: { name?: string; slug?: string } | null;
  output?: { title?: string | null; summary?: string | null } | null;
  [key: string]: unknown;
}

function checkStatus(check: GitHubCheckRun): string {
  if (check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped") {
    return "success";
  }
  if (check.conclusion) return "failure";
  return check.status;
}

function sourceFor(login: string): "github" | "greptile" {
  return login.toLowerCase().includes("greptile") ? "greptile" : "github";
}

function shortBody(body: string | null | undefined): string {
  const firstLine = body?.replace(/\s+/g, " ").trim() ?? "";
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
}

export class GitHubClient {
  async api<T>(endpoint: string, paginate = false): Promise<T> {
    const args = ["api", "-H", "Accept: application/vnd.github+json"];
    if (paginate) args.push("--paginate", "--slurp");
    args.push(endpoint);
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: "cat" },
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (paginate && Array.isArray(parsed)) {
      return parsed.flat() as T;
    }
    return parsed as T;
  }

  async pullRequestTimeline(sessionId: string, repo: string, number: number): Promise<TimelineEvent[]> {
    const root = `/repos/${repo}`;
    const [pull, commits, issueComments, reviewComments, reviews] = await Promise.all([
      this.api<GitHubPullRequest>(`${root}/pulls/${number}`),
      this.api<GitHubCommit[]>(`${root}/pulls/${number}/commits?per_page=100`, true),
      this.api<GitHubComment[]>(`${root}/issues/${number}/comments?per_page=100`, true),
      this.api<GitHubComment[]>(`${root}/pulls/${number}/comments?per_page=100`, true),
      this.api<GitHubReview[]>(`${root}/pulls/${number}/reviews?per_page=100`, true),
    ]);

    const events: TimelineEvent[] = [{
      schemaVersion: 1,
      id: stableId("github", repo, number, "opened"),
      sessionId,
      repo,
      occurredAt: isoTimestamp(pull.created_at),
      source: "github",
      type: "pr_opened",
      title: `PR #${number} opened`,
      status: pull.state,
      commitSha: pull.head?.sha ?? null,
      path: null,
      url: pull.html_url,
      data: {
        number,
        title: pull.title,
        body: pull.body ?? "",
        author: pull.user?.login ?? null,
        baseBranch: pull.base?.ref ?? null,
        baseSha: pull.base?.sha ?? null,
        headBranch: pull.head?.ref ?? null,
        headSha: pull.head?.sha ?? null,
      },
    }];

    for (const commit of commits) {
      const message = commit.commit?.message ?? "Commit created";
      events.push({
        schemaVersion: 1,
        id: stableId("github", repo, number, "commit", commit.sha),
        sessionId,
        repo,
        occurredAt: isoTimestamp(commit.commit?.author?.date ?? commit.commit?.committer?.date),
        source: "github",
        type: "commit_created",
        title: message.split("\n")[0] || "Commit created",
        status: null,
        commitSha: commit.sha,
        path: null,
        url: commit.html_url ?? null,
        data: {
          number,
          message,
          author: commit.author?.login ?? commit.commit?.author?.name ?? null,
        },
      });
    }

    const checkResults = await Promise.allSettled(commits.map((commit) =>
      this.api<{ check_runs?: GitHubCheckRun[] }>(`${root}/commits/${commit.sha}/check-runs?per_page=100`)));
    for (const result of checkResults) {
      if (result.status !== "fulfilled") continue;
      for (const check of result.value.check_runs ?? []) {
        const status = checkStatus(check);
        events.push({
          schemaVersion: 1,
          id: stableId("github", repo, "check", check.id),
          sessionId,
          repo,
          occurredAt: isoTimestamp(check.completed_at ?? check.started_at ?? pull.updated_at),
          source: "ci",
          type: "check_completed",
          title: check.name,
          status,
          commitSha: check.head_sha ?? null,
          path: null,
          url: check.details_url ?? check.html_url ?? null,
          data: {
            number,
            provider: check.app?.name ?? check.app?.slug ?? null,
            checkStatus: check.status,
            conclusion: check.conclusion ?? null,
            summary: check.output?.summary ?? null,
          },
        });
      }
    }

    for (const comment of [...issueComments, ...reviewComments]) {
      const login = comment.user?.login ?? "unknown";
      const source = sourceFor(login);
      events.push({
        schemaVersion: 1,
        id: stableId("github", repo, "comment", comment.id),
        sessionId,
        repo,
        occurredAt: isoTimestamp(comment.created_at),
        source,
        type: source === "greptile" ? "greptile_comment" : "review_comment",
        title: source === "greptile"
          ? shortBody(comment.body) || "Greptile commented"
          : `${login} commented`,
        status: null,
        commitSha: comment.commit_id ?? null,
        path: comment.path ?? null,
        url: comment.html_url ?? null,
        data: {
          number,
          author: login,
          body: comment.body ?? "",
          updatedAt: comment.updated_at ?? null,
        },
      });
    }

    for (const review of reviews) {
      const login = review.user?.login ?? "unknown";
      const source = sourceFor(login);
      events.push({
        schemaVersion: 1,
        id: stableId("github", repo, "review", review.id),
        sessionId,
        repo,
        occurredAt: isoTimestamp(review.submitted_at ?? review.created_at),
        source,
        type: source === "greptile" ? "greptile_review" : "review_submitted",
        title: source === "greptile" ? "Greptile review submitted" : `${login} reviewed the PR`,
        status: review.state?.toLowerCase() ?? null,
        commitSha: review.commit_id ?? null,
        path: null,
        url: review.html_url ?? null,
        data: {
          number,
          author: login,
          body: review.body ?? "",
          reviewState: review.state ?? null,
        },
      });
    }

    if (pull.merged_at) {
      events.push({
        schemaVersion: 1,
        id: stableId("github", repo, number, "merged"),
        sessionId,
        repo,
        occurredAt: isoTimestamp(pull.merged_at),
        source: "github",
        type: "pr_merged",
        title: `PR #${number} merged`,
        status: "merged",
        commitSha: pull.merge_commit_sha ?? null,
        path: null,
        url: pull.html_url,
        data: { number },
      });
    } else if (pull.closed_at) {
      events.push({
        schemaVersion: 1,
        id: stableId("github", repo, number, "closed"),
        sessionId,
        repo,
        occurredAt: isoTimestamp(pull.closed_at),
        source: "github",
        type: "pr_closed",
        title: `PR #${number} closed`,
        status: "closed",
        commitSha: pull.head?.sha ?? null,
        path: null,
        url: pull.html_url,
        data: { number },
      });
    }

    return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  }
}
