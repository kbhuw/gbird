import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  codexSkillAvailable,
  createCodexSkillAnalyzer,
  timelineHash,
  type AnalyzeSession,
} from "./analyzer.js";
import { syncCodexTimeline, type CodexSyncSummary } from "./codex.js";
import { DevinClient } from "./devin.js";
import { GitHubClient } from "./github.js";
import { TimelineStore } from "./store.js";
import { syncTimeline, type SyncSummary } from "./sync.js";
import type { AgentKind } from "./schema.js";

export interface ServerOptions {
  store: TimelineStore;
  host?: string;
  port?: number;
  syncLimit?: number;
  codexSyncLimit?: number;
  demo?: boolean;
  analyzeSession?: AnalyzeSession;
  projectRoot?: string;
}

export interface RunningServer {
  url: URL;
  close: () => Promise<void>;
}

function devinApiKey(): string | undefined {
  return process.env.DEVIN_API_KEY ?? process.env.SECRET;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cognition.com https://www.greptile.com https://cdn.prod.website-files.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function json(response: ServerResponse, status: number, body: unknown): void {
  securityHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  securityHeaders(response);
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function githubAvailable(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function requestedAgent(url: URL): AgentKind | undefined {
  const value = url.searchParams.get("agent");
  return value === "codex" || value === "devin" ? value : undefined;
}

function sameOrigin(request: IncomingMessage, url: URL): boolean {
  const origin = request.headers.origin;
  return !origin || new URL(origin).host === url.host;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const uiPath = path.join(import.meta.dirname, "ui", "index.html");
  const aboutPath = path.join(import.meta.dirname, "ui", "about.html");
  const hasGithub = githubAvailable();
  const codexRoot = process.env.CODEX_SESSIONS_ROOT ?? path.join(os.homedir(), ".codex", "sessions");
  const hasCodex = fs.existsSync(codexRoot);
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const hasAnalyzer = Boolean(options.analyzeSession) || codexSkillAvailable({ projectRoot });
  const analyzeSession = options.analyzeSession ?? createCodexSkillAnalyzer({ projectRoot });
  let activeDevinSync: Promise<SyncSummary> | null = null;
  let activeCodexSync: Promise<CodexSyncSummary> | null = null;
  const activeAnalyses = new Map<string, Promise<ReturnType<TimelineStore["getAnalysis"]>>>();

  const runDevinSync = (): Promise<SyncSummary> => {
    if (activeDevinSync) return activeDevinSync;
    const apiKey = devinApiKey();
    const orgId = process.env.DEVIN_ORG_ID;
    if (!apiKey || !orgId) {
      return Promise.reject(new Error("Set DEVIN_API_KEY and DEVIN_ORG_ID to import sessions."));
    }
    activeDevinSync = syncTimeline({
      store: options.store,
      devin: new DevinClient({ apiKey, orgId }),
      github: hasGithub ? new GitHubClient() : undefined,
      limit: options.syncLimit ?? Number(process.env.DEVIN_SYNC_LIMIT ?? 50),
    }).finally(() => {
      activeDevinSync = null;
    });
    return activeDevinSync;
  };

  const runCodexSync = (): Promise<CodexSyncSummary> => {
    if (activeCodexSync) return activeCodexSync;
    const configuredRoot = process.env.CODEX_SESSIONS_ROOT;
    activeCodexSync = syncCodexTimeline({
      store: options.store,
      limit: options.codexSyncLimit ?? Number(process.env.CODEX_SYNC_LIMIT ?? 50),
      roots: configuredRoot
        ? [path.resolve(configuredRoot)]
        : [path.join(os.homedir(), ".codex", "sessions"), path.join(os.homedir(), ".codex", "archived_sessions")],
    }).finally(() => {
      activeCodexSync = null;
    });
    return activeCodexSync;
  };

  const runAvailableSyncs = async (): Promise<Record<string, SyncSummary | CodexSyncSummary>> => {
    const summaries: Record<string, SyncSummary | CodexSyncSummary> = {};
    if (hasCodex) summaries.codex = await runCodexSync();
    if (devinApiKey() && process.env.DEVIN_ORG_ID) summaries.devin = await runDevinSync();
    if (!Object.keys(summaries).length) throw new Error("No agent sources are configured.");
    return summaries;
  };

  const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      if (request.method === "GET" && url.pathname === "/") {
        text(response, 200, fs.readFileSync(uiPath, "utf8"), "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/about") {
        text(response, 200, fs.readFileSync(aboutPath, "utf8"), "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, {
          configured: Boolean(devinApiKey() && process.env.DEVIN_ORG_ID),
          codexConfigured: hasCodex,
          githubConfigured: hasGithub,
          analysisConfigured: hasAnalyzer,
          syncing: Boolean(activeDevinSync || activeCodexSync),
          syncingAgent: activeCodexSync ? "codex" : activeDevinSync ? "devin" : null,
          demo: Boolean(options.demo),
          sessionCount: options.store.countSessions(),
          sessionCounts: {
            devin: options.store.countSessions("devin"),
            codex: options.store.countSessions("codex"),
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/repos") {
        json(response, 200, { repos: options.store.listRepos(requestedAgent(url)) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        json(response, 200, {
          sessions: options.store.listSessions({
            agent: requestedAgent(url),
            repo: url.searchParams.get("repo") || undefined,
            query: url.searchParams.get("q") || undefined,
          }),
        });
        return;
      }

      const exportMatch = /^\/api\/sessions\/([^/]+)\/export$/.exec(url.pathname);
      if (request.method === "GET" && exportMatch?.[1]) {
        const id = decodeURIComponent(exportMatch[1]);
        const timeline = options.store.getTimeline(id);
        if (!timeline) {
          json(response, 404, { error: "Session not found." });
          return;
        }
        securityHeaders(response);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${safeFilename(timeline.session.title)}.json"`,
        });
        response.end(JSON.stringify(timeline, null, 2));
        return;
      }

      const analysisMatch = /^\/api\/sessions\/([^/]+)\/analysis$/.exec(url.pathname);
      if ((request.method === "GET" || request.method === "POST") && analysisMatch?.[1]) {
        const id = decodeURIComponent(analysisMatch[1]);
        const timeline = options.store.getTimeline(id);
        if (!timeline) {
          json(response, 404, { error: "Session not found." });
          return;
        }
        const inputHash = timelineHash(timeline);
        if (request.method === "GET") {
          const stored = options.store.getAnalysis(id);
          json(response, 200, {
            analysis: stored?.analysis ?? null,
            createdAt: stored?.createdAt ?? null,
            analyzer: stored?.analyzer ?? null,
            stale: Boolean(stored && stored.inputHash !== inputHash),
          });
          return;
        }
        if (!sameOrigin(request, url)) {
          json(response, 403, { error: "Cross-origin requests are not allowed." });
          return;
        }
        if (!hasAnalyzer) {
          json(response, 503, { error: "The coding-session-analyst skill or Codex CLI is not available." });
          return;
        }
        let active = activeAnalyses.get(id);
        if (!active) {
          active = analyzeSession(timeline).then((analysis) => {
            const record = {
              sessionId: id,
              inputHash,
              analyzer: "coding-session-analyst",
              createdAt: new Date().toISOString(),
              analysis,
            };
            options.store.upsertAnalysis(record);
            return record;
          }).finally(() => activeAnalyses.delete(id));
          activeAnalyses.set(id, active);
        }
        try {
          const stored = await active;
          json(response, 200, {
            analysis: stored?.analysis ?? null,
            createdAt: stored?.createdAt ?? null,
            analyzer: stored?.analyzer ?? null,
            stale: false,
          });
        } catch (error) {
          json(response, 503, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && sessionMatch?.[1]) {
        const timeline = options.store.getTimeline(decodeURIComponent(sessionMatch[1]));
        if (!timeline) {
          json(response, 404, { error: "Session not found." });
          return;
        }
        json(response, 200, timeline);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sync") {
        if (!sameOrigin(request, url)) {
          json(response, 403, { error: "Cross-origin requests are not allowed." });
          return;
        }
        try {
          const agent = requestedAgent(url);
          json(response, 200, await (agent === "codex"
            ? runCodexSync()
            : agent === "devin"
              ? runDevinSync()
              : runAvailableSyncs()));
        } catch (error) {
          json(response, 503, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      json(response, 404, { error: "Not found." });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4189, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve server address.");
  return {
    url: new URL(`http://${host}:${address.port}`),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
