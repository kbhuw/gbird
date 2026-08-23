import assert from "node:assert/strict";
import test from "node:test";
import { renderRepoReportHtml } from "../src/report-html.js";
import { applyBlindReproductions, verificationCounts } from "../src/reproduction.js";
import type { BlindReproductionInput, RepoFailure, RepoFailureReport, ReproductionBundle } from "../src/schema.js";

function failure(id: string): RepoFailure {
  return {
    id,
    title: "Agent guessed the setup command",
    category: "tool_problem",
    severity: "medium",
    confidence: 0.9,
    classification: "single_occurrence",
    summary: "The agent guessed before reading the repository instructions.",
    why_it_matters: "Setup failed before useful work began.",
    historical_session_count: 1,
    historical_occurrence_count: 1,
    occurrences: [{
      session_id: `session-${id}`,
      session_title: "Set up the project",
      agent: "codex",
      insight_id: "insight-001",
      observed: "The first setup command was unsupported.",
      evidence_event_ids: ["event-001"],
    }],
    repro: {
      prompt: "Set up this repository and run its smoke test.",
      setup: ["Use a clean checkout."],
      failure_condition: "An unsupported command is run before repository instructions are read.",
      success_condition: "Repository instructions are read before choosing the successful command.",
    },
    suggested_guardrail: "Document one setup command.",
  };
}

function report(): RepoFailureReport {
  return {
    report_schema_version: 1,
    repo: "acme/repo",
    source_repositories: ["acme/repo"],
    coverage: { sessions_discovered: 2, sessions_analyzed: 2, sessions_with_failures: 2, input_insights: 2, included_insights: 2 },
    failures: [failure("failure-001"), failure("failure-002")],
    limitations: [],
  };
}

function attempt(failureId: string, outcome: "reproduced" | "not_reproduced" | "inconclusive", suffix = "1"): BlindReproductionInput {
  return {
    failure_id: failureId,
    attempt_id: `${failureId}-attempt-${suffix}`,
    checkout_sha: "abc123",
    agent: "codex-subagent",
    task_outcome: outcome === "inconclusive" ? "blocked" : "completed",
    summary: "The blind worker attempted the neutral task.",
    observed_actions: ["Read package.json and ran the smoke test."],
    evidence: ["The command result was recorded."],
    failure_condition_observed: outcome === "reproduced",
    success_condition_observed: outcome === "not_reproduced",
    evaluation: "The parent compared the trace with the hidden conditions.",
    limitations: outcome === "inconclusive" ? ["The dependency service was unavailable."] : [],
  };
}

function bundle(results: BlindReproductionInput[]): ReproductionBundle {
  return {
    verification_schema_version: 1,
    repo: "acme/repo",
    verified_at: "2026-08-23T12:00:00.000Z",
    checkout_sha: "abc123",
    results,
  };
}

test("merges blind reproduction verdicts into the final report", () => {
  const verified = applyBlindReproductions(report(), bundle([
    attempt("failure-001", "reproduced"),
    attempt("failure-002", "not_reproduced"),
  ]));
  assert.equal(verified.failures[0]?.verification?.status, "reproduced");
  assert.equal(verified.failures[1]?.verification?.status, "not_reproduced");
  assert.deepEqual(verificationCounts(verified), { reproduced: 1, not_reproduced: 1, inconclusive: 0, not_run: 0 });

  const html = renderRepoReportHtml({
    repo: verified.repo,
    inputHash: "hash",
    analyzer: "test",
    createdAt: "2026-08-23T12:00:00.000Z",
    report: verified,
  });
  assert.ok(html.includes("Reproduced by a fresh agent"));
  assert.ok(html.includes("Not reproduced by a fresh agent"));
  assert.ok(html.includes("Blind replay evidence"));
});

test("requires every failure and retries a lone inconclusive result", () => {
  assert.throws(
    () => applyBlindReproductions(report(), bundle([attempt("failure-001", "reproduced")])),
    /failure-002 has no blind reproduction attempt/,
  );
  assert.throws(
    () => applyBlindReproductions(report(), bundle([
      attempt("failure-001", "inconclusive"),
      attempt("failure-002", "not_reproduced"),
    ])),
    /needs a second blind attempt/,
  );

  const verified = applyBlindReproductions(report(), bundle([
    attempt("failure-001", "inconclusive", "1"),
    attempt("failure-001", "inconclusive", "2"),
    attempt("failure-002", "not_reproduced"),
  ]));
  assert.equal(verified.failures[0]?.verification?.status, "inconclusive");
});
