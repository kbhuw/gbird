#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { syncCodexTimeline } from "./codex.js";
import { DevinClient } from "./devin.js";
import { GitHubClient } from "./github.js";
import type { AgentKind } from "./schema.js";
import { syncTimeline } from "./sync.js";
import { TraceStore } from "./tracestore.js";

const ALL_SESSIONS_LIMIT = 1_000_000;

function loadEnv(filename = ".env"): void {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    const raw = match[2] ?? "";
    process.env[match[1]] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function storeDir(): string {
  return path.resolve(option("--dir") ?? process.env.GBIRD_DIR ?? path.join(os.homedir(), ".gbird"));
}

function codexRoots(): string[] {
  return process.env.CODEX_SESSIONS_ROOT
    ? [path.resolve(process.env.CODEX_SESSIONS_ROOT)]
    : [path.join(os.homedir(), ".codex", "sessions"), path.join(os.homedir(), ".codex", "archived_sessions")];
}

function limit(defaultValue: number): number {
  if (hasFlag("--all")) return ALL_SESSIONS_LIMIT;
  const raw = option("--limit");
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("--limit must be a positive integer.");
  return value;
}

function ghAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const HELP = `gbird — agent trace store

Pull coding-agent sessions into a plain-file store you can keep forever.

Commands:
  pull                  Pull new/changed sessions into the store (default: all sources)
    --source devin|codex   Pull just one source
    --limit N              Sessions to consider per source (default: 50, or DEVIN_SYNC_LIMIT/CODEX_SYNC_LIMIT)
    --all                  No limit
    --force                Re-pull even sessions whose timestamps are unchanged
    --no-github            Skip GitHub PR timeline enrichment (devin source)
  list                  List stored sessions
    --agent devin|codex    Filter by agent
    --repo owner/repo      Filter by repository
    --query text           Filter by title
    --json                 Machine-readable output
  show <session-id>     Print one stored trace (session + events)
  hook <sub>            Hook runtime: record | collect [id] | ship [id] (see hooks/)
  path                  Print the store directory

Store: --dir or GBIRD_DIR (default ~/.gbird). Layout:
  index.json                    manifest of every session
  sessions/<agent>/<id>.json    one normalized timeline per file

Credentials (.env or environment):
  DEVIN_API_KEY, DEVIN_ORG_ID    Devin ingestion (npm run secret:save fetches via secret-valet)
  CODEX_SESSIONS_ROOT            Override Codex rollout roots (default ~/.codex/sessions + archived_sessions)
`;

async function pull(store: TraceStore): Promise<void> {
  const source = option("--source");
  if (source && source !== "devin" && source !== "codex") {
    throw new Error("--source must be devin or codex.");
  }
  const force = hasFlag("--force");
  const errors: string[] = [];

  if ((!source || source === "codex") && codexRoots().some((root) => fs.existsSync(root))) {
    const result = await syncCodexTimeline({
      store,
      limit: limit(Number(process.env.CODEX_SYNC_LIMIT ?? 50)),
      roots: codexRoots(),
      force,
    });
    process.stdout.write(
      `[codex] ${result.sessions} pulled · ${result.skipped} unchanged · ${result.events} events\n`,
    );
  }

  if (!source || source === "devin") {
    const apiKey = process.env.DEVIN_API_KEY ?? process.env.SECRET;
    const orgId = process.env.DEVIN_ORG_ID;
    if (!apiKey || !orgId) {
      errors.push("devin: set DEVIN_API_KEY and DEVIN_ORG_ID (or run npm run secret:save).");
    } else {
      const github = !hasFlag("--no-github") && ghAvailable() ? new GitHubClient() : undefined;
      const summary = await syncTimeline({
        store,
        devin: new DevinClient({
          apiKey,
          orgId,
          baseUrl: process.env.DEVIN_API_BASE_URL,
        }),
        github,
        limit: limit(Number(process.env.DEVIN_SYNC_LIMIT ?? 50)),
        force,
        onProgress: ({ completed, total, title }) => {
          process.stdout.write(`[${completed}/${total}] ${title}\n`);
        },
      });
      process.stdout.write(
        `[devin] ${summary.sessions} pulled · ${summary.skipped} unchanged · ${summary.events} events` +
        (summary.githubPullRequests ? ` · ${summary.githubPullRequests} PRs enriched` : "") +
        "\n",
      );
      for (const error of summary.errors) {
        errors.push(`devin ${error.sessionId} (${error.source}): ${error.message}`);
      }
    }
  }

  const total = store.countSessions();
  process.stdout.write(`store: ${total} session${total === 1 ? "" : "s"} at ${store.dir}\n`);
  for (const error of errors) process.stderr.write(`warning: ${error}\n`);
}

function list(store: TraceStore): void {
  const agent = option("--agent") as AgentKind | undefined;
  if (agent && agent !== "devin" && agent !== "codex") {
    throw new Error("--agent must be devin or codex.");
  }
  const sessions = store.listSessions({
    agent,
    repo: option("--repo"),
    query: option("--query"),
  });
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return;
  }
  for (const session of sessions) {
    process.stdout.write(
      `${session.startedAt.slice(0, 10)}  ${session.agent.padEnd(5)}  ${session.id}  ` +
      `${String(session.eventCount).padStart(4)} events  ${session.title}\n`,
    );
  }
  process.stdout.write(`${sessions.length} session${sessions.length === 1 ? "" : "s"}\n`);
}

async function main(): Promise<void> {
  loadEnv();
  const command = process.argv[2];

  if (!command || command === "help" || hasFlag("--help")) {
    process.stdout.write(HELP);
    return;
  }

  const store = new TraceStore(storeDir());

  if (command === "pull") {
    await pull(store);
    return;
  }

  if (command === "hook") {
    const { main } = await import("./hookentry.js");
    main(process.argv.slice(3));
    return;
  }

  if (command === "list") {
    list(store);
    return;
  }

  if (command === "show") {
    const id = process.argv[3];
    if (!id) throw new Error("Pass a session id: gbird show <session-id>.");
    const timeline = store.getTimeline(id);
    if (!timeline) throw new Error(`No stored session ${id}.`);
    process.stdout.write(`${JSON.stringify(timeline, null, 2)}\n`);
    return;
  }

  if (command === "path") {
    process.stdout.write(`${store.dir}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
