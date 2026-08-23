import assert from "node:assert/strict";
import test from "node:test";
import { seedDemo } from "../src/demo.js";
import { TimelineStore } from "../src/store.js";
import type { SessionAnalysis } from "../src/schema.js";

test("filters sessions repo by repo and returns ordered timelines", () => {
  const store = new TimelineStore(":memory:");
  seedDemo(store);

  assert.equal(store.countSessions(), 3);
  assert.deepEqual(store.listRepos().map((repo) => [repo.repo, repo.sessionCount]), [
    ["DevelopIQ-ai/puffle-app", 2],
    ["DevelopIQ-ai/cookiejar", 1],
  ]);
  assert.equal(store.listSessions({ repo: "DevelopIQ-ai/puffle-app" }).length, 2);
  assert.equal(store.listSessions({ repo: "DevelopIQ-ai/cookiejar" }).length, 1);
  assert.equal(store.listSessions({ query: "CSV" })[0]?.id, "devin-demo-export");

  const timeline = store.getTimeline("devin-demo-export");
  assert.ok(timeline);
  assert.ok(timeline.events.length >= 6);
  assert.deepEqual(
    [...timeline.events].map((event) => event.occurredAt),
    [...timeline.events].map((event) => event.occurredAt).sort(),
  );
  assert.ok(timeline.events.some((event) => event.status === "failure"));

  const analysis: SessionAnalysis = {
    analysis_schema_version: 1,
    session_id: timeline.session.id,
    repo: timeline.session.repositories[0] ?? null,
    outcome: { status: "partial", summary: "Demo outcome", evidence_event_ids: [timeline.events.at(-1)?.id ?? timeline.events[0]!.id] },
    coverage: {
      events_total: timeline.events.length,
      events_reviewed: timeline.events.length,
      events_with_token_usage: 0,
      events_with_timing: timeline.events.length,
      limitations: ["Demo data has no token usage."],
    },
    insights: [],
    totals: {
      wasted_tokens: 0,
      token_measurement: "exact",
      wasted_seconds: 0,
      time_measurement: "exact",
      notes: [],
    },
  };
  store.upsertAnalysis({
    sessionId: timeline.session.id,
    inputHash: "timeline-hash",
    analyzer: "coding-session-analyst",
    createdAt: "2026-08-23T12:00:00.000Z",
    analysis,
  });
  assert.deepEqual(store.getAnalysis(timeline.session.id)?.analysis, analysis);
  const report = {
    report_schema_version: 1 as const,
    repo: "DevelopIQ-ai/puffle-app",
    source_repositories: ["DevelopIQ-ai/puffle-app"],
    coverage: {
      sessions_discovered: 1,
      sessions_analyzed: 1,
      sessions_with_failures: 0,
      input_insights: 0,
      included_insights: 0,
    },
    failures: [],
    limitations: ["No failure hypotheses survived analysis."],
  };
  store.upsertRepoReport({
    repo: report.repo,
    inputHash: "repo-input-hash",
    analyzer: "gbird-repo-reporter",
    createdAt: "2026-08-23T12:01:00.000Z",
    report,
  });
  assert.deepEqual(store.getRepoReport(report.repo)?.report, report);
  store.close();
});
