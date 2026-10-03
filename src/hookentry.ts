// gbird hook runtime — self-contained (no imports outside node builtins) so the
// compiled single file can be copied onto any agent machine as gbird-hook.mjs.
//
//   node gbird-hook.mjs record            append one hook stdin payload to the live log
//   node gbird-hook.mjs collect           fold live logs into sessions/<agent>/<id>.json
//   node gbird-hook.mjs ship [session-id] collect one session and push it to GBIRD_REPO
//
// Agent kind comes from GBIRD_AGENT (default "devin"). Store from GBIRD_DIR
// (default ~/.gbird). Every failure is swallowed: hooks must never break a session.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type JsonObject = Record<string, unknown>;
type AgentKind = "devin" | "codex";

interface TimelineEvent {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  repo: string | null;
  occurredAt: string;
  source: string;
  type: string;
  title: string;
  status: string | null;
  commitSha: string | null;
  path: string | null;
  url: string | null;
  data: JsonObject;
}

interface NormalizedSession {
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
  pullRequests: Array<{ url: string; state: string; repo: string | null; number: number | null }>;
  tags: string[];
  raw: JsonObject;
}

function storeDir(): string {
  return path.resolve(process.env.GBIRD_DIR ?? path.join(os.homedir(), ".gbird"));
}

function agentKind(): AgentKind {
  return process.env.GBIRD_AGENT === "codex" ? "codex" : "devin";
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function stableId(...parts: Array<string | number | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u001f"))
    .digest("hex")
    .slice(0, 24);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function livePath(sessionId: string): string {
  return path.join(storeDir(), "live", agentKind(), `${safeName(sessionId)}.jsonl`);
}

function baseEvent(payload: JsonObject, sessionId: string): Omit<TimelineEvent, "id" | "type" | "title" | "status" | "data"> {
  const occurredAt = typeof payload.occurred_at === "string" && !Number.isNaN(Date.parse(payload.occurred_at))
    ? new Date(payload.occurred_at).toISOString()
    : new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId,
    repo: null,
    occurredAt,
    source: "hook",
    commitSha: null,
    path: null,
    url: null,
  };
}

/** Map one hook stdin payload to a TimelineEvent. */
function toTimelineEvent(payload: JsonObject): TimelineEvent | null {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return null;
  const eventName = String(payload.hook_event_name ?? "unknown");
  const base = baseEvent(payload, sessionId);
  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  const shared: JsonObject = { promptId, hookEvent: eventName };

  switch (eventName) {
    case "SessionStart":
      return { ...base, id: stableId(sessionId, "session_start"), type: "session_started", title: "Session started", status: "started", data: shared };
    case "UserPromptSubmit": {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      return {
        ...base,
        id: stableId(sessionId, promptId ?? base.occurredAt, "prompt"),
        type: "message_created",
        title: "You",
        status: null,
        data: { ...shared, message: prompt, messageSource: "user" },
      };
    }
    case "PreToolUse":
    case "PostToolUse": {
      const toolName = String(payload.tool_name ?? "tool");
      const input = (payload.tool_input ?? {}) as JsonObject;
      const response = (payload.tool_response ?? null) as JsonObject | null;
      const failed = eventName === "PostToolUse" && response?.success === false;
      const title = typeof input.command === "string" && input.command
        ? `$ ${input.command.slice(0, 80)}`
        : toolName;
      return {
        ...base,
        id: stableId(sessionId, base.occurredAt, toolName, JSON.stringify(input).slice(0, 200), eventName),
        type: eventName === "PreToolUse" ? "tool_call_started" : "tool_call",
        title,
        status: failed ? "failure" : "success",
        data: { ...shared, toolName, toolInput: input, toolResponse: response },
      };
    }
    case "PermissionRequest":
      return {
        ...base,
        id: stableId(sessionId, base.occurredAt, "permission"),
        type: "permission_request",
        title: `Permission: ${String(payload.tool_name ?? "tool")}`,
        status: null,
        data: { ...shared, toolName: payload.tool_name ?? null, toolInput: payload.tool_input ?? null },
      };
    case "Stop":
      return { ...base, id: stableId(sessionId, base.occurredAt, "stop"), type: "turn_stopped", title: "Turn stopped", status: null, data: shared };
    case "PostCompaction":
      return { ...base, id: stableId(sessionId, base.occurredAt, "compaction"), type: "context_compacted", title: "Context compacted", status: null, data: shared };
    case "SessionEnd":
      return {
        ...base,
        id: stableId(sessionId, "session_end", String(payload.reason ?? "")),
        type: "session_ended",
        title: "Session ended",
        status: typeof payload.reason === "string" ? payload.reason : "ended",
        data: { ...shared, reason: payload.reason ?? null },
      };
    default:
      return { ...base, id: stableId(sessionId, base.occurredAt, eventName), type: `hook_${eventName}`, title: eventName, status: null, data: { ...shared, payload } };
  }
}

function recordPayload(raw: string): void {
  if (!raw.trim()) return;
  const event = toTimelineEvent(JSON.parse(raw));
  if (!event) return;
  const filename = livePath(event.sessionId);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.appendFileSync(filename, `${JSON.stringify(event)}\n`);
}

function record(): void {
  recordPayload(readStdin());
}

/** Hooks pipe the event payload on stdin — record it so the ship hook captures SessionEnd too. */
function recordStdinIfPiped(): string | null {
  if (process.stdin.isTTY) return null;
  try {
    const raw = fs.readFileSync(0, "utf8");
    recordPayload(raw);
    const parsed = JSON.parse(raw) as JsonObject;
    return typeof parsed.session_id === "string" ? parsed.session_id : null;
  } catch {
    return null;
  }
}

function sessionFile(agent: AgentKind, sessionId: string): string {
  return path.join(storeDir(), "sessions", agent, `${safeName(sessionId)}.json`);
}

function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, filename);
}

interface AssembledSession { session: NormalizedSession; events: TimelineEvent[]; }

function assemble(agent: AgentKind, sessionId: string, events: TimelineEvent[]): AssembledSession {
  const sorted = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const firstPrompt = sorted.find((event) => event.type === "message_created" && event.data.messageSource === "user");
  const ended = [...sorted].reverse().find((event) => event.type === "session_ended");
  const startedAt = sorted[0]?.occurredAt ?? new Date().toISOString();
  const updatedAt = sorted[sorted.length - 1]?.occurredAt ?? startedAt;
  const prompt = typeof firstPrompt?.data.message === "string" ? firstPrompt.data.message : null;
  return {
    session: {
      schemaVersion: 1,
      agent,
      id: sessionId,
      title: prompt?.split("\n")[0]?.slice(0, 120) || `Session ${sessionId}`,
      prompt,
      status: ended ? "ended" : "in_progress",
      statusDetail: typeof ended?.data.reason === "string" ? ended.data.reason : null,
      origin: "hook",
      startedAt,
      updatedAt,
      acusConsumed: 0,
      url: null,
      repositories: [],
      pullRequests: [],
      tags: ["capture:hook"],
      raw: { capture: "hook", sessionId },
    },
    events: sorted,
  };
}

function updateIndex(session: NormalizedSession, eventCount: number, relativePath: string): void {
  const indexPath = path.join(storeDir(), "index.json");
  let manifest: { version: number; sessions: Record<string, JsonObject>; sources: Record<string, JsonObject> };
  try {
    manifest = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    manifest = { version: 1, sessions: {}, sources: {} };
  }
  manifest.sessions[session.id] = {
    agent: session.agent,
    title: session.title,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    repositories: session.repositories,
    eventCount,
    path: relativePath,
  };
  writeJsonAtomic(indexPath, manifest);
}

/** Fold one live JSONL into sessions/<agent>/<id>.json and the manifest. */
function collectSession(agent: AgentKind, filename: string): string | null {
  const events: TimelineEvent[] = [];
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TimelineEvent);
    } catch { /* skip corrupt lines */ }
  }
  if (!events.length) return null;
  const sessionId = events[0]!.sessionId;
  const assembled = assemble(agent, sessionId, events);
  const relative = path.join("sessions", agent, `${safeName(sessionId)}.json`);
  writeJsonAtomic(path.join(storeDir(), relative), assembled);
  updateIndex(assembled.session, assembled.events.length, relative);
  return sessionId;
}

function collect(filterId?: string): number {
  const liveDir = path.join(storeDir(), "live", agentKind());
  if (!fs.existsSync(liveDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(liveDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    if (filterId && safeName(filterId) !== entry.slice(0, -".jsonl".length)) continue;
    if (collectSession(agentKind(), path.join(liveDir, entry))) count += 1;
  }
  return count;
}

/** POST one assembled session file to the gbird server (GBIRD_ENDPOINT + GBIRD_TOKEN). */
function shipEndpoint(sessionId: string): boolean {
  const endpoint = process.env.GBIRD_ENDPOINT;
  const token = process.env.GBIRD_TOKEN;
  if (!endpoint || !token) return false;
  const file = sessionFile(agentKind(), sessionId);
  if (!fs.existsSync(file)) return false;
  try {
    execFileSync(
      "curl",
      [
        "-fsS",
        "--max-time",
        "15",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "content-type: application/json",
        "--data-binary",
        `@${file}`,
        `${endpoint.replace(/\/+$/, "")}/v1/traces`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    return true;
  } catch {
    return false;
  }
}

/** Push one assembled session file to a git remote via the GitHub contents API. */
function shipGitHub(sessionId: string): boolean {
  const repo = process.env.GBIRD_REPO;
  if (!repo) return false;
  const file = sessionFile(agentKind(), sessionId);
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file).toString("base64");
  const remotePath = `sessions/${agentKind()}/${safeName(sessionId)}.json`;
  try {
    let sha: string | null = null;
    try {
      const out = execFileSync("gh", ["api", `repos/${repo}/contents/${remotePath}`, "--jq", ".sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      sha = out.trim() || null;
    } catch { /* file does not exist yet */ }
    const args = ["api", `repos/${repo}/contents/${remotePath}`, "-X", "PUT", "-f", `message=trace: ${sessionId}`, "--raw-field", `content=${content}`];
    if (sha) args.push("--raw-field", `sha=${sha}`);
    execFileSync("gh", args, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function ship(sessionId?: string): void {
  const stdinSession = recordStdinIfPiped();
  const liveDir = path.join(storeDir(), "live", agentKind());
  const only = sessionId ?? stdinSession;
  const ids = only ? [only] : fs.existsSync(liveDir)
    ? fs.readdirSync(liveDir).filter((entry) => entry.endsWith(".jsonl")).map((entry) => entry.slice(0, -".jsonl".length))
    : [];
  for (const id of ids) {
    try {
      collectSession(agentKind(), path.join(liveDir, `${safeName(id)}.jsonl`));
    } catch { /* no live log for this id */ }
    if (!fs.existsSync(sessionFile(agentKind(), id))) continue;
    const shipped = shipEndpoint(id) || shipGitHub(id);
    process.stdout.write(`${shipped ? "shipped" : "kept"} ${id}\n`);
  }
}

export function main(argv: string[]): void {
  const command = argv[0] ?? "record";
  if (command === "record") return record();
  if (command === "collect") return void process.stdout.write(`${collect(argv[1])} session(s) collected\n`);
  if (command === "ship") return ship(argv[1]);
  process.stderr.write(`usage: gbird-hook record|collect|ship [session-id]\n`);
  process.exitCode = 1;
}

const invokedAsScript = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedAsScript) {
  try {
    main(process.argv.slice(2));
  } catch {
    // Hook commands are best effort: never surface a failure to the agent.
  }
}
