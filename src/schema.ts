import { createHash } from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AgentKind = "devin" | "codex";
export type EventSource = "devin" | "codex" | "tool" | "github" | "greptile" | "ci";

export interface PullRequestRef {
  url: string;
  state: string;
  repo: string | null;
  number: number | null;
}

export interface NormalizedSession {
  schemaVersion: 1;
  agent: AgentKind;
  id: string;
  title: string;
  prompt: string | null;
  status: string;
  statusDetail: string | null;
  origin: string | null;
  startedAt: string;
  updatedAt: string;
  acusConsumed: number;
  url: string | null;
  repositories: string[];
  pullRequests: PullRequestRef[];
  tags: string[];
  raw: JsonObject;
}

export interface TimelineEvent {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  repo: string | null;
  occurredAt: string;
  source: EventSource;
  type: string;
  title: string;
  status: string | null;
  commitSha: string | null;
  path: string | null;
  url: string | null;
  data: JsonObject;
}

export interface SessionTimeline {
  session: NormalizedSession;
  events: TimelineEvent[];
}

export type AnalysisOutcomeStatus = "completed" | "partial" | "failed" | "abandoned" | "unknown";
export type AnalysisSeverity = "low" | "medium" | "high" | "critical";
export type TokenMeasurement = "exact" | "lower_bound" | "unavailable";
export type TimeMeasurement = "exact" | "elapsed_span" | "lower_bound" | "unavailable";

export interface AnalysisEvidence {
  event_id: string;
  occurred_at: string | null;
  kind: "message" | "tool_call" | "tool_result" | "edit" | "test" | "review" | "other";
  summary: string;
}

export interface AnalysisWaste {
  tokens: number | null;
  token_measurement: TokenMeasurement;
  seconds: number | null;
  time_measurement: TimeMeasurement;
  event_ids: string[];
}

export interface AnalysisReplay {
  task: string;
  setup: string[];
  failure_condition: string;
  success_condition: string;
}

export interface SessionInsight {
  id: string;
  category: string;
  title: string;
  severity: AnalysisSeverity;
  confidence: number;
  observed: string;
  why_it_matters: string;
  evidence: AnalysisEvidence[];
  waste: AnalysisWaste;
  hypothesis: string;
  counterevidence: string[];
  replay: AnalysisReplay | null;
}

export interface SessionAnalysis {
  analysis_schema_version: 1;
  session_id: string;
  repo: string | null;
  outcome: {
    status: AnalysisOutcomeStatus;
    summary: string;
    evidence_event_ids: string[];
  };
  coverage: {
    events_total: number;
    events_reviewed: number;
    events_with_token_usage: number;
    events_with_timing: number;
    limitations: string[];
  };
  insights: SessionInsight[];
  totals: {
    wasted_tokens: number | null;
    token_measurement: TokenMeasurement;
    wasted_seconds: number | null;
    time_measurement: TimeMeasurement;
    notes: string[];
  };
}

export interface StoredSessionAnalysis {
  sessionId: string;
  inputHash: string;
  analyzer: string;
  createdAt: string;
  analysis: SessionAnalysis;
}

export interface RepoAnalysisSession {
  session: Pick<NormalizedSession, "id" | "agent" | "title" | "status" | "startedAt" | "url">;
  analysis: SessionAnalysis;
}

export interface RepoReportInput {
  repo: string;
  source_repositories: string[];
  sessions: RepoAnalysisSession[];
}

export interface RepoFailureOccurrence {
  session_id: string;
  session_title: string;
  agent: AgentKind;
  insight_id: string;
  observed: string;
  evidence_event_ids: string[];
}

export interface RepoFailure {
  id: string;
  title: string;
  category: string;
  severity: AnalysisSeverity;
  confidence: number;
  classification: "recurring" | "single_occurrence";
  summary: string;
  why_it_matters: string;
  historical_session_count: number;
  historical_occurrence_count: number;
  occurrences: RepoFailureOccurrence[];
  repro: {
    prompt: string;
    setup: string[];
    failure_condition: string;
    success_condition: string;
  };
  suggested_guardrail: string;
}

export interface RepoFailureReport {
  report_schema_version: 1;
  repo: string;
  source_repositories: string[];
  coverage: {
    sessions_discovered: number;
    sessions_analyzed: number;
    sessions_with_failures: number;
    input_insights: number;
    included_insights: number;
  };
  failures: RepoFailure[];
  limitations: string[];
}

export interface StoredRepoReport {
  repo: string;
  inputHash: string;
  analyzer: string;
  createdAt: string;
  report: RepoFailureReport;
}

export function stableId(...parts: Array<string | number | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u001f"))
    .digest("hex")
    .slice(0, 24);
}

export function isoTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return new Date(0).toISOString();
}

export function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function parsePullRequestUrl(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { repo: match[1], number: Number(match[2]) };
}
