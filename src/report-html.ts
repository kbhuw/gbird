import { verificationCounts } from "./reproduction.js";
import type { RepoFailure, StoredRepoReport } from "./schema.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function verificationLabel(failure: RepoFailure): string {
  const status = failure.verification?.status ?? "not_run";
  if (status === "reproduced") return "Reproduced by a fresh agent";
  if (status === "not_reproduced") return "Not reproduced by a fresh agent";
  if (status === "inconclusive") return "Fresh-agent replay was inconclusive";
  return "Not replayed yet";
}

function verificationHtml(failure: RepoFailure): string {
  const verification = failure.verification;
  if (!verification?.attempts.length) return `<p><strong>Current replay:</strong> ${verificationLabel(failure)}</p>`;
  const attempts = verification.attempts.map((attempt) => `
            <li>
              <strong>${escapeHtml(attempt.verdict.replaceAll("_", " "))}</strong> · ${escapeHtml(attempt.summary)}
              ${attempt.observed_actions.length ? `<p>Actions: ${attempt.observed_actions.map(escapeHtml).join("; ")}</p>` : ""}
              ${attempt.evidence.length ? `<p>Evidence: ${attempt.evidence.map(escapeHtml).join("; ")}</p>` : ""}
              ${attempt.limitations.length ? `<p>Limits: ${attempt.limitations.map(escapeHtml).join("; ")}</p>` : ""}
            </li>`).join("");
  return `
          <p><strong>Current replay:</strong> ${verificationLabel(failure)}</p>
          <details>
            <summary>Blind replay evidence</summary>
            <p>Commit: <code>${escapeHtml(verification.checkout_sha)}</code></p>
            <ol>${attempts}
            </ol>
          </details>`;
}

function failureHtml(failure: RepoFailure): string {
  const sessionLabel = `${failure.historical_session_count} session${failure.historical_session_count === 1 ? "" : "s"}`;
  const occurrences = failure.occurrences.map((occurrence) => `
          <li>
            <strong>${escapeHtml(occurrence.session_title)}</strong> (${escapeHtml(occurrence.agent)})
            <p>${escapeHtml(occurrence.observed)}</p>
            <small>Events: ${occurrence.evidence_event_ids.map(escapeHtml).join(", ")}</small>
          </li>`).join("");
  return `
      <li>
        <article>
          <h2>${escapeHtml(failure.title)}</h2>
          <p><strong>${escapeHtml(failure.severity.toUpperCase())}</strong> · ${failure.classification === "recurring" ? `seen in ${escapeHtml(sessionLabel)}` : "seen once"}</p>
          <p>${escapeHtml(failure.summary)}</p>
          ${verificationHtml(failure)}

          <h3>Test prompt</h3>
          <blockquote><p>${escapeHtml(failure.repro.prompt)}</p></blockquote>
          <p><strong>Failure if:</strong> ${escapeHtml(failure.repro.failure_condition)}</p>

          <details>
            <summary>Evidence and possible fix</summary>
            <p><strong>Success if:</strong> ${escapeHtml(failure.repro.success_condition)}</p>
            <p><strong>Possible fix:</strong> ${escapeHtml(failure.suggested_guardrail)}</p>
            <ol>${occurrences}
            </ol>
          </details>
        </article>
      </li>`;
}

export function renderRepoReportHtml(record: StoredRepoReport): string {
  const report = record.report;
  const recurring = report.failures.filter((failure) => failure.classification === "recurring").length;
  const verified = verificationCounts(report);
  const aliases = report.source_repositories.filter((repo) => repo !== report.repo);
  const limitations = report.limitations.length
    ? `<details><summary>Limitations</summary><ul>${report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(report.repo)} failures · gbird</title>
</head>
<body>
  <header>
    <p><a href="http://127.0.0.1:4189/">Sessions</a> · <a href="./report.json">JSON</a></p>
    <h1>${escapeHtml(report.repo)} failures</h1>
    <p>${report.coverage.sessions_analyzed} sessions · ${report.failures.length} possible failures · ${recurring} seen more than once</p>
    <p>${verified.reproduced} reproduced · ${verified.not_reproduced} not reproduced · ${verified.inconclusive} inconclusive · ${verified.not_run} not run</p>
    ${aliases.length ? `<p>Includes previous repository name${aliases.length === 1 ? "" : "s"}: ${aliases.map(escapeHtml).join(", ")}</p>` : ""}
  </header>
  <main>
    ${report.failures.length ? `<ol>${report.failures.map(failureHtml).join("\n")}</ol>` : "<p>No failures found.</p>"}
    ${limitations}
  </main>
  <footer>
    <p>Generated ${escapeHtml(new Date(record.createdAt).toLocaleString())}. Historical evidence and current blind replays are reported separately.</p>
  </footer>
</body>
</html>`;
}
