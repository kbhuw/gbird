import { timelineHash } from "./analyzer.js";
import { TimelineStore, type SessionListItem } from "./store.js";

export type AnalysisStatus = "analyzed" | "stale" | "not_analyzed";

export interface SessionAnalysisState {
  analysisStatus: AnalysisStatus;
  analyzedAt: string | null;
  analysisInsightCount: number;
}

export function sessionAnalysisState(store: TimelineStore, sessionId: string): SessionAnalysisState {
  const stored = store.getAnalysis(sessionId);
  if (!stored) return { analysisStatus: "not_analyzed", analyzedAt: null, analysisInsightCount: 0 };
  const timeline = store.getTimeline(sessionId);
  const current = Boolean(timeline && stored.inputHash === timelineHash(timeline));
  return {
    analysisStatus: current ? "analyzed" : "stale",
    analyzedAt: stored.createdAt,
    analysisInsightCount: stored.analysis.insights.length,
  };
}

export function sessionWithAnalysisState(
  store: TimelineStore,
  session: SessionListItem,
): SessionListItem & SessionAnalysisState {
  return { ...session, ...sessionAnalysisState(store, session.id) };
}
