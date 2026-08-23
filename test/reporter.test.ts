import assert from "node:assert/strict";
import test from "node:test";
import { assertRepoReport } from "../src/reporter.js";
import type { AgentKind, RepoFailureReport, RepoReportInput, SessionAnalysis } from "../src/schema.js";

function analyzedSession(id: string, agent: AgentKind): RepoReportInput["sessions"][number] {
  const eventId = `${id}-event`;
  const analysis: SessionAnalysis = {
    analysis_schema_version: 1,
    session_id: id,
    repo: "acme/repo",
    outcome: { status: "partial", summary: "The task recovered after a failed setup command.", evidence_event_ids: [eventId] },
    coverage: { events_total: 1, events_reviewed: 1, events_with_token_usage: 0, events_with_timing: 1, limitations: [] },
    insights: [{
      id: "insight-001",
      category: "tool_problem",
      title: "The wrong setup command was attempted",
      severity: "medium",
      confidence: 0.94,
      observed: "The agent ran an unsupported package-manager command before reading repository configuration.",
      why_it_matters: "Fresh setup failed avoidably.",
      evidence: [{ event_id: eventId, occurred_at: "2026-08-23T12:00:00.000Z", kind: "tool_result", summary: "The setup command failed." }],
      waste: { tokens: null, token_measurement: "unavailable", seconds: null, time_measurement: "unavailable", event_ids: [eventId] },
      hypothesis: "The agent may guess setup commands before inspecting repository configuration.",
      counterevidence: [],
      replay: {
        task: "Set up this repository and run its smoke test.",
        setup: ["Use a fresh checkout."],
        failure_condition: "An unsupported setup command is run before repository configuration is inspected.",
        success_condition: "The intended setup workflow succeeds without the historical command failure.",
      },
    }],
    totals: { wasted_tokens: null, token_measurement: "unavailable", wasted_seconds: null, time_measurement: "unavailable", notes: [] },
  };
  return {
    session: { id, agent, title: `Setup ${id}`, status: "completed", startedAt: "2026-08-23T12:00:00.000Z", url: null },
    analysis,
  };
}

test("requires every session insight to appear exactly once in a repo report", () => {
  const input: RepoReportInput = { repo: "acme/repo", source_repositories: ["acme/repo"], sessions: [analyzedSession("one", "devin"), analyzedSession("two", "codex")] };
  const occurrences = input.sessions.map((item) => ({
    session_id: item.session.id,
    session_title: item.session.title,
    agent: item.session.agent,
    insight_id: "insight-001",
    observed: item.analysis.insights[0]!.observed,
    evidence_event_ids: item.analysis.insights[0]!.evidence.map((event) => event.event_id),
  }));
  const report: RepoFailureReport = {
    report_schema_version: 1,
    repo: input.repo,
    source_repositories: input.source_repositories,
    coverage: { sessions_discovered: 2, sessions_analyzed: 2, sessions_with_failures: 2, input_insights: 2, included_insights: 2 },
    failures: [{
      id: "failure-001",
      title: "Agents guess the repository setup command",
      category: "tool_problem",
      severity: "medium",
      confidence: 0.94,
      classification: "recurring",
      summary: "Two fresh setup sessions began with an unsupported package-manager command.",
      why_it_matters: "Setup fails before useful work begins.",
      historical_session_count: 2,
      historical_occurrence_count: 2,
      occurrences,
      repro: {
        prompt: "Set up this repository from a fresh checkout and run its smallest smoke test. Report the commands and results.",
        setup: ["Use the latest default branch."],
        failure_condition: "The fresh agent runs an unsupported setup command before inspecting repository configuration.",
        success_condition: "The fresh agent uses the intended setup workflow without the historical failure.",
      },
      suggested_guardrail: "Document and enforce one setup entrypoint.",
    }],
    limitations: ["The latest checkout has not been replayed."],
  };

  assert.doesNotThrow(() => assertRepoReport(input, report));
  const omitted = structuredClone(report);
  omitted.failures[0]!.occurrences.pop();
  omitted.failures[0]!.historical_occurrence_count = 1;
  omitted.failures[0]!.historical_session_count = 1;
  omitted.failures[0]!.classification = "single_occurrence";
  omitted.coverage.included_insights = 1;
  assert.throws(() => assertRepoReport(input, omitted), /omitted 1 input insight/);
});
