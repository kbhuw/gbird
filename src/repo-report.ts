import { timelineHash, type AnalyzeSession } from "./analyzer.js";
import { repoReportHash, type AnalyzeRepo } from "./reporter.js";
import type { RepoReportInput, StoredRepoReport } from "./schema.js";
import { TimelineStore } from "./store.js";

export interface RepoReportProgress {
  phase: "session_analysis" | "report";
  completed: number;
  total: number;
  title: string;
}

export interface GenerateRepoReportOptions {
  store: TimelineStore;
  repo: string;
  sourceRepositories?: string[];
  analyzeSession: AnalyzeSession;
  analyzeRepo: AnalyzeRepo;
  concurrency?: number;
  onProgress?: (progress: RepoReportProgress) => void;
}

export function buildRepoReportInput(
  store: TimelineStore,
  repo: string,
  sourceRepositories: string[] = [repo],
): { input: RepoReportInput; complete: boolean } {
  const repositories = [...new Set(sourceRepositories)];
  const sessions = [...new Map(repositories
    .flatMap((sourceRepo) => store.listSessions({ repo: sourceRepo }))
    .map((session) => [session.id, session])).values()];
  const analyzed: RepoReportInput["sessions"] = [];
  let complete = true;
  for (const session of sessions) {
    const timeline = store.getTimeline(session.id);
    const stored = store.getAnalysis(session.id);
    if (!timeline || !stored || stored.inputHash !== timelineHash(timeline)) {
      complete = false;
      continue;
    }
    analyzed.push({
      session: {
        id: session.id,
        agent: session.agent,
        title: session.title,
        status: session.status,
        startedAt: session.startedAt,
        url: session.url,
      },
      analysis: stored.analysis,
    });
  }
  return { input: { repo, source_repositories: repositories, sessions: analyzed }, complete };
}

export function repoReportIsStale(store: TimelineStore, record: StoredRepoReport): boolean {
  const current = buildRepoReportInput(store, record.repo, record.report.source_repositories);
  return !current.complete || repoReportHash(current.input) !== record.inputHash;
}

async function runPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      if (current !== undefined) await work(current);
    }
  });
  await Promise.all(workers);
}

export async function generateRepoReport(options: GenerateRepoReportOptions): Promise<StoredRepoReport> {
  const sourceRepositories = [...new Set(options.sourceRepositories ?? [options.repo])];
  const sessions = [...new Map(sourceRepositories
    .flatMap((repo) => options.store.listSessions({ repo }))
    .map((session) => [session.id, session])).values()];
  if (!sessions.length) throw new Error(`No normalized sessions were found for ${options.repo}.`);
  let completed = 0;
  await runPool(sessions, options.concurrency ?? Number(process.env.GBIRD_ANALYSIS_CONCURRENCY ?? 2), async (session) => {
    const timeline = options.store.getTimeline(session.id);
    if (!timeline) throw new Error(`Session ${session.id} has no normalized timeline.`);
    const inputHash = timelineHash(timeline);
    const existing = options.store.getAnalysis(session.id);
    if (!existing || existing.inputHash !== inputHash) {
      const analysis = await options.analyzeSession(timeline);
      options.store.upsertAnalysis({
        sessionId: session.id,
        inputHash,
        analyzer: "coding-session-analyst",
        createdAt: new Date().toISOString(),
        analysis,
      });
    }
    completed += 1;
    options.onProgress?.({
      phase: "session_analysis",
      completed,
      total: sessions.length,
      title: session.title,
    });
  });

  const prepared = buildRepoReportInput(options.store, options.repo, sourceRepositories);
  if (!prepared.complete || prepared.input.sessions.length !== sessions.length) {
    throw new Error("Not every repository session has a current analysis.");
  }
  options.onProgress?.({
    phase: "report",
    completed: sessions.length,
    total: sessions.length,
    title: `Grouping ${prepared.input.sessions.reduce((sum, item) => sum + item.analysis.insights.length, 0)} failure hypotheses`,
  });
  const report = await options.analyzeRepo(prepared.input);
  const record: StoredRepoReport = {
    repo: options.repo,
    inputHash: repoReportHash(prepared.input),
    analyzer: "gbird-repo-reporter",
    createdAt: new Date().toISOString(),
    report,
  };
  options.store.upsertRepoReport(record);
  return record;
}
