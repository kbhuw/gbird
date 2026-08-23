import { normalizeDevinSession, type DevinMessageResponse, type DevinSessionResponse } from "./devin.js";
import { stableId, type TimelineEvent } from "./schema.js";
import { TimelineStore } from "./store.js";

interface DemoDefinition {
  session: DevinSessionResponse;
  messages: DevinMessageResponse[];
  repo: string;
  pr: number;
  githubEvents: Array<{
    at: string;
    source: TimelineEvent["source"];
    type: string;
    title: string;
    status?: string | null;
    commitSha?: string | null;
    path?: string | null;
    data?: TimelineEvent["data"];
  }>;
}

const demos: DemoDefinition[] = [
  {
    session: {
      session_id: "devin-demo-invitations",
      title: "Fix invitation organization scoping",
      status: "finished",
      status_detail: "finished",
      origin: "webapp",
      created_at: "2026-08-22T16:05:00Z",
      updated_at: "2026-08-22T16:42:00Z",
      acus_consumed: 4.2,
      url: "https://app.devin.ai/sessions/devin-demo-invitations",
      tags: ["demo"],
      pull_requests: [{
        pr_state: "merged",
        pr_url: "https://github.com/DevelopIQ-ai/puffle-app/pull/1512",
      }],
    },
    messages: [
      {
        event_id: "invite-user",
        created_at: "2026-08-22T16:05:00Z",
        source: "user",
        message: "Fix invitation organization scoping and add a regression test.",
      },
      {
        event_id: "invite-devin",
        created_at: "2026-08-22T16:08:00Z",
        source: "devin",
        message: "I found the invitation route and its existing tests. I’ll update both.",
      },
    ],
    repo: "DevelopIQ-ai/puffle-app",
    pr: 1512,
    githubEvents: [
      { at: "2026-08-22T16:24:00Z", source: "github", type: "commit_created", title: "fix: scope invitations by organization", commitSha: "bd82aa0" },
      { at: "2026-08-22T16:25:00Z", source: "github", type: "pr_opened", title: "PR #1512 opened", status: "open" },
      { at: "2026-08-22T16:29:00Z", source: "ci", type: "check_completed", title: "unit tests", status: "success" },
      { at: "2026-08-22T16:34:00Z", source: "greptile", type: "greptile_review", title: "Greptile review submitted", status: "approved" },
      { at: "2026-08-22T16:42:00Z", source: "github", type: "pr_merged", title: "PR #1512 merged", status: "merged" },
    ],
  },
  {
    session: {
      session_id: "devin-demo-export",
      title: "Add campaign CSV export",
      status: "finished",
      status_detail: "finished",
      origin: "slack",
      created_at: "2026-08-21T19:10:00Z",
      updated_at: "2026-08-21T20:22:00Z",
      acus_consumed: 7.8,
      url: "https://app.devin.ai/sessions/devin-demo-export",
      tags: ["demo"],
      pull_requests: [{
        pr_state: "merged",
        pr_url: "https://github.com/DevelopIQ-ai/puffle-app/pull/1507",
      }],
    },
    messages: [{
      event_id: "export-user",
      created_at: "2026-08-21T19:10:00Z",
      source: "user",
      message: "Add CSV export to campaigns for admins.",
    }],
    repo: "DevelopIQ-ai/puffle-app",
    pr: 1507,
    githubEvents: [
      { at: "2026-08-21T19:49:00Z", source: "github", type: "commit_created", title: "feat: export campaigns as CSV", commitSha: "a19c21e" },
      { at: "2026-08-21T19:52:00Z", source: "github", type: "pr_opened", title: "PR #1507 opened", status: "open" },
      { at: "2026-08-21T20:01:00Z", source: "ci", type: "check_completed", title: "typecheck", status: "failure" },
      { at: "2026-08-21T20:07:00Z", source: "github", type: "commit_created", title: "fix: narrow CSV row type", commitSha: "c0931ac" },
      { at: "2026-08-21T20:11:00Z", source: "ci", type: "check_completed", title: "typecheck", status: "success" },
      { at: "2026-08-21T20:22:00Z", source: "github", type: "pr_merged", title: "PR #1507 merged", status: "merged" },
    ],
  },
  {
    session: {
      session_id: "devin-demo-cookiejar",
      title: "Add explicit site sign-in verification",
      status: "finished",
      status_detail: "finished",
      origin: "webapp",
      created_at: "2026-08-20T14:30:00Z",
      updated_at: "2026-08-20T15:01:00Z",
      acus_consumed: 3.1,
      url: "https://app.devin.ai/sessions/devin-demo-cookiejar",
      tags: ["demo"],
      pull_requests: [{
        pr_state: "open",
        pr_url: "https://github.com/DevelopIQ-ai/cookiejar/pull/88",
      }],
    },
    messages: [{
      event_id: "cookie-user",
      created_at: "2026-08-20T14:30:00Z",
      source: "user",
      message: "Add a bounded per-site sign-in check without returning cookie values.",
    }],
    repo: "DevelopIQ-ai/cookiejar",
    pr: 88,
    githubEvents: [
      { at: "2026-08-20T14:46:00Z", source: "github", type: "commit_created", title: "feat: verify site sessions", commitSha: "f02ac99" },
      { at: "2026-08-20T14:48:00Z", source: "github", type: "pr_opened", title: "PR #88 opened", status: "open" },
      { at: "2026-08-20T14:55:00Z", source: "ci", type: "check_completed", title: "tests", status: "success" },
      { at: "2026-08-20T15:01:00Z", source: "greptile", type: "greptile_comment", title: "Redirect validation should reject private hosts", path: "src/core/session-check.ts" },
    ],
  },
];

export function seedDemo(store: TimelineStore): void {
  if (store.countSessions() > 0) return;
  for (const demo of demos) {
    const normalized = normalizeDevinSession(demo.session, demo.messages);
    store.upsertSession(normalized.session);
    store.upsertEvents(normalized.events);
    store.upsertEvents(demo.githubEvents.map((event, index) => ({
      schemaVersion: 1,
      id: stableId("demo", normalized.session.id, event.type, event.at, index),
      sessionId: normalized.session.id,
      repo: demo.repo,
      occurredAt: event.at,
      source: event.source,
      type: event.type,
      title: event.title,
      status: event.status ?? null,
      commitSha: event.commitSha ?? null,
      path: event.path ?? null,
      url: `https://github.com/${demo.repo}/pull/${demo.pr}`,
      data: event.data ?? {},
    })));
  }
}
