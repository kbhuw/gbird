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
import type { ShipTarget } from "./repoconfig.js";
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
  install <target>      Write gbird's hook configs into a repo (run inside it)
                         target: owner/repo (ship via each dev's own gh) or
                         https://host:port (ship to a gbird-serve endpoint)
    --to TARGET            Same as positional target
    --token T              Member token for an endpoint target (gbird invite)
    --root DIR             Target repo root (default: cwd)
    --dry-run              Report what would change without writing
  show <session-id>     Print one stored trace (session + events)
  hook <sub>            Hook runtime: record | collect [id] | ship [id] (see hooks/)
  serve                 Run the trace server (UI + ingest API)
    --port N               Port (default 8780 or GBIRD_PORT)
    --base-url URL         Public URL for install links (default: request host)
  invite <name>         Mint a member token; prints the install URL + prompt
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

  if (command === "serve") {
    const port = Number(option("--port") ?? process.env.GBIRD_PORT ?? 8780);
    const { createGbirdServer } = await import("./server.js");
    const server = createGbirdServer({
      dir: store.dir,
      baseUrl: option("--base-url") ?? process.env.GBIRD_BASE_URL,
    });
    server.listen(port, () => {
      process.stdout.write(`gbird listening on http://localhost:${port}\nstore: ${store.dir}\n`);
      if (!process.env.GBIRD_ADMIN_TOKEN) {
        process.stderr.write("note: GBIRD_ADMIN_TOKEN unset — POST /api/members disabled (use gbird invite)\n");
      }
    });
    return;
  }

  if (command === "invite") {
    const name = process.argv[3];
    if (!name) throw new Error("Pass a member name: gbird invite <name>.");
    const { mintMember } = await import("./members.js");
    const member = mintMember(store.dir, name);
    const baseUrl = option("--base-url") ?? process.env.GBIRD_BASE_URL ?? `http://localhost:${process.env.GBIRD_PORT ?? 8780}`;
    process.stdout.write(
      `${member.name}\n  token:   ${member.token}\n  install: ${baseUrl}/install/${member.token}\n` +
        `  → teammate opens the install URL and hands the prompt to their agent.\n`,
    );
    return;
  }

  if (command === "install") {
    const args = process.argv.slice(3);
    let positional: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === "--root" || arg === "--traces-repo" || arg === "--to" || arg === "--token") i++;
      else if (!arg.startsWith("-") && positional === undefined) positional = arg;
    }
    const rawTarget = option("--to") ?? option("--traces-repo") ?? positional ?? process.env.GBIRD_REPO;
    const token = option("--token");
    if (!rawTarget) {
      throw new Error("Pass the ship target: gbird install <owner/repo> or gbird install --to https://host:port --token T.");
    }
    let target: ShipTarget;
    let targetLabel: string;
    if (/^https?:\/\//.test(rawTarget)) {
      const endpoint = rawTarget.replace(/\/+$/, "");
      target = token ? { endpoint, token } : { endpoint };
      targetLabel = endpoint;
      if (!token) {
        process.stderr.write(
          "note: no --token — shipping to a `gbird serve` endpoint needs a member token\n" +
          "      (run `gbird invite <name>` on the server, then re-install with --token).\n",
        );
      } else {
        process.stderr.write(
          "note: --token lands in the committed hook configs — every reader of this repo\n" +
          "      can post traces as that member. Prefer per-person GBIRD_TOKEN in\n" +
          "      ~/.gbird/config.env for a public repo.\n",
        );
      }
    } else {
      if (token) throw new Error("--token only applies to an endpoint target (https://...).");
      target = { repo: rawTarget };
      targetLabel = rawTarget;
    }
    const root = path.resolve(option("--root") ?? ".");
    if (!fs.existsSync(path.join(root, ".git"))) {
      process.stderr.write(`note: ${root} is not a git repo root; writing anyway.\n`);
    }
    const { installIntoRepo } = await import("./install.js");
    const dry = hasFlag("--dry-run");
    const results = installIntoRepo(root, target, dry);
    for (const { file, action } of results) {
      process.stdout.write(`${action.padEnd(9)} ${file}\n`);
    }
    if (dry) process.stdout.write("dry run — nothing written.\n");
    else {
      process.stdout.write(
        `\nInstalled gbird for ${targetLabel}. Commit the files above.\n` +
        "Codex users approve the repo hook once via /hooks; everyone else is automatic.\n",
      );
    }
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
