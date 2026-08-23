import {
  asJsonObject,
  isoTimestamp,
  parsePullRequestUrl,
  stableId,
  type JsonObject,
  type NormalizedSession,
  type TimelineEvent,
} from "./schema.js";

interface DevinPullRequest {
  pr_state?: string;
  pr_url?: string;
}

export interface DevinSessionResponse {
  session_id: string;
  title?: string | null;
  status?: string | null;
  status_detail?: string | null;
  origin?: string | null;
  created_at?: number | string;
  updated_at?: number | string;
  acus_consumed?: number | null;
  url?: string | null;
  tags?: string[] | null;
  pull_requests?: DevinPullRequest[] | null;
  structured_output?: unknown;
  [key: string]: unknown;
}

export interface DevinMessageResponse {
  event_id?: string | null;
  created_at?: number | string;
  message?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

interface CursorResponse<T> {
  items: T[];
  end_cursor?: string | null;
  has_next_page?: boolean;
}

export interface DevinConfig {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
}

export class DevinClient {
  private readonly apiKey: string;
  private readonly orgId: string;
  private readonly baseUrl: string;

  constructor(config: DevinConfig) {
    this.apiKey = config.apiKey;
    this.orgId = config.orgId;
    this.baseUrl = config.baseUrl ?? "https://api.devin.ai";
  }

  private async get<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Devin API ${response.status}: ${body.slice(0, 300)}`);
    }
    return await response.json() as T;
  }

  private async listPages<T>(pathname: string, limit: number): Promise<T[]> {
    const items: T[] = [];
    let after: string | null = null;
    do {
      const remaining = Math.max(1, Math.min(200, limit - items.length));
      const params: Record<string, string> = { first: String(remaining) };
      if (after) params.after = after;
      const page = await this.get<CursorResponse<T>>(pathname, params);
      items.push(...page.items);
      after = page.has_next_page && page.end_cursor && items.length < limit
        ? page.end_cursor
        : null;
    } while (after && items.length < limit);
    return items.slice(0, limit);
  }

  listSessions(limit = 50): Promise<DevinSessionResponse[]> {
    return this.listPages<DevinSessionResponse>(
      `/v3/organizations/${encodeURIComponent(this.orgId)}/sessions`,
      limit,
    );
  }

  listMessages(sessionId: string, limit = 2_000): Promise<DevinMessageResponse[]> {
    return this.listPages<DevinMessageResponse>(
      `/v3/organizations/${encodeURIComponent(this.orgId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      limit,
    );
  }
}

function repoFromTag(tag: string): string | null {
  const match = /^repo:([^/\s]+\/[^/\s]+)$/i.exec(tag.trim());
  return match?.[1] ?? null;
}

function reposFromText(text: string): string[] {
  const repos = new Set<string>();
  const patterns = [
    /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/gi,
    /["']full_name["']\s*:\s*["']([\w.-]+)\/([\w.-]+)["']/gi,
    /\b(?:repository|repo)\s*[:=]\s*["']?([\w.-]+)\/([\w.-]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) repos.add(`${match[1]}/${match[2]}`);
  }
  return [...repos];
}

function sourceTitle(source: string): string {
  if (source === "user") return "You";
  if (source === "devin") return "Model";
  return `${source || "Session"} message`;
}

export function normalizeDevinSession(
  rawSession: DevinSessionResponse,
  rawMessages: DevinMessageResponse[],
): { session: NormalizedSession; events: TimelineEvent[] } {
  const sessionId = rawSession.session_id;
  const pullRequests = (rawSession.pull_requests ?? [])
    .filter((pullRequest): pullRequest is Required<Pick<DevinPullRequest, "pr_url">> & DevinPullRequest =>
      typeof pullRequest.pr_url === "string" && pullRequest.pr_url.length > 0)
    .map((pullRequest) => {
      const parsed = parsePullRequestUrl(pullRequest.pr_url);
      return {
        url: pullRequest.pr_url,
        state: pullRequest.pr_state ?? "unknown",
        repo: parsed?.repo ?? null,
        number: parsed?.number ?? null,
      };
    });
  const messages = [...rawMessages].sort((a, b) =>
    isoTimestamp(a.created_at).localeCompare(isoTimestamp(b.created_at)));
  const firstUserMessage = messages.find((message) => message.source === "user" && message.message)?.message ?? null;
  const repositories = [...new Set([
    ...pullRequests.map((pullRequest) => pullRequest.repo).filter((repo): repo is string => Boolean(repo)),
    ...(rawSession.tags ?? []).map(repoFromTag).filter((repo): repo is string => Boolean(repo)),
    ...reposFromText([rawSession.title ?? "", ...messages.map((message) => message.message ?? "")].join("\n")),
  ])].sort();
  const startedAt = isoTimestamp(rawSession.created_at);
  const updatedAt = isoTimestamp(rawSession.updated_at ?? rawSession.created_at);
  const session: NormalizedSession = {
    schemaVersion: 1,
    agent: "devin",
    id: sessionId,
    title: rawSession.title?.trim() || firstUserMessage?.split("\n")[0]?.slice(0, 120) || "Untitled Devin session",
    prompt: firstUserMessage,
    status: rawSession.status ?? "unknown",
    statusDetail: rawSession.status_detail ?? null,
    origin: rawSession.origin ?? null,
    startedAt,
    updatedAt,
    acusConsumed: Number(rawSession.acus_consumed ?? 0),
    url: rawSession.url ?? null,
    repositories,
    pullRequests,
    tags: rawSession.tags ?? [],
    raw: asJsonObject(rawSession),
  };
  const primaryRepo = repositories.length === 1 ? repositories[0]! : null;
  const events: TimelineEvent[] = [
    {
      schemaVersion: 1,
      id: stableId("devin", sessionId, "session_started"),
      sessionId,
      repo: primaryRepo,
      occurredAt: startedAt,
      source: "devin",
      type: "session_started",
      title: "Session started",
      status: "started",
      commitSha: null,
      path: null,
      url: rawSession.url ?? null,
      data: {
        origin: rawSession.origin ?? null,
        tags: rawSession.tags ?? [],
      },
    },
  ];

  for (const [index, message] of messages.entries()) {
    const source = message.source ?? "unknown";
    const occurredAt = isoTimestamp(message.created_at);
    const eventId = message.event_id || stableId(sessionId, "message", occurredAt, index);
    events.push({
      schemaVersion: 1,
      id: stableId("devin", sessionId, eventId),
      sessionId,
      repo: primaryRepo,
      occurredAt,
      source: "devin",
      type: "message_created",
      title: sourceTitle(source),
      status: null,
      commitSha: null,
      path: null,
      url: rawSession.url ?? null,
      data: {
        message: message.message ?? "",
        messageSource: source,
        eventId,
      },
    });
  }

  events.push({
    schemaVersion: 1,
    id: stableId("devin", sessionId, "session_updated", updatedAt, rawSession.status),
    sessionId,
    repo: primaryRepo,
    occurredAt: updatedAt,
    source: "devin",
    type: "session_updated",
    title: rawSession.status === "finished" ? "Session finished" : "Session updated",
    status: rawSession.status ?? "unknown",
    commitSha: null,
    path: null,
    url: rawSession.url ?? null,
    data: {
      status: rawSession.status ?? "unknown",
      statusDetail: rawSession.status_detail ?? null,
      acusConsumed: Number(rawSession.acus_consumed ?? 0),
      structuredOutput: (rawSession.structured_output ?? null) as JsonObject | null,
    },
  });

  return { session, events };
}
