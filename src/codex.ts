import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isoTimestamp,
  stableId,
  type JsonObject,
  type NormalizedSession,
  type TimelineEvent,
} from "./schema.js";
import { TimelineStore } from "./store.js";

interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface CodexSyncSummary {
  files: number;
  sessions: number;
  events: number;
  skippedLines: number;
}

export interface CodexSyncOptions {
  store: TimelineStore;
  limit?: number;
  roots?: string[];
}

type RepoResolver = (cwd: string) => string;

const repoCache = new Map<string, string>();

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanMessage(value: unknown): string {
  return text(value)
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, "")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "")
    .trim();
}

function isSyntheticMessage(message: string): boolean {
  return /^(?:You are working inside Conductor,|Respond directly to the user's prompt\.|Use only the executor[_ ]cloud MCP server\.|<codexdelegation>)/i.test(message);
}

function titleFromMessage(message: string): string {
  const candidates = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const selected = candidates.find((line) => !/^(?:\[?https?:\/\/|<)/i.test(line)) ?? candidates[0] ?? "Untitled Codex task";
  return selected
    .replace(/^#+\s*/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .slice(0, 100);
}

function modelTitle(model: string): string {
  if (!model) return "OpenAI";
  return model
    .split("-")
    .map((part) => part.length <= 3 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function repositoryForCwd(cwd: string): string {
  const cached = repoCache.get(cwd);
  if (cached) return cached;
  let repo = path.basename(cwd) || "unlinked";
  try {
    const remote = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    if (match?.[1]) repo = match[1];
  } catch {
    // Projectless Codex tasks use their local workspace folder as the filter key.
  }
  repoCache.set(cwd, repo);
  return repo;
}

function relativeFile(filename: string, cwd: string): string {
  const relative = path.relative(cwd, filename);
  return relative && !relative.startsWith("..") ? relative : filename;
}

function toolCategory(input: string): string {
  if (/apply_patch|patch_apply/i.test(input)) return "code";
  if (/web__run|search_query|web_search/i.test(input)) return "web";
  if (/mcp__node_repl|agent\.browsers|\.playwright|\bsky\./i.test(input)) return "browser";
  if (/collaboration\.|spawn_agent|followup_task/i.test(input)) return "agent";
  if (/exec_command|write_stdin|read_thread_terminal/i.test(input)) return "shell";
  return "tool";
}

function toolTitle(category: string): string {
  return ({
    agent: "Agent task",
    browser: "Browser action",
    code: "Code edit",
    shell: "Shell command",
    web: "Web search",
    tool: "Tool call",
  })[category] ?? "Tool call";
}

function durationMs(payload: Record<string, unknown>): number | null {
  const direct = numberValue(payload.duration_ms);
  if (direct !== null) return direct;
  const duration = object(payload.duration);
  const seconds = numberValue(duration.secs);
  const nanos = numberValue(duration.nanos);
  if (seconds === null && nanos === null) return null;
  return Math.round((seconds ?? 0) * 1_000 + (nanos ?? 0) / 1_000_000);
}

export function normalizeCodexRollout(
  records: CodexRecord[],
  filename: string,
  resolveRepo: RepoResolver = repositoryForCwd,
): { session: NormalizedSession; events: TimelineEvent[] } | null {
  const metaRecord = records.find((record) => record.type === "session_meta");
  if (!metaRecord) return null;
  const meta = object(metaRecord.payload);
  const rawId = text(meta.id) || text(meta.session_id);
  if (!rawId) return null;
  const sessionId = `codex:${rawId}`;
  const startedAt = isoTimestamp(metaRecord.timestamp || meta.timestamp);
  let updatedAt = startedAt;
  let currentCwd = text(meta.cwd) || path.dirname(filename);
  let currentRepo = resolveRepo(currentCwd);
  let currentModel = "";
  let lastTaskState = "completed";
  let statusDetail: string | null = null;
  let firstUserMessage: string | null = null;
  const repositories = new Set<string>([currentRepo]);
  const events: TimelineEvent[] = [];

  const addEvent = (
    index: number,
    record: CodexRecord,
    source: TimelineEvent["source"],
    type: string,
    title: string,
    status: string | null,
    data: JsonObject,
    eventPath: string | null = null,
  ): void => {
    const occurredAt = isoTimestamp(record.timestamp || startedAt);
    events.push({
      schemaVersion: 1,
      id: stableId("codex", rawId, index, type, occurredAt),
      sessionId,
      repo: currentRepo,
      occurredAt,
      source,
      type,
      title,
      status,
      commitSha: null,
      path: eventPath,
      url: null,
      data,
    });
  };

  addEvent(0, metaRecord, "codex", "session_started", "Session started", "started", {
    originator: text(meta.originator) || null,
    source: text(meta.source) || null,
    modelProvider: text(meta.model_provider) || null,
  });

  for (const [index, record] of records.entries()) {
    if (record.timestamp && isoTimestamp(record.timestamp) > updatedAt) updatedAt = isoTimestamp(record.timestamp);
    const payload = object(record.payload);
    if (record.type === "turn_context") {
      const nextCwd = text(payload.cwd);
      if (nextCwd) {
        currentCwd = nextCwd;
        currentRepo = resolveRepo(currentCwd);
        repositories.add(currentRepo);
      }
      currentModel = text(payload.model) || currentModel;
      continue;
    }

    if (record.type === "response_item") {
      const subtype = text(payload.type);
      if (subtype !== "custom_tool_call" && subtype !== "function_call") continue;
      const input = text(payload.input) || text(payload.arguments);
      const category = toolCategory(input);
      if (["browser", "code", "web"].includes(category)) continue;
      addEvent(index, record, "tool", "tool_call", toolTitle(category), text(payload.status) || "completed", {
        toolCategory: category,
        toolName: text(payload.name) || null,
        callId: text(payload.call_id) || null,
      });
      continue;
    }

    if (record.type !== "event_msg") continue;
    const subtype = text(payload.type);
    if (subtype === "task_started") {
      lastTaskState = "active";
      statusDetail = text(payload.turn_id) || null;
      addEvent(index, record, "codex", "turn_started", "Turn started", "active", {
        turnId: text(payload.turn_id) || null,
        model: currentModel || null,
      });
    } else if (subtype === "task_complete") {
      lastTaskState = "completed";
      statusDetail = null;
      addEvent(index, record, "codex", "turn_completed", "Turn completed", "completed", {
        turnId: text(payload.turn_id) || null,
        durationMs: durationMs(payload),
        timeToFirstTokenMs: numberValue(payload.time_to_first_token_ms),
      });
    } else if (subtype === "turn_aborted") {
      lastTaskState = "aborted";
      statusDetail = text(payload.reason) || null;
      addEvent(index, record, "codex", "turn_aborted", "Turn aborted", "failure", {
        turnId: text(payload.turn_id) || null,
        reason: text(payload.reason) || null,
        durationMs: durationMs(payload),
      });
    } else if (subtype === "user_message") {
      const message = cleanMessage(payload.message);
      if (!message || isSyntheticMessage(message)) continue;
      firstUserMessage ??= message;
      addEvent(index, record, "codex", "message_created", "You", null, {
        message,
        messageSource: "user",
      });
    } else if (subtype === "agent_message") {
      const message = cleanMessage(payload.message);
      if (!message) continue;
      addEvent(index, record, "codex", "message_created", modelTitle(currentModel), null, {
        message,
        messageSource: "codex",
        model: currentModel || null,
        phase: text(payload.phase) || null,
      });
    } else if (subtype === "mcp_tool_call_end") {
      const invocation = object(payload.invocation);
      const argumentsObject = object(invocation.arguments);
      const label = text(argumentsObject.title) || `${text(invocation.server) || "Tool"} · ${text(invocation.tool) || "call"}`;
      addEvent(index, record, "tool", "tool_call", label.slice(0, 100), "completed", {
        toolCategory: text(invocation.server) === "node_repl" ? "browser" : "tool",
        server: text(invocation.server) || null,
        toolName: text(invocation.tool) || null,
        callId: text(payload.call_id) || null,
        durationMs: durationMs(payload),
        readOnly: typeof payload.read_only_hint === "boolean" ? payload.read_only_hint : null,
      });
    } else if (subtype === "web_search_end") {
      const results = Array.isArray(payload.results) ? payload.results : [];
      addEvent(index, record, "tool", "web_search", "Web search", "completed", {
        toolCategory: "web",
        query: text(payload.query) || null,
        resultCount: results.length,
      });
    } else if (subtype === "patch_apply_end") {
      const changes = object(payload.changes);
      const files = Object.keys(changes).map((file) => relativeFile(file, currentCwd));
      const succeeded = payload.success === true;
      addEvent(index, record, "tool", "code_changed", files.length === 1 ? `Changed ${files[0]}` : `Changed ${files.length} files`, succeeded ? "success" : "failure", {
        toolCategory: "code",
        files,
        fileCount: files.length,
      }, files[0] ?? null);
    } else if (subtype === "context_compacted") {
      addEvent(index, record, "codex", "context_compacted", "Context compacted", "completed", {});
    }
  }

  const session: NormalizedSession = {
    schemaVersion: 1,
    agent: "codex",
    id: sessionId,
    title: titleFromMessage(firstUserMessage ?? path.basename(currentCwd)),
    prompt: firstUserMessage,
    status: lastTaskState,
    statusDetail,
    origin: text(meta.originator) || text(meta.source) || "Codex",
    startedAt,
    updatedAt,
    acusConsumed: 0,
    url: null,
    repositories: [...repositories].sort(),
    pullRequests: [],
    tags: [currentModel ? `model:${currentModel}` : ""].filter(Boolean),
    raw: {
      rolloutPath: filename,
      cwd: text(meta.cwd) || null,
      originator: text(meta.originator) || null,
      source: text(meta.source) || null,
      cliVersion: text(meta.cli_version) || null,
      modelProvider: text(meta.model_provider) || null,
    },
  };
  return {
    session,
    events: events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)),
  };
}

function jsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(filename);
    }
  };
  visit(root);
  return files;
}

function readJsonl(filename: string): { records: CodexRecord[]; skipped: number } {
  const records: CodexRecord[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CodexRecord);
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

export async function syncCodexTimeline(options: CodexSyncOptions): Promise<CodexSyncSummary> {
  const roots = options.roots ?? [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions"),
  ];
  const files = roots.flatMap(jsonlFiles)
    .map((filename) => ({ filename, modifiedAt: fs.statSync(filename).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, options.limit ?? 50);
  let sessions = 0;
  let events = 0;
  let skippedLines = 0;
  for (const file of files) {
    const parsed = readJsonl(file.filename);
    skippedLines += parsed.skipped;
    const normalized = normalizeCodexRollout(parsed.records, file.filename);
    if (!normalized) continue;
    options.store.upsertSession(normalized.session);
    options.store.replaceEvents(normalized.session.id, normalized.events);
    sessions += 1;
    events += normalized.events.length;
  }
  return { files: files.length, sessions, events, skippedLines };
}
