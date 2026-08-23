#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { syncCodexTimeline } from "./codex.js";
import { seedDemo } from "./demo.js";
import { DevinClient } from "./devin.js";
import { GitHubClient } from "./github.js";
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

async function main(): Promise<void> {
  loadEnv();
  const command = process.argv[2] ?? "serve";
  const store = new TimelineStore(storePath());

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
