---
name: coding-session-analyst
description: Analyze structured Codex, Devin, Claude Code, Cursor, or other coding-agent session transcripts one session at a time. Use this whenever the user wants to find where a coding agent failed, wasted tokens or time, looped, churned, misunderstood requirements, used tools poorly, validated inadequately, stopped prematurely, or needs evidence-backed hypotheses and replay tests. Also use for repo-scoped session audits and failure analysis even when the user does not explicitly say "transcript analysis." Do not use for ordinary code review or transcript parsing alone.
---

# Coding Session Analyst

Analyze one normalized coding-agent session as an ordered execution trace. The goal is to find specific places where the session became less effective, quantify the avoidable work when the data permits it, and turn each supported observation into a testable failure hypothesis.

## Scope: analyze the agent, not its code

Keep only failures in how the coding agent worked with the repository. Examples:

- ran the wrong command or repeated a failed command without learning anything;
- searched the wrong place or took an avoidable detour before finding the right file;
- ignored repository instructions or an explicit user requirement;
- repeated, reverted, or replaced work that could have been avoided;
- used a tool poorly, skipped an available check, or claimed completion too early;
- needed the user or reviewer to correct an approach the transcript shows it could have caught earlier.

Do not report a functional bug, missing feature, security issue, bad architecture choice, failed test, CI error, or Greptile finding by itself. Greptile owns code review. Such events are evidence only when they prove a specific avoidable behavior by the agent. For example:

- out of scope: "The code removed an authorization check."
- in scope: "The agent edited authorization code without first reading the repository's existing authorization pattern, then needed three review rounds to repair it."

Every retained insight must answer: **what did the agent do that wasted time or caused avoidable rework?** If the transcript cannot answer that, drop the insight.

This skill generates hypotheses from historical evidence. It does not prove that a failure still exists. Proof comes later from a fresh-agent replay in a clean Daytona sandbox.

The primary artifact is a per-session analysis. Each retained insight is called a **slug** in gbird: one evidence-backed suspected failure or avoidable-work episode. Cross-session patterns come later by grouping these outputs by repository.

## Inputs

The canonical input is the normalized structured session output produced by the ingestion layer, not a raw provider transcript. If the input is still provider-specific, run the appropriate ingestion adapter first.

Accept normalized JSON or JSONL containing some combination of:

- user and model messages;
- tool calls and results;
- file reads and edits;
- commands, exit codes, errors, and test results;
- timestamps, durations, and token usage;
- commits, pull requests, CI results, or review comments.

Do not require every field. Report missing coverage instead of filling gaps with guesses.

Analyze exactly one session per output document. If the input contains several sessions, split them first and produce one analysis for each session.

## Workflow

### 1. Inspect the shape

Before interpreting the session, inspect its type, event count, available identifiers, timing fields, and token fields. For JSON or JSONL, prefer `jq` so the original file remains untouched.

Determine:

- the stable session ID and repository;
- the chronological ordering field (`sequence`, `index`, timestamp, or file order);
- which events have stable IDs;
- whether token and duration measurements are event-level, turn-level, session-level, or absent.

If events lack IDs, create deterministic analysis-local IDs from their sequence such as `event-0001`. Never cite a display row number that could change after sorting.

### 2. Walk the entire transcript chronologically

Review every event in order. Maintain a compact ledger of:

- the current user goal and explicit constraints;
- what the agent is trying to do;
- new evidence learned from tools;
- files or systems affected;
- errors and validation results;
- course corrections, abandoned approaches, and completion claims.

Do not jump directly from the opening prompt to the final answer. Failures often appear in the transition between attempts.

### 3. Generate candidate issues

Look broadly. Useful categories include, but are not limited to:

- `reasoning_failure`
- `planning_failure`
- `wasted_exploration`
- `tool_problem`
- `incorrect_assumption`
- `implementation_churn`
- `missed_requirement`
- `user_correction`
- `validation_failure`
- `premature_completion`
- `blocked_or_abandoned`

Create a category outside this list when the evidence warrants it. The taxonomy is flexible; the evidence contract is not.

Common signals include:

- an identical read, search, or command repeated without changed inputs;
- repeated failures with no new diagnostic information between attempts;
- work that is later reverted, superseded, or abandoned;
- a user correction that rejects completed work or restates an ignored constraint;
- tests rerun without an intervening relevant change;
- a completion claim followed by material unfinished work or a failure;
- broad exploration whose outputs are never used;
- rebuilding context after avoidable context loss;
- solving a different problem from the one requested;
- a tool, permission, environment, or repository setup problem that dominates the run.

A code-review comment is not automatically a signal. Identify the agent action that led to avoidable work. If only the code defect is visible and the transcript does not show the agent's process mistake, leave it to Greptile and do not retain it.

Necessary exploration is not waste merely because it takes time. A retry after changed inputs or new evidence may be progress. Judge the sequence, not isolated events.

### 4. Measure waste without fake precision

Count work as avoidable only when the transcript shows why it did not contribute or why a shorter path was already available.

For tokens:

- Sum explicit token usage attached to the implicated events or enclosing turns.
- Use `exact` only when those values are directly recorded.
- Use `lower_bound` when only part of the episode has recorded usage.
- Use `unavailable` and `null` when the transcript has no attributable token data.
- Never estimate tokens from character count, message length, model pricing, or intuition.

For time:

- Prefer explicit duration fields.
- Otherwise use the timestamp span from the first avoidable action through its recovery, labeled `elapsed_span`.
- Do not call an elapsed span active work time.
- Use `unavailable` and `null` when ordering or timestamps are insufficient.

When insights overlap, session totals must use the union of implicated event IDs so the same tokens or time are not counted twice.

If the skeptical pass retains no avoidable work at all, report exact zero wasted tokens and exact zero wasted seconds. That zero describes an empty waste set; it does not estimate the cost of any event. If waste exists but its cost is not recorded, use `null` and `unavailable` instead.

### 5. Perform a skeptical second pass

Challenge every candidate before keeping it:

- What exact events prove the observation?
- Was the allegedly wasted work necessary exploration?
- Did the agent change inputs or learn something before retrying?
- Is there counterevidence elsewhere in the session?
- Can the token or time cost actually be attributed?
- Does the hypothesis go beyond what was observed?

Drop weak candidates. Lower confidence when a plausible alternative explanation remains. A small set of strong findings is better than a comprehensive-looking list of speculation.

### 6. Create a replay specification

For each retained insight, propose a fresh coding-session task that can test whether the same weakness still exists in the repository today.

The replay must specify:

- the task to give the fresh agent;
- any required setup that does not reveal the hypothesis;
- the observable failure condition;
- the observable success condition.

The replay must test the fresh agent's behavior. Observe its commands, searches, tool choices, retries, corrections, checks, and completion claim. Do not use final code correctness as the only failure condition.

Do not bake the historical evidence, hypothesis, answer, or proposed fix into the replay prompt. The point is to see whether the failure naturally repeats.

If the hypothesis cannot be isolated in a fresh session, set `replay` to `null` and explain why in `counterevidence` or `limitations`.

Stop after producing the replay specification. A separate validation runner will:

1. create a clean Daytona sandbox;
2. check out and record the exact repository commit being tested;
3. give a fresh coding agent only the replay task and neutral setup;
4. capture that run as another normalized structured session;
5. evaluate the recorded failure and success conditions;
6. classify the hypothesis as `reproduced`, `not_reproduced`, or `inconclusive`.

Until that replay finishes, call every retained item a hypothesis or suspected failure, never a confirmed recurring failure. Propose a repository guardrail only after reproduction.

## Evidence contract

Every insight must separate:

- `observed`: what directly happened;
- `hypothesis`: the proposed underlying weakness;
- `counterevidence`: facts that weaken or qualify the hypothesis;
- `evidence`: exact transcript events supporting the observation.

Evidence summaries should be short and factual. Quote only the minimum useful text. Never expose secrets, credentials, hidden reasoning, or large raw tool payloads.

Write titles, observations, hypotheses, and replay conditions in short, plain English. Describe literal actions. Avoid abstract engineering jargon.

An event occurring before a failure does not by itself establish causality. Phrase unsupported causal claims as hypotheses.

## Output

Read [references/analysis-schema.md](references/analysis-schema.md), then write a single JSON object matching it. Save the result as `session-analysis.json` unless the user provides another path.

After writing the analysis, validate it:

```bash
node scripts/validate-analysis.mjs <transcript.json-or-jsonl> <session-analysis.json>
```

Fix validation errors before returning the result.

Return a compact human summary containing:

- session outcome;
- number of retained insights (slugs);
- measured waste, explicitly noting unavailable coverage;
- the strongest insight and its replay test;
- the saved analysis path.

Do not turn normal agent activity into pathology. Do not invent measurements to make the report look complete.
