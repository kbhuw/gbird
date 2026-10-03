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
