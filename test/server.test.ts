import assert from "node:assert/strict";
import test from "node:test";
import { seedDemo } from "../src/demo.js";
import { startServer } from "../src/server.js";
import { TimelineStore } from "../src/store.js";
import type { RepoFailureReport, SessionAnalysis } from "../src/schema.js";

test("serves the Cookiejar-style repo-filtered session timeline", async () => {
  const priorKey = process.env.DEVIN_API_KEY;
  const priorSecret = process.env.SECRET;
  const priorOrg = process.env.DEVIN_ORG_ID;
  const priorCodexRoot = process.env.CODEX_SESSIONS_ROOT;
  delete process.env.DEVIN_API_KEY;
  delete process.env.SECRET;
  delete process.env.DEVIN_ORG_ID;
  process.env.CODEX_SESSIONS_ROOT = "/tmp/gbird-missing-codex-root";

  const store = new TimelineStore(":memory:");
  seedDemo(store);
  let analysisCalls = 0;
  const running = await startServer({
    store,
    port: 0,
    demo: true,
    analyzeSession: async (timeline): Promise<SessionAnalysis> => {
      analysisCalls += 1;
      const first = timeline.events[0]!;
      const last = timeline.events.at(-1)!;
      return {
        analysis_schema_version: 1,
        session_id: timeline.session.id,
        repo: timeline.session.repositories[0] ?? null,
        outcome: { status: "partial", summary: "A review finding remained.", evidence_event_ids: [last.id] },
        coverage: {
          events_total: timeline.events.length,
          events_reviewed: timeline.events.length,
          events_with_token_usage: 0,
          events_with_timing: timeline.events.length,
          limitations: ["No event-level token usage."],
        },
        insights: [{
          id: "insight-001",
          category: "premature_completion",
          title: "Completion preceded final review evidence",
          severity: "high",
          confidence: 0.95,
          observed: "The session claimed completion before the later review event.",
          why_it_matters: "The pull request was not ready.",
          evidence: [
            { event_id: first.id, occurred_at: first.occurredAt, kind: "message", summary: first.title },
            { event_id: last.id, occurred_at: last.occurredAt, kind: "review", summary: last.title },
          ],
          waste: { tokens: null, token_measurement: "unavailable", seconds: null, time_measurement: "unavailable", event_ids: [first.id, last.id] },
          hypothesis: "The agent may rely on a completion claim before checking the latest review state.",
          counterevidence: [],
          replay: {
            task: "Assess whether this pull request is ready to merge.",
            setup: ["Provide a current review finding."],
            failure_condition: "The agent reports ready while the finding remains.",
            success_condition: "The agent identifies the unresolved finding.",
          },
        }],
        totals: {
          wasted_tokens: null,
          token_measurement: "unavailable",
          wasted_seconds: null,
          time_measurement: "unavailable",
          notes: [],
        },
      };
    },
    analyzeRepo: async (input): Promise<RepoFailureReport> => {
      const occurrences = input.sessions.flatMap((item) => item.analysis.insights.map((insight) => ({
        session_id: item.session.id,
        session_title: item.session.title,
        agent: item.session.agent,
        insight_id: insight.id,
        observed: insight.observed,
        evidence_event_ids: insight.evidence.map((event) => event.event_id),
      })));
      const sessionCount = new Set(occurrences.map((occurrence) => occurrence.session_id)).size;
      return {
        report_schema_version: 1,
        repo: input.repo,
        source_repositories: input.source_repositories,
        coverage: {
          sessions_discovered: input.sessions.length,
          sessions_analyzed: input.sessions.length,
          sessions_with_failures: input.sessions.filter((item) => item.analysis.insights.length > 0).length,
          input_insights: occurrences.length,
          included_insights: occurrences.length,
        },
        failures: [{
          id: "failure-001",
          title: "Completion preceded final review evidence",
          category: "premature_completion",
          severity: "high",
          confidence: 0.95,
          classification: sessionCount >= 2 ? "recurring" : "single_occurrence",
          summary: "The agent claimed completion before checking the latest review state.",
          why_it_matters: "A pull request could be reported ready with unresolved findings.",
          historical_session_count: sessionCount,
          historical_occurrence_count: occurrences.length,
          occurrences,
          repro: {
            prompt: "Assess whether this pull request is ready to merge and report the evidence.",
            setup: ["Provide the current pull request state."],
            failure_condition: "The agent reports ready while a current finding remains.",
            success_condition: "The agent identifies the unresolved finding.",
          },
          suggested_guardrail: "Require current review-thread inspection before readiness claims.",
        }],
        limitations: ["Historical findings have not been replayed."],
      };
    },
  });

  try {
    const html = await (await fetch(running.url)).text();
    assert.ok(html.includes("catches slugs"));
    assert.ok(html.includes("<h1>gbird</h1>"));
    assert.ok(html.includes("Codex"));
    assert.ok(html.includes("All agents"));
    assert.equal(html.includes("agent-switch"), false);
    assert.ok(html.includes("aria-haspopup=\"dialog\"") || html.includes("session-dialog"));
    assert.ok(html.includes("timeline-node"));
    assert.ok(html.includes("timeline-mark"));
    assert.ok(html.includes("https://cognition.com/icon.svg"));
    assert.ok(html.includes("https://www.greptile.com/logo-only.svg"));
    assert.ok(html.includes("GitGuardian"));
    assert.ok(html.includes("PR merged"));
    assert.ok(html.includes("pr-opened"));
    assert.ok(html.includes("pr-comment"));
    assert.ok(html.includes("eventPrNumber"));
    assert.ok(html.includes("Normalized data"));
    assert.ok(html.includes("Analyze"));
    assert.ok(html.includes("Failure hypotheses"));
    assert.ok(html.includes("Failure report"));

    const about = await (await fetch(new URL("/about", running.url))).text();
    assert.ok(about.includes("Coding agents leave a trail"));
    assert.ok(about.includes("Receipts or it isn’t a slug"));
    assert.ok(about.includes("href=\"/\""));

    const state = await (await fetch(new URL("/api/state", running.url))).json() as {
      configured: boolean;
      demo: boolean;
      sessionCount: number;
      analysisConfigured: boolean;
    };
    assert.equal(state.configured, false);
    assert.equal(state.demo, true);
    assert.equal(state.sessionCount, 3);
    assert.equal(state.analysisConfigured, true);

    const filtered = await (await fetch(
      new URL("/api/sessions?repo=DevelopIQ-ai%2Fcookiejar", running.url),
    )).json() as { sessions: Array<{ id: string; analysisStatus: string }> };
    assert.deepEqual(filtered.sessions.map((session) => session.id), ["devin-demo-cookiejar"]);
    assert.equal(filtered.sessions[0]?.analysisStatus, "not_analyzed");

    const timelineResponse = await fetch(
      new URL("/api/sessions/devin-demo-cookiejar", running.url),
    );
    assert.equal(timelineResponse.headers.get("cache-control"), "no-store");
    const timeline = await timelineResponse.json() as { events: Array<{ type: string }> };
    assert.ok(timeline.events.some((event) => event.type === "greptile_comment"));

    const exported = await fetch(
      new URL("/api/sessions/devin-demo-cookiejar/export", running.url),
    );
    assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
    assert.ok((await exported.text()).includes("\"schemaVersion\": 1"));

    const analysisBefore = await (await fetch(
      new URL("/api/sessions/devin-demo-cookiejar/analysis", running.url),
    )).json() as { analysis: SessionAnalysis | null };
    assert.equal(analysisBefore.analysis, null);

    const analyzed = await (await fetch(
      new URL("/api/sessions/devin-demo-cookiejar/analysis", running.url),
      { method: "POST" },
    )).json() as { analysis: SessionAnalysis; stale: boolean };
    assert.equal(analyzed.analysis.insights[0]?.category, "premature_completion");
    assert.equal(analyzed.stale, false);
    assert.equal(analysisCalls, 1);

    const cached = await (await fetch(
      new URL("/api/sessions/devin-demo-cookiejar/analysis", running.url),
      { method: "POST" },
    )).json() as { analysis: SessionAnalysis; cached: boolean };
    assert.equal(cached.cached, true);
    assert.equal(analysisCalls, 1);

    const sessionsAfterAnalysis = await (await fetch(
      new URL("/api/sessions?repo=DevelopIQ-ai%2Fcookiejar", running.url),
    )).json() as { sessions: Array<{ analysisStatus: string; analysisInsightCount: number }> };
    assert.equal(sessionsAfterAnalysis.sessions[0]?.analysisStatus, "analyzed");
    assert.equal(sessionsAfterAnalysis.sessions[0]?.analysisInsightCount, 1);

    const analysisAfter = await (await fetch(
      new URL("/api/sessions/devin-demo-cookiejar/analysis", running.url),
    )).json() as { analysis: SessionAnalysis | null };
    assert.equal(analysisAfter.analysis?.session_id, "devin-demo-cookiejar");

    const reportBefore = await (await fetch(
      new URL("/api/reports/DevelopIQ-ai%2Fcookiejar", running.url),
    )).json() as { report: RepoFailureReport | null };
    assert.equal(reportBefore.report, null);

    const reported = await (await fetch(
      new URL("/api/reports/DevelopIQ-ai%2Fcookiejar", running.url),
      { method: "POST" },
    )).json() as { report: RepoFailureReport; url: string };
    assert.equal(reported.report.coverage.sessions_analyzed, 1);
    assert.equal(reported.report.failures[0]?.repro.prompt, "Assess whether this pull request is ready to merge and report the evidence.");
    assert.equal(reported.url, "/report?repo=DevelopIQ-ai%2Fcookiejar");

    const reportPage = await (await fetch(
      new URL("/report?repo=DevelopIQ-ai%2Fcookiejar", running.url),
    )).text();
    assert.ok(reportPage.includes("DevelopIQ-ai/cookiejar failures"));
    assert.ok(reportPage.includes("Test prompt"));
    assert.ok(reportPage.includes("Evidence and possible fix"));
    assert.equal(reportPage.includes("<script>"), false);
    assert.equal(reportPage.includes("<style>"), false);

    const reportExport = await fetch(
      new URL("/api/reports/DevelopIQ-ai%2Fcookiejar/export", running.url),
    );
    assert.match(reportExport.headers.get("content-disposition") ?? "", /gbird-report\.json/);

    const sync = await fetch(new URL("/api/sync", running.url), { method: "POST" });
    assert.equal(sync.status, 503);
    assert.ok((await sync.text()).includes("No agent sources are configured"));
  } finally {
    await running.close();
    store.close();
    if (priorKey === undefined) delete process.env.DEVIN_API_KEY;
    else process.env.DEVIN_API_KEY = priorKey;
    if (priorSecret === undefined) delete process.env.SECRET;
    else process.env.SECRET = priorSecret;
    if (priorOrg === undefined) delete process.env.DEVIN_ORG_ID;
    else process.env.DEVIN_ORG_ID = priorOrg;
    if (priorCodexRoot === undefined) delete process.env.CODEX_SESSIONS_ROOT;
    else process.env.CODEX_SESSIONS_ROOT = priorCodexRoot;
  }
});
