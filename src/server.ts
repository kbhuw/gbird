import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMembers, memberByToken, mintMember } from "./members.js";
import type { SessionTimeline } from "./schema.js";
import { TraceStore, type SessionListItem } from "./tracestore.js";

export interface ServerOptions {
  dir: string;
  adminToken?: string | null;
  hookScriptPath?: string | null;
  baseUrl?: string;
}

// dist/src/server.js → repo root is two levels up; src/server.ts (tsx) resolves
// one level up but hits the same real files via the hooks/ candidate first.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function defaultHookScript(): string | null {
  for (const candidate of [
    path.join(REPO_ROOT, "hooks", "gbird-hook.mjs"),
    path.join(REPO_ROOT, "dist", "src", "hookentry.js"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function bearerToken(req: http.IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function isTimeline(value: unknown): value is SessionTimeline {
  const timeline = value as SessionTimeline;
  return (
    typeof timeline === "object" &&
    timeline !== null &&
    typeof timeline.session === "object" &&
    typeof timeline.session?.id === "string" &&
    typeof timeline.session?.agent === "string" &&
    Array.isArray(timeline.events)
  );
}

const PAGE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #c9d1d9; font-size: 14px; }
a { color: #58a6ff; text-decoration: none; }
header { padding: 14px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: baseline; gap: 16px; }
header h1 { font-size: 16px; margin: 0; color: #f0f6fc; }
header .sub { color: #8b949e; font-size: 12px; }
main { padding: 16px 24px; max-width: 1200px; }
form.filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
input, select { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; }
input:focus, select:focus { border-color: #58a6ff; outline: none; }
button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 6px 14px; font: inherit; cursor: pointer; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding: 6px 10px; border-bottom: 1px solid #21262d; }
td { padding: 8px 10px; border-bottom: 1px solid #161b22; vertical-align: top; }
tr:hover td { background: #161b22; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; border: 1px solid #30363d; color: #8b949e; }
.badge.ended { color: #3fb950; border-color: #238636; }
.badge.in_progress { color: #d29922; border-color: #9e6a03; }
.badge.error, .badge.failure { color: #f85149; border-color: #da3633; }
.mono { font-size: 12px; color: #8b949e; }
.event { border: 1px solid #21262d; border-radius: 8px; margin-bottom: 8px; }
.event > summary { padding: 8px 12px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; list-style: none; }
.event > summary::-webkit-details-marker { display: none; }
.event .etype { min-width: 140px; }
.event pre { margin: 0; padding: 10px 12px; border-top: 1px solid #21262d; white-space: pre-wrap; word-break: break-word; font-size: 12px; max-height: 400px; overflow: auto; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; margin-bottom: 16px; }
.meta .cell { border: 1px solid #21262d; border-radius: 8px; padding: 10px 12px; }
.meta .k { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.meta .v { margin-top: 4px; }
pre.prompt { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; white-space: pre-wrap; font-size: 13px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; }
.empty { color: #8b949e; padding: 40px 0; text-align: center; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · gbird</title><style>${PAGE_CSS}</style></head><body><header><h1>gbird</h1><span class="sub">${escapeHtml(title)}</span></header><main>${body}</main></body></html>`;
}

function statusBadge(status: string): string {
  const cls = status.replace(/[^a-z_]/g, "");
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function renderIndex(store: TraceStore, members: ReturnType<typeof loadMembers>, url: URL): string {
  const member = url.searchParams.get("member") ?? undefined;
  const agent = url.searchParams.get("agent") ?? undefined;
  const query = url.searchParams.get("q") ?? undefined;
  const sessions = store.listSessions({ member, agent: agent as "devin" | "codex" | undefined, query });

  const memberOptions = [`<option value="">everyone</option>`]
    .concat(members.map((m) => `<option value="${escapeHtml(m.name)}"${m.name === member ? " selected" : ""}>${escapeHtml(m.name)}</option>`))
    .join("");
  const agentOptions = ["", "devin", "codex"]
    .map((a) => `<option value="${a}"${a === (agent ?? "") ? " selected" : ""}>${a || "all agents"}</option>`)
    .join("");

  const rows = sessions
    .map(
      (s) => `<tr>
        <td class="mono">${escapeHtml(s.member ?? "—")}</td>
        <td class="mono">${escapeHtml(s.agent)}</td>
        <td><a href="/s/${encodeURIComponent(s.id)}">${escapeHtml(s.title || s.id)}</a><div class="mono">${escapeHtml(s.repositories.join(", "))}</div></td>
        <td>${statusBadge(s.status)}</td>
        <td class="mono">${escapeHtml(s.startedAt.slice(0, 16).replace("T", " "))}</td>
        <td class="mono">${s.eventCount}</td>
      </tr>`,
    )
    .join("");

  const table = sessions.length
    ? `<table><tr><th>member</th><th>agent</th><th>session</th><th>status</th><th>started</th><th>events</th></tr>${rows}</table>`
    : `<div class="empty">No traces yet. Run <code>gbird invite &lt;name&gt;</code> to onboard someone.</div>`;

  return page(
    "traces",
    `<form class="filters" method="get" action="/">
      <select name="member">${memberOptions}</select>
      <select name="agent">${agentOptions}</select>
      <input name="q" placeholder="search titles" value="${escapeHtml(query ?? "")}">
      <button type="submit">filter</button>
      <span class="mono" style="align-self:center">${sessions.length} session(s)</span>
    </form>${table}`,
  );
}

function renderDetail(store: TraceStore, id: string): string {
  const timeline = store.getTimeline(id);
  if (!timeline) return page("not found", `<div class="empty">Unknown session <code>${escapeHtml(id)}</code>. <a href="/">Back</a></div>`);
  const { session } = timeline;
  const meta = store.getMeta(id);

  const events = timeline.events
    .map((e) => {
      const statusCls = e.status === "failure" || e.status === "error" ? "failure" : "";
      return `<details class="event"><summary>
        <span class="badge etype">${escapeHtml(e.type)}</span>
        ${statusCls ? `<span class="badge ${statusCls}">${escapeHtml(e.status ?? "")}</span>` : ""}
        <span>${escapeHtml(e.title)}</span>
        <span class="mono">${escapeHtml(e.occurredAt.slice(0, 19).replace("T", " "))}</span>
      </summary><pre>${escapeHtml(JSON.stringify(e.data, null, 2))}</pre></details>`;
    })
    .join("");

  const cell = (k: string, v: string) => `<div class="cell"><div class="k">${k}</div><div class="v">${escapeHtml(v) || "—"}</div></div>`;
  return page(
    session.title || id,
    `<div class="meta">
      ${cell("member", meta?.member ?? "")}
      ${cell("agent", session.agent)}
      ${cell("status", session.statusDetail ?? session.status)}
      ${cell("started", session.startedAt.slice(0, 19).replace("T", " "))}
      ${cell("repos", session.repositories.join(", "))}
      ${cell("events", String(timeline.events.length))}
      ${cell("session id", id)}
      ${session.url ? `<div class="cell"><div class="k">url</div><div class="v"><a href="${escapeHtml(session.url)}">link</a></div></div>` : ""}
    </div>
    ${session.prompt ? `<h2>prompt</h2><pre class="prompt">${escapeHtml(session.prompt)}</pre>` : ""}
    <h2>events</h2>${events || `<div class="empty">no events</div>`}`,
  );
}

function hooksConfig(baseUrl: string, token: string): unknown {
  const env = `GBIRD_ENDPOINT=${baseUrl} GBIRD_TOKEN=${token}`;
  const cmd = (sub: string) => `${env} node "$HOME/.gbird/gbird-hook.mjs" ${sub}`;
  return {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: cmd("record") }] }],
    UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: cmd("record") }] }],
    PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: cmd("record") }] }],
    SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: cmd("ship") }] }],
  };
}

function installPrompt(baseUrl: string, member: { name: string; token: string }): string {
  return `You are setting up gbird agent-trace capture for ${member.name} on this machine.
All traces are sent to ${baseUrl} and are readable at ${baseUrl}/ .

1. Download the hook runtime and your hooks config:

     mkdir -p ~/.gbird
     curl -fsSL ${baseUrl}/v1/hook.mjs -o ~/.gbird/gbird-hook.mjs
     curl -fsSL "${baseUrl}/v1/hooks.v1.json?token=${member.token}" -o ~/.gbird/hooks.v1.json

2. Register the hooks with your agent harness (pick what applies):

   - Devin CLI / Desktop: merge ~/.gbird/hooks.v1.json into the "hooks" key of
     ~/.config/devin/config.json, or copy it to <repo>/.devin/hooks.v1.json for
     one repository.
   - Claude Code: merge ~/.gbird/hooks.v1.json into the "hooks" key of
     ~/.claude/settings.json.

3. Verify: run this, then confirm a test session shows up at ${baseUrl}/ :

     echo '{"hook_event_name":"SessionStart","session_id":"gbird-selftest"}' | GBIRD_ENDPOINT=${baseUrl} GBIRD_TOKEN=${member.token} node ~/.gbird/gbird-hook.mjs record
     echo '{"hook_event_name":"SessionEnd","session_id":"gbird-selftest","reason":"test"}' | GBIRD_ENDPOINT=${baseUrl} GBIRD_TOKEN=${member.token} node ~/.gbird/gbird-hook.mjs ship

The hook appends each agent event to ~/.gbird/live/ during the session and
ships the assembled trace at SessionEnd. It never throws — it cannot break
the agent.
`;
}

export function createGbirdServer(options: ServerOptions): http.Server {
  const store = new TraceStore(options.dir);
  const dir = options.dir;
  const adminToken = options.adminToken ?? process.env.GBIRD_ADMIN_TOKEN ?? null;
  const hookScript = options.hookScriptPath ?? defaultHookScript();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const baseUrl = options.baseUrl ?? `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? "localhost"}`;
      const segments = url.pathname.split("/").filter(Boolean);

      // --- ingest ---
      if (req.method === "POST" && url.pathname === "/v1/traces") {
        const member = memberByToken(dir, bearerToken(req));
        if (!member) return json(res, 401, { error: "unknown token" });
        const body = await readBody(req);
        let timeline: unknown;
        try {
          timeline = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "invalid json" });
        }
        if (!isTimeline(timeline)) return json(res, 400, { error: "expected {session, events}" });
        store.upsertTimeline(timeline, member.name);
        return json(res, 201, { ok: true, id: timeline.session.id });
      }

      // --- programmatic access ---
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return json(res, 200, {
          sessions: store.listSessions({
            member: url.searchParams.get("member") ?? undefined,
            agent: (url.searchParams.get("agent") as "devin" | "codex" | null) ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            query: url.searchParams.get("q") ?? undefined,
          }),
        });
      }
      if (req.method === "GET" && segments[0] === "api" && segments[1] === "sessions" && segments[2]) {
        const timeline = store.getTimeline(decodeURIComponent(segments[2]));
        if (!timeline) return json(res, 404, { error: "not found" });
        const meta = store.getMeta(decodeURIComponent(segments[2]));
        return json(res, 200, { ...timeline, member: meta?.member ?? null });
      }
      if (req.method === "GET" && url.pathname === "/api/members") {
        const members = loadMembers(dir).map(({ token: _token, ...rest }) => rest);
        return json(res, 200, { members });
      }
      if (req.method === "POST" && url.pathname === "/api/members") {
        if (!adminToken || bearerToken(req) !== adminToken) return json(res, 401, { error: "admin token required" });
        const { name } = JSON.parse(await readBody(req) || "{}") as { name?: string };
        if (!name) return json(res, 400, { error: "name required" });
        const member = mintMember(dir, name);
        return json(res, 201, { name: member.name, token: member.token, install: `${baseUrl}/install/${member.token}` });
      }

      // --- hook distribution ---
      if (req.method === "GET" && url.pathname === "/v1/hook.mjs") {
        if (!hookScript) return json(res, 404, { error: "hook script not built — run npm run build" });
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end(fs.readFileSync(hookScript));
      }
      if (req.method === "GET" && url.pathname === "/v1/hooks.v1.json") {
        const member = memberByToken(dir, url.searchParams.get("token") ?? "");
        if (!member) return json(res, 401, { error: "unknown token" });
        return json(res, 200, hooksConfig(baseUrl, member.token));
      }
      if (req.method === "GET" && segments[0] === "install" && segments[1]) {
        const token = decodeURIComponent(segments[1]).replace(/\.md$/, "");
        const member = memberByToken(dir, token);
        if (!member) return json(res, 404, { error: "unknown install token" });
        const prompt = installPrompt(baseUrl, member);
        if (url.pathname.endsWith(".md")) {
          res.writeHead(200, { "content-type": "text/markdown" });
          return res.end(prompt);
        }
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(
          page(
            `install · ${member.name}`,
            `<p>Paste this page's contents (or fetch <a href="/install/${encodeURIComponent(member.token)}.md">the markdown</a>) to the agent whose traces you want captured. It will set itself up.</p><pre class="prompt">${escapeHtml(prompt)}</pre>`,
          ),
        );
      }

      // --- UI ---
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(renderIndex(store, loadMembers(dir), url));
      }
      if (req.method === "GET" && segments[0] === "s" && segments[1]) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(renderDetail(store, decodeURIComponent(segments[1])));
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
