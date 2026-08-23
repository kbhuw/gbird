#!/usr/bin/env node

import fs from "node:fs";

const [transcriptPath, analysisPath] = process.argv.slice(2);
if (!transcriptPath || !analysisPath) {
  console.error("Usage: node validate-analysis.mjs <transcript.json-or-jsonl> <analysis.json>");
  process.exit(2);
}

function parseTranscript(filename) {
  const source = fs.readFileSync(filename, "utf8").trim();
  if (!source) throw new Error("Transcript is empty.");
  try {
    return JSON.parse(source);
  } catch {
    return { events: source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) };
  }
}

function eventsFrom(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.events)) return input.events;
  if (input.timeline && Array.isArray(input.timeline.events)) return input.timeline.events;
  return [];
}

function eventId(event, index) {
  return String(event?.id ?? event?.event_id ?? event?.eventId ?? `event-${String(index + 1).padStart(4, "0")}`);
}

const transcript = parseTranscript(transcriptPath);
const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
const events = eventsFrom(transcript);
const ids = new Set(events.map(eventId));
const errors = [];

if (analysis.analysis_schema_version !== 1) errors.push("analysis_schema_version must equal 1");
if (!analysis.session_id) errors.push("session_id is required");
if (!analysis.outcome || typeof analysis.outcome.summary !== "string") errors.push("outcome.summary is required");
if (!analysis.coverage) errors.push("coverage is required");
if (analysis.coverage?.events_total !== events.length) errors.push(`coverage.events_total must equal ${events.length}`);
if (analysis.coverage?.events_reviewed !== events.length) errors.push(`coverage.events_reviewed must equal ${events.length}`);
if (!Array.isArray(analysis.slugs)) errors.push("slugs must be an array");

const tokenModes = new Set(["exact", "lower_bound", "unavailable"]);
const timeModes = new Set(["exact", "elapsed_span", "lower_bound", "unavailable"]);
const severities = new Set(["low", "medium", "high", "critical"]);

for (const [index, slug] of (analysis.slugs ?? []).entries()) {
  const label = slug.id || `slug at index ${index}`;
  if (!slug.id) errors.push(`${label}: id is required`);
  if (!slug.category || !/^[a-z][a-z0-9_]*$/.test(slug.category)) errors.push(`${label}: category must be snake_case`);
  if (!slug.title || !slug.observed || !slug.hypothesis) errors.push(`${label}: title, observed, and hypothesis are required`);
  if (!severities.has(slug.severity)) errors.push(`${label}: invalid severity`);
  if (typeof slug.confidence !== "number" || slug.confidence < 0 || slug.confidence > 1) errors.push(`${label}: confidence must be between 0 and 1`);
  if (!Array.isArray(slug.evidence) || slug.evidence.length === 0) errors.push(`${label}: evidence is required`);
  for (const evidence of slug.evidence ?? []) {
    if (!ids.has(String(evidence.event_id))) errors.push(`${label}: unknown evidence event ${evidence.event_id}`);
  }
  if (!slug.waste || !Array.isArray(slug.waste.event_ids)) errors.push(`${label}: waste.event_ids is required`);
  for (const id of slug.waste?.event_ids ?? []) {
    if (!ids.has(String(id))) errors.push(`${label}: unknown waste event ${id}`);
  }
  if (!tokenModes.has(slug.waste?.token_measurement)) errors.push(`${label}: invalid token_measurement`);
  if (!timeModes.has(slug.waste?.time_measurement)) errors.push(`${label}: invalid time_measurement`);
  if (slug.waste?.tokens !== null && slug.waste?.token_measurement === "unavailable") errors.push(`${label}: non-null tokens cannot be unavailable`);
  if (slug.waste?.seconds !== null && slug.waste?.time_measurement === "unavailable") errors.push(`${label}: non-null seconds cannot be unavailable`);
  if (slug.replay !== null) {
    for (const field of ["task", "failure_condition", "success_condition"]) {
      if (!slug.replay?.[field]) errors.push(`${label}: replay.${field} is required`);
    }
  }
}

if (!analysis.totals) errors.push("totals is required");
if (analysis.totals && !tokenModes.has(analysis.totals.token_measurement)) errors.push("totals.token_measurement is invalid");
if (analysis.totals && !timeModes.has(analysis.totals.time_measurement)) errors.push("totals.time_measurement is invalid");
if (analysis.totals?.wasted_tokens !== null && analysis.totals?.token_measurement === "unavailable") errors.push("non-null total wasted_tokens cannot be unavailable");
if (analysis.totals?.wasted_seconds !== null && analysis.totals?.time_measurement === "unavailable") errors.push("non-null total wasted_seconds cannot be unavailable");
if ((analysis.slugs ?? []).length === 0) {
  if (analysis.totals?.wasted_tokens !== 0 || analysis.totals?.token_measurement !== "exact") {
    errors.push("an analysis with no slugs must report exact zero wasted_tokens");
  }
  if (analysis.totals?.wasted_seconds !== 0 || analysis.totals?.time_measurement !== "exact") {
    errors.push("an analysis with no slugs must report exact zero wasted_seconds");
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Valid analysis: ${analysis.slugs.length} slugs cite ${ids.size} transcript events.`);
