import os from "node:os";
import path from "node:path";
import { sessionAnalysisState } from "./analysis-state.js";
import { countCodexSessionFiles } from "./codex.js";
import { repositoryHintsForDevinSession, type DevinClient } from "./devin.js";
import { resolveRepoScope } from "./repo-scope.js";
import { TimelineStore } from "./store.js";

export interface InventoryOptions {
  store: TimelineStore;
  repo: string;
  devin?: Pick<DevinClient, "listSessions">;
  codexRoots?: string[];
}

export async function inspectInventory(options: InventoryOptions): Promise<Record<string, unknown>> {
  const scope = resolveRepoScope(options.store, options.repo);
  const repoNames = new Set(scope.repositories.map((repo) => repo.toLowerCase()));
  const repoSessions = [...new Map(scope.repositories
    .flatMap((repo) => options.store.listSessions({ repo }))
    .map((session) => [session.id, session])).values()];
  const analyzed = repoSessions.map((session) => sessionAnalysisState(options.store, session.id));
  const codexRoots = options.codexRoots ?? [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions"),
  ];
  const devinSessions = options.devin ? await options.devin.listSessions(1_000_000) : null;
  const knownDevinRepoSessions = devinSessions?.filter((session) =>
    repositoryHintsForDevinSession(session).some((repo) => repoNames.has(repo.toLowerCase()))).length ?? null;

  return {
    repo: scope.canonical,
    sourceRepositories: scope.repositories,
    imported: {
      allSessions: options.store.countSessions(),
      repoSessions: repoSessions.length,
      analyzed: analyzed.filter((state) => state.analysisStatus === "analyzed").length,
      stale: analyzed.filter((state) => state.analysisStatus === "stale").length,
      notAnalyzed: analyzed.filter((state) => state.analysisStatus === "not_analyzed").length,
    },
    available: {
      codexFiles: countCodexSessionFiles(codexRoots),
      devinSessions: devinSessions?.length ?? null,
      devinRepoSessionsFromPrOrTag: knownDevinRepoSessions,
    },
  };
}
