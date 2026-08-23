export type SlugSeverity = "low" | "medium" | "high" | "critical";
export type MeasurementMode = "exact" | "lower_bound" | "elapsed_span" | "unavailable";

export interface SlugEvidence {
  eventId: string;
  occurredAt: string | null;
  kind: "message" | "tool_call" | "tool_result" | "edit" | "test" | "review" | "other";
  summary: string;
}

export interface SlugReplay {
  task: string;
  setup: string[];
  failureCondition: string;
  successCondition: string;
}

/**
 * One evidence-backed suspected failure in a coding-agent session.
 * A slug remains a hypothesis until its replay is run in a fresh session.
 */
export interface Slug {
  id: string;
  sessionId: string;
  repo: string | null;
  category: string;
  title: string;
  severity: SlugSeverity;
  confidence: number;
  observed: string;
  whyItMatters: string;
  evidence: SlugEvidence[];
  waste: {
    tokens: number | null;
    tokenMeasurement: Exclude<MeasurementMode, "elapsed_span">;
    seconds: number | null;
    timeMeasurement: MeasurementMode;
    eventIds: string[];
  };
  hypothesis: string;
  counterevidence: string[];
  replay: SlugReplay | null;
}
