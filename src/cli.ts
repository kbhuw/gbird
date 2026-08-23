#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createCodexSkillAnalyzer } from "./analyzer.js";
import { syncCodexTimeline } from "./codex.js";
import { seedDemo } from "./demo.js";
import { DevinClient } from "./devin.js";
import { GitHubClient } from "./github.js";
import { inspectInventory } from "./inventory.js";
import { generateRepoReport } from "./repo-report.js";
import { resolveRepoScope } from "./repo-scope.js";
import { renderRepoReportHtml } from "./report-html.js";
import { createCodexRepoReporter } from "./reporter.js";
import { startServer } from "./server.js";
import { TimelineStore } from "./store.js";
import { syncTimeline } from "./sync.js";

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

function storePath(): string {
  return path.resolve(
    option("--db")
      ?? process.env.GBIRD_DB
      ?? process.env.DEVIN_TIMELINE_DB
      ?? ".data/gbird.db",
  );
}

function runtimeRoot(): string {
  for (const candidate of [path.resolve(import.meta.dirname, ".."), path.resolve(import.meta.dirname, "..", "..")]) {
    const hasAnalyst = [
      path.join(candidate, "skills", "coding-session-analyst", "SKILL.md"),
      path.join(candidate, "runtime", "coding-session-analyst", "SKILL.md"),
    ].some((skill) => fs.existsSync(skill));
    if (fs.existsSync(path.join(candidate, "package.json")) && hasAnalyst) {
      return candidate;
    }
  }
  return process.cwd();
}

function currentRepo(): string | undefined {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function reportDirectory(repo: string): string {
  return path.resolve(option("--out") ?? process.env.GBIRD_REPORT_DIR ?? path.join(os.homedir(), ".gbird", "reports", repo.replaceAll("/", "--")));
}

const ALL_SESSIONS_LIMIT = 1_000_000;

function codexRoots(): string[] {
  return process.env.CODEX_SESSIONS_ROOT
    ? [path.resolve(process.env.CODEX_SESSIONS_ROOT)]
    : [path.join(os.homedir(), ".codex", "sessions"), path.join(os.homedir(), ".codex", "archived_sessions")];
}

function selectedLimit(name: string, shared: string | undefined, all: boolean): number {
  if (all) return ALL_SESSIONS_LIMIT;
  const raw = option(name) ?? shared;
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

async function collectAvailableSessions(
  store: TimelineStore,
  limits: { codex: number; devin: number },
): Promise<void> {
  const roots = codexRoots();
  if (limits.codex > 0 && roots.some((root) => fs.existsSync(root))) {
    const result = await syncCodexTimeline({ store, limit: limits.codex, roots });
    process.stdout.write(`[codex] ${result.sessions} sessions · ${result.events} events\n`);
  }
  const apiKey = process.env.DEVIN_API_KEY ?? process.env.SECRET;
  const orgId = process.env.DEVIN_ORG_ID;
  if (limits.devin > 0 && apiKey && orgId) {
    const result = await syncTimeline({
      store,
      devin: new DevinClient({ apiKey, orgId }),
      github: new GitHubClient(),
      limit: limits.devin,
    });
    process.stdout.write(`[devin] ${result.sessions} sessions · ${result.events} events\n`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const command = process.argv[2] ?? "serve";
  const store = new TimelineStore(storePath());

  if (command === "inventory") {
    const repo = option("--repo") ?? process.env.GBIRD_REPO ?? currentRepo();
    if (!repo) throw new Error("Pass --repo owner/repo or run gbird inside a GitHub repository.");
    const apiKey = process.env.DEVIN_API_KEY ?? process.env.SECRET;
    const orgId = process.env.DEVIN_ORG_ID;
    const inventory = await inspectInventory({
      store,
      repo,
      devin: apiKey && orgId ? new DevinClient({ apiKey, orgId }) : undefined,
      codexRoots: codexRoots(),
    });
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    store.close();
    return;
  }

  if (command === "report") {
    const repo = option("--repo") ?? process.env.GBIRD_REPO ?? currentRepo();
    if (!repo) throw new Error("Pass --repo owner/repo or run gbird inside a GitHub repository.");
    if (!hasFlag("--skip-sync")) {
      const all = hasFlag("--all");
      const shared = option("--limit");
      const limits = {
        codex: selectedLimit("--codex-limit", shared, all),
        devin: selectedLimit("--devin-limit", shared, all),
      };
      if (!limits.codex && !limits.devin) {
        throw new Error("Choose the import scope with --all, --limit N, source-specific limits, or --skip-sync.");
      }
      await collectAvailableSessions(store, limits);
    }
    const scope = resolveRepoScope(store, repo);
    const root = runtimeRoot();
    const record = await generateRepoReport({
      store,
      repo: scope.canonical,
      sourceRepositories: scope.repositories,
      analyzeSession: createCodexSkillAnalyzer({ projectRoot: root }),
      analyzeRepo: createCodexRepoReporter({ projectRoot: root }),
      concurrency: Number(option("--concurrency") ?? process.env.GBIRD_ANALYSIS_CONCURRENCY ?? 2),
      onProgress: ({ phase, completed, total, title }) => {
        process.stdout.write(`[${phase}] ${completed}/${total} ${title}\n`);
      },
    });
    const output = reportDirectory(scope.canonical);
    fs.mkdirSync(output, { recursive: true });
    const jsonPath = path.join(output, "report.json");
    const htmlPath = path.join(output, "report.html");
    fs.writeFileSync(jsonPath, `${JSON.stringify(record.report, null, 2)}\n`);
    fs.writeFileSync(htmlPath, renderRepoReportHtml(record));
    process.stdout.write(`${JSON.stringify({
      repo: scope.canonical,
      sourceRepositories: scope.repositories,
      sessionsAnalyzed: record.report.coverage.sessions_analyzed,
      failures: record.report.failures.length,
      recurring: record.report.failures.filter((failure) => failure.classification === "recurring").length,
      reportJson: jsonPath,
      reportHtml: htmlPath,
    }, null, 2)}\n`);
    store.close();
    return;
  }

  if (command === "sync-codex") {
    const summary = await syncCodexTimeline({
      store,
      limit: Number(option("--limit") ?? process.env.CODEX_SYNC_LIMIT ?? 50),
      roots: process.env.CODEX_SESSIONS_ROOT
        ? [path.resolve(process.env.CODEX_SESSIONS_ROOT)]
        : [path.join(os.homedir(), ".codex", "sessions"), path.join(os.homedir(), ".codex", "archived_sessions")],
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    store.close();
    return;
  }

  if (command === "sync") {
    const apiKey = process.env.DEVIN_API_KEY ?? process.env.SECRET;
    const orgId = process.env.DEVIN_ORG_ID;
    if (!apiKey || !orgId) throw new Error("Set DEVIN_API_KEY and DEVIN_ORG_ID before syncing.");
    const summary = await syncTimeline({
      store,
      devin: new DevinClient({ apiKey, orgId }),
      github: new GitHubClient(),
      limit: Number(option("--limit") ?? process.env.DEVIN_SYNC_LIMIT ?? 50),
      onProgress: ({ completed, total, title }) => {
        process.stdout.write(`[${completed}/${total}] ${title}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    store.close();
    return;
  }

  if (command !== "serve") throw new Error(`Unknown command: ${command}`);
  const demo = hasFlag("--demo");
  if (demo) seedDemo(store);
  const running = await startServer({
    store,
    port: Number(option("--port") ?? process.env.GBIRD_PORT ?? process.env.DEVIN_TIMELINE_PORT ?? 4189),
    syncLimit: Number(option("--limit") ?? process.env.DEVIN_SYNC_LIMIT ?? 50),
    codexSyncLimit: Number(process.env.CODEX_SYNC_LIMIT ?? 50),
    demo,
    projectRoot: runtimeRoot(),
  });
  process.stdout.write(`gbird: ${running.url}\n`);

  const close = async (): Promise<void> => {
    await running.close();
    store.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
