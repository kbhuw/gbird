import { DevinClient, normalizeDevinSession, type DevinMessageResponse } from "./devin.js";
import { GitHubClient } from "./github.js";
import { TimelineStore } from "./store.js";

export interface SyncProgress {
  completed: number;
  total: number;
  sessionId: string;
  title: string;
}

export interface SyncSummary {
  sessions: number;
  events: number;
  githubPullRequests: number;
  errors: Array<{ sessionId: string; source: string; message: string }>;
}

export interface SyncOptions {
  store: TimelineStore;
  devin: DevinClient;
  github?: GitHubClient;
  limit?: number;
  onProgress?: (progress: SyncProgress) => void;
}

export async function syncTimeline(options: SyncOptions): Promise<SyncSummary> {
  const rawSessions = await options.devin.listSessions(options.limit ?? 50);
  const summary: SyncSummary = {
    sessions: 0,
    events: 0,
    githubPullRequests: 0,
    errors: [],
  };

  for (const [index, rawSession] of rawSessions.entries()) {
    let messages: DevinMessageResponse[] = [];
    try {
      messages = await options.devin.listMessages(rawSession.session_id);
    } catch (error) {
      summary.errors.push({
        sessionId: rawSession.session_id,
        source: "devin_messages",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const normalized = normalizeDevinSession(rawSession, messages);
    options.store.upsertSession(normalized.session);
    options.store.upsertEvents(normalized.events);
    summary.sessions += 1;
    summary.events += normalized.events.length;

    if (options.github) {
      for (const pullRequest of normalized.session.pullRequests) {
        if (!pullRequest.repo || !pullRequest.number) continue;
        try {
          const events = await options.github.pullRequestTimeline(
            normalized.session.id,
            pullRequest.repo,
            pullRequest.number,
          );
          options.store.upsertEvents(events);
          summary.events += events.length;
          summary.githubPullRequests += 1;
        } catch (error) {
          summary.errors.push({
            sessionId: rawSession.session_id,
            source: `github:${pullRequest.repo}#${pullRequest.number}`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    options.onProgress?.({
      completed: index + 1,
      total: rawSessions.length,
      sessionId: normalized.session.id,
      title: normalized.session.title,
    });
  }

  return summary;
}
