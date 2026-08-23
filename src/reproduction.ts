import type {
  BlindReproductionAttempt,
  BlindReproductionInput,
  RepoFailureReport,
  ReproductionBundle,
  ReproductionVerdict,
} from "./schema.js";

function verdictFor(result: BlindReproductionInput): ReproductionVerdict {
  if (result.task_outcome !== "completed") return "inconclusive";
  if (result.failure_condition_observed && !result.success_condition_observed) return "reproduced";
  if (result.success_condition_observed && !result.failure_condition_observed) return "not_reproduced";
  return "inconclusive";
}

function assertNonEmptyStrings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must contain only non-empty strings.`);
  }
}

function validateAttempt(result: BlindReproductionInput, bundle: ReproductionBundle): BlindReproductionAttempt {
  if (!result.failure_id || !result.attempt_id || !result.agent || !result.summary || !result.evaluation) {
    throw new Error("Every blind reproduction needs a failure_id, attempt_id, agent, summary, and evaluation.");
  }
  if (result.checkout_sha !== bundle.checkout_sha) {
    throw new Error(`${result.attempt_id} used checkout ${result.checkout_sha}, expected ${bundle.checkout_sha}.`);
  }
  if (!["completed", "blocked", "failed"].includes(result.task_outcome)) {
    throw new Error(`${result.attempt_id} has an invalid task_outcome.`);
  }
  if (typeof result.failure_condition_observed !== "boolean" || typeof result.success_condition_observed !== "boolean") {
    throw new Error(`${result.attempt_id} must record both condition observations.`);
  }
  assertNonEmptyStrings(result.observed_actions, `${result.attempt_id}.observed_actions`);
  assertNonEmptyStrings(result.evidence, `${result.attempt_id}.evidence`);
  assertNonEmptyStrings(result.limitations, `${result.attempt_id}.limitations`);
  return { ...result, verdict: verdictFor(result) };
}

function aggregateVerdict(attempts: BlindReproductionAttempt[]): ReproductionVerdict {
  const decisive = new Set(attempts
    .map((attempt) => attempt.verdict)
    .filter((verdict): verdict is Exclude<ReproductionVerdict, "inconclusive"> => verdict !== "inconclusive"));
  if (decisive.size === 1) return [...decisive][0]!;
  return "inconclusive";
}

export function applyBlindReproductions(
  report: RepoFailureReport,
  bundle: ReproductionBundle,
): RepoFailureReport {
  if (bundle.verification_schema_version !== 1) throw new Error("Verification schema version must be 1.");
  if (bundle.repo !== report.repo) throw new Error("Verification results do not match the report repository.");
  if (!bundle.checkout_sha) throw new Error("Verification checkout_sha is required.");
  if (Number.isNaN(Date.parse(bundle.verified_at))) throw new Error("Verification verified_at must be an ISO timestamp.");
  if (!Array.isArray(bundle.results)) throw new Error("Verification results must be an array.");

  const knownFailures = new Set(report.failures.map((failure) => failure.id));
  const attemptIds = new Set<string>();
  const byFailure = new Map<string, BlindReproductionAttempt[]>();
  for (const raw of bundle.results) {
    if (!knownFailures.has(raw.failure_id)) throw new Error(`Unknown failure_id ${raw.failure_id}.`);
    if (attemptIds.has(raw.attempt_id)) throw new Error(`Duplicate attempt_id ${raw.attempt_id}.`);
    attemptIds.add(raw.attempt_id);
    const attempt = validateAttempt(raw, bundle);
    byFailure.set(raw.failure_id, [...(byFailure.get(raw.failure_id) ?? []), attempt]);
  }

  const next = structuredClone(report);
  for (const failure of next.failures) {
    const attempts = byFailure.get(failure.id) ?? [];
    if (!attempts.length) throw new Error(`Failure ${failure.id} has no blind reproduction attempt.`);
    if (attempts.length === 1 && attempts[0]?.verdict === "inconclusive") {
      throw new Error(`Failure ${failure.id} needs a second blind attempt because the first was inconclusive.`);
    }
    failure.verification = {
      status: aggregateVerdict(attempts),
      checked_at: bundle.verified_at,
      checkout_sha: bundle.checkout_sha,
      attempts,
    };
  }
  return next;
}

export function verificationCounts(report: RepoFailureReport): Record<"reproduced" | "not_reproduced" | "inconclusive" | "not_run", number> {
  const counts = { reproduced: 0, not_reproduced: 0, inconclusive: 0, not_run: 0 };
  for (const failure of report.failures) counts[failure.verification?.status ?? "not_run"] += 1;
  return counts;
}
