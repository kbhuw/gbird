import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexSkillAnalyzer } from "../src/analyzer.js";
import type { SessionTimeline } from "../src/schema.js";

test("retries one session when an analysis cites an unknown event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbird-analyzer-"));
  const executable = path.join(root, "fake-codex.cjs");
  const counter = path.join(root, "attempts.txt");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const resultPath = process.argv[process.argv.indexOf("--output-last-message") + 1];
const counterPath = ${JSON.stringify(counter)};
const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) + 1 : 1;
fs.writeFileSync(counterPath, String(attempt));
const base = {
  analysis_schema_version: 1,
  session_id: "session-1",
  repo: "acme/repo",
  outcome: { status: "unknown", summary: "No verified outcome.", evidence_event_ids: [] },
  coverage: { events_total: 1, events_reviewed: 1, events_with_token_usage: 0, events_with_timing: 0, limitations: [] },
  insights: [],
  totals: { wasted_tokens: 0, token_measurement: "exact", wasted_seconds: 0, time_measurement: "exact", notes: [] }
};
if (attempt === 1) {
  base.insights = [{
    id: "insight-001",
    category: "tool_problem",
    title: "Bad reference",
    severity: "low",
    confidence: 0.8,
    observed: "The output used the wrong event reference.",
    why_it_matters: "The evidence cannot be checked.",
    evidence: [{ event_id: "not-a-real-event", occurred_at: null, kind: "other", summary: "Invalid reference" }],
    waste: { tokens: null, token_measurement: "unavailable", seconds: null, time_measurement: "unavailable", event_ids: [] },
    hypothesis: "The analysis copied an event ID incorrectly.",
    counterevidence: [],
    replay: null
  }];
  base.totals = { wasted_tokens: null, token_measurement: "unavailable", wasted_seconds: null, time_measurement: "unavailable", notes: [] };
}
fs.writeFileSync(resultPath, JSON.stringify(base));
`);
  fs.chmodSync(executable, 0o755);

  const timeline: SessionTimeline = {
    session: {
      schemaVersion: 1,
      agent: "codex",
      id: "session-1",
      title: "Test",
      prompt: "Test the repository.",
      status: "completed",
      statusDetail: null,
      origin: "Codex",
      startedAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      acusConsumed: 0,
      url: null,
      repositories: ["acme/repo"],
      pullRequests: [],
      tags: [],
      raw: {},
    },
    events: [{
      schemaVersion: 1,
      id: "event-1",
      sessionId: "session-1",
      repo: "acme/repo",
      occurredAt: "2026-08-23T00:00:00.000Z",
      source: "codex",
      type: "session_started",
      title: "Session started",
      status: "started",
      commitSha: null,
      path: null,
      url: null,
      data: {},
    }],
  };

  try {
    const analyze = createCodexSkillAnalyzer({
      projectRoot: root,
      skillPath: path.resolve("skills/coding-session-analyst"),
      executable,
    });
    const result = await analyze(timeline);
    assert.equal(result.insights.length, 0);
    assert.equal(fs.readFileSync(counter, "utf8"), "2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
