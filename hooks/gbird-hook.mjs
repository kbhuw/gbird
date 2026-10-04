// gbird-hook v3
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
function storeDir() {
    return path.resolve(process.env.GBIRD_DIR ?? path.join(os.homedir(), ".gbird"));
}
/** Load KEY=VALUE lines from <store>/config.env for keys not already in env. */
function loadConfigFile() {
    try {
        const file = path.join(storeDir(), "config.env");
        if (!fs.existsSync(file))
            return;
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
            const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (match && process.env[match[1]] === undefined) {
                process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
            }
        }
    }
    catch { /* config file is optional */ }
}
function agentKind() {
    const kind = process.env.GBIRD_AGENT;
    return kind === "codex" || kind === "claude" || kind === "cursor" || kind === "agent" ? kind : "devin";
}
function safeName(id) {
    return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function stableId(...parts) {
    return createHash("sha256")
        .update(parts.map((part) => part ?? "").join("\u001f"))
        .digest("hex")
        .slice(0, 24);
}
function readStdin() {
    try {
        return fs.readFileSync(0, "utf8");
    }
    catch {
        return "";
    }
}
function livePath(sessionId) {
    return path.join(storeDir(), "live", agentKind(), `${safeName(sessionId)}.jsonl`);
}
function baseEvent(payload, sessionId) {
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
/** Other harnesses use camelCase event names and different session-id fields. */
const EVENT_ALIASES = {
    sessionStart: "SessionStart",
    sessionEnd: "SessionEnd",
    beforeSubmitPrompt: "UserPromptSubmit",
    preToolUse: "PreToolUse",
    postToolUse: "PostToolUse",
    afterAgentResponse: "Stop",
    stop: "Stop",
    subagentStop: "Stop",
};
function sessionIdOf(payload) {
    for (const key of ["session_id", "conversation_id", "sessionId", "sessionID"]) {
        const value = payload[key];
        if (typeof value === "string" && value)
            return value;
    }
    return "";
}
/** Agent/model-identifying env vars; secret-looking values are replaced. */
const ENV_PREFIX = /^(GBIRD|CLAUDE|CURSOR|DEVIN|ANTHROPIC|OPENAI|CODEX|WINDSURF|GEMINI|COPILOT)_/;
const SECRETISH = /key|token|secret|password|credential|auth/i;
function envSnapshot() {
    const out = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!ENV_PREFIX.test(key) || value === undefined)
            continue;
        out[key] = SECRETISH.test(key) ? "[redacted]" : value;
    }
    return out;
}
function modelName() {
    for (const key of ["GBIRD_MODEL", "ANTHROPIC_MODEL", "OPENAI_MODEL", "CLAUDE_CODE_MODEL", "CURSOR_MODEL", "DEVIN_MODE", "CODEX_MODEL", "GEMINI_MODEL"]) {
        const value = process.env[key];
        if (value)
            return value;
    }
    return null;
}
function gitUserEmail() {
    try {
        const email = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return email || null;
    }
    catch {
        return null;
    }
}
/** Claude/Cursor hook payloads carry transcript_path (Codex: rollout_path). */
function transcriptPathOf(payload) {
    const value = payload.transcript_path ?? payload.transcriptPath ?? payload.rollout_path ?? payload.rolloutPath;
    return typeof value === "string" && value ? value : null;
}
/** Map one hook stdin payload to a TimelineEvent. */
function toTimelineEvent(payload) {
    const sessionId = sessionIdOf(payload);
    if (!sessionId)
        return null;
    const rawName = String(payload.hook_event_name ?? "unknown");
    const eventName = EVENT_ALIASES[rawName] ?? rawName;
    const base = baseEvent(payload, sessionId);
    const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
    const shared = { promptId, hookEvent: eventName, transcriptPath: transcriptPathOf(payload) };
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
            const input = (payload.tool_input ?? {});
            const response = (payload.tool_response ?? null);
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
function recordPayload(raw) {
    if (!raw.trim())
        return;
    const event = toTimelineEvent(JSON.parse(raw));
    if (!event)
        return;
    const filename = livePath(event.sessionId);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    let needsSeparator = false;
    if (fs.existsSync(filename)) {
        const fd = fs.openSync(filename, "r");
        try {
            const size = fs.fstatSync(fd).size;
            if (size > 0) {
                const last = Buffer.alloc(1);
                fs.readSync(fd, last, 0, 1, size - 1);
                needsSeparator = last[0] !== 0x0a; // recover from a truncated last line (crash mid-append)
            }
        }
        finally {
            fs.closeSync(fd);
        }
    }
    fs.appendFileSync(filename, `${needsSeparator ? "\n" : ""}${JSON.stringify(event)}\n`);
}
function record() {
    recordPayload(readStdin());
}
/** Hooks pipe the event payload on stdin — record it so the ship hook captures SessionEnd too. */
function recordStdinIfPiped() {
    if (process.stdin.isTTY)
        return null;
    try {
        const raw = fs.readFileSync(0, "utf8");
        recordPayload(raw);
        return sessionIdOf(JSON.parse(raw)) || null;
    }
    catch {
        return null;
    }
}
function sessionFile(agent, sessionId) {
    return path.join(storeDir(), "sessions", agent, `${safeName(sessionId)}.json`);
}
function writeJsonAtomic(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temp = `${filename}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temp, filename);
}
/**
 * Full conversation text when the harness exposes one (transcript_path in the
 * hook payload — Claude Code and Cursor both emit it). Reads the tail of the
 * file if it exceeds 4 MB; returns [] when unavailable.
 */
function loadTranscript(events) {
    const last = [...events].reverse().find((event) => typeof event.data.transcriptPath === "string" && event.data.transcriptPath);
    const file = last?.data.transcriptPath;
    if (!file)
        return [];
    try {
        if (!fs.existsSync(file))
            return [];
        const MAX = 4 * 1024 * 1024;
        const size = fs.statSync(file).size;
        const offset = size > MAX ? size - MAX : 0;
        const buffer = Buffer.alloc(Math.min(size, MAX));
        const fd = fs.openSync(file, "r");
        try {
            fs.readSync(fd, buffer, 0, buffer.length, offset);
        }
        finally {
            fs.closeSync(fd);
        }
        let text = buffer.toString("utf8");
        if (offset > 0)
            text = text.slice(text.indexOf("\n") + 1); // drop partial first line
        const entries = [];
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            try {
                entries.push(JSON.parse(line));
            }
            catch { /* skip corrupt lines */ }
            if (entries.length >= 5000)
                break;
        }
        return entries;
    }
    catch {
        return [];
    }
}
let cachedMember = null;
/** Who this trace belongs to: the gh-authenticated user, else the OS user. */
function memberName() {
    if (cachedMember)
        return cachedMember;
    cachedMember = process.env.GBIRD_MEMBER ?? "";
    if (!cachedMember) {
        try {
            cachedMember = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        }
        catch {
            cachedMember = "";
        }
    }
    if (!cachedMember) {
        try {
            const out = execFileSync("gh", ["auth", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            cachedMember = /account (\S+)/.exec(out)?.[1] ?? "";
        }
        catch {
            cachedMember = "";
        }
    }
    if (!cachedMember)
        cachedMember = process.env.USER ?? process.env.USERNAME ?? "unknown";
    return cachedMember;
}
function assemble(agent, sessionId, events) {
    const sorted = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    const firstPrompt = sorted.find((event) => event.type === "message_created" && event.data.messageSource === "user");
    const ended = [...sorted].reverse().find((event) => event.type === "session_ended");
    const startedAt = sorted[0]?.occurredAt ?? new Date().toISOString();
    const updatedAt = sorted[sorted.length - 1]?.occurredAt ?? startedAt;
    const prompt = typeof firstPrompt?.data.message === "string" ? firstPrompt.data.message : null;
    const member = memberName();
    const model = modelName();
    const transcript = loadTranscript(sorted);
    const assembled = {
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
            tags: ["capture:hook", `member:${member}`, ...(model ? [`model:${model}`] : [])],
            raw: {
                capture: "hook",
                sessionId,
                member,
                osUser: process.env.USER ?? process.env.USERNAME ?? null,
                gitEmail: gitUserEmail(),
                hostname: os.hostname(),
                model,
                env: envSnapshot(),
            },
        },
        events: sorted,
    };
    if (transcript.length)
        assembled.transcript = transcript;
    return assembled;
}
function updateIndex(session, eventCount, relativePath) {
    const indexPath = path.join(storeDir(), "index.json");
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    }
    catch {
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
function collectSession(agent, filename) {
    const events = [];
    for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
        if (!line.trim())
            continue;
        try {
            events.push(JSON.parse(line));
        }
        catch { /* skip corrupt lines */ }
    }
    if (!events.length)
        return null;
    const sessionId = events[0].sessionId;
    const assembled = assemble(agent, sessionId, events);
    const relative = path.join("sessions", agent, `${safeName(sessionId)}.json`);
    writeJsonAtomic(path.join(storeDir(), relative), assembled);
    updateIndex(assembled.session, assembled.events.length, relative);
    return sessionId;
}
function collect(filterId) {
    const liveDir = path.join(storeDir(), "live", agentKind());
    if (!fs.existsSync(liveDir))
        return 0;
    let count = 0;
    for (const entry of fs.readdirSync(liveDir)) {
        if (!entry.endsWith(".jsonl"))
            continue;
        if (filterId && safeName(filterId) !== entry.slice(0, -".jsonl".length))
            continue;
        if (collectSession(agentKind(), path.join(liveDir, entry)))
            count += 1;
    }
    return count;
}
/** POST one assembled session file to the gbird server (GBIRD_ENDPOINT + GBIRD_TOKEN). */
function shipEndpoint(sessionId) {
    const endpoint = process.env.GBIRD_ENDPOINT;
    const token = process.env.GBIRD_TOKEN;
    if (!endpoint || !token)
        return false;
    const file = sessionFile(agentKind(), sessionId);
    if (!fs.existsSync(file))
        return false;
    try {
        execFileSync("curl", [
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
        ], { stdio: ["ignore", "pipe", "ignore"] });
        return true;
    }
    catch {
        return false;
    }
}
/** Push one assembled session file to a git remote via the GitHub contents API. */
function shipGitHub(sessionId) {
    const repo = process.env.GBIRD_REPO;
    if (!repo)
        return false;
    const file = sessionFile(agentKind(), sessionId);
    if (!fs.existsSync(file))
        return false;
    const content = fs.readFileSync(file).toString("base64");
    const remotePath = `sessions/${safeName(memberName())}/${agentKind()}/${safeName(sessionId)}.json`;
    try {
        const branch = process.env.GBIRD_REPO_BRANCH;
        let sha = null;
        try {
            const out = execFileSync("gh", ["api", `repos/${repo}/contents/${remotePath}${branch ? `?ref=${branch}` : ""}`, "--jq", ".sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            sha = out.trim() || null;
        }
        catch { /* file does not exist yet */ }
        const args = ["api", `repos/${repo}/contents/${remotePath}`, "-X", "PUT", "-f", `message=trace: ${sessionId}`, "--raw-field", `content=${content}`];
        if (sha)
            args.push("--raw-field", `sha=${sha}`);
        if (branch)
            args.push("-f", `branch=${branch}`);
        execFileSync("gh", args, { stdio: ["ignore", "pipe", "ignore"] });
        return true;
    }
    catch {
        return false;
    }
}
function ship(sessionId) {
    const stdinSession = recordStdinIfPiped();
    const liveDir = path.join(storeDir(), "live", agentKind());
    const only = sessionId ?? stdinSession;
    const ids = only ? [only] : fs.existsSync(liveDir)
        ? fs.readdirSync(liveDir).filter((entry) => entry.endsWith(".jsonl")).map((entry) => entry.slice(0, -".jsonl".length))
        : [];
    for (const id of ids) {
        try {
            collectSession(agentKind(), path.join(liveDir, `${safeName(id)}.jsonl`));
        }
        catch { /* no live log for this id */ }
        if (!fs.existsSync(sessionFile(agentKind(), id)))
            continue;
        const shipped = shipEndpoint(id) || shipGitHub(id);
        process.stdout.write(`${shipped ? "shipped" : "kept"} ${id}\n`);
    }
}
export function main(argv) {
    loadConfigFile();
    const command = argv[0] ?? "record";
    if (command === "record")
        return record();
    if (command === "collect")
        return void process.stdout.write(`${collect(argv[1])} session(s) collected\n`);
    if (command === "ship")
        return ship(argv[1]);
    process.stderr.write(`usage: gbird-hook record|collect|ship [session-id]\n`);
    process.exitCode = 1;
}
const invokedAsScript = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedAsScript) {
    try {
        main(process.argv.slice(2));
    }
    catch {
        // Hook commands are best effort: never surface a failure to the agent.
    }
}
//# sourceMappingURL=hookentry.js.map