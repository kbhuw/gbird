---
name: gbird
description: Generate a complete, repo-scoped coding-agent failure report from available Codex and Devin sessions. Use when the user invokes $gbird, asks to audit a repository's coding-agent history, find recurring coding-agent failures, analyze past agent sessions for one repo, or produce neutral reproduction prompts for failures against the latest code.
---

# gbird

Run the bundled gbird engine for one repository. It discovers available Codex and Devin sessions, normalizes them, analyzes every matching session, groups equivalent historical failures, and writes one HTML report plus its evidence-preserving JSON source.

gbird analyzes the coding agent's behavior, not functional bugs in its code. Greptile owns code review. gbird looks for wrong commands, wasted searches, repeated work, ignored instructions, avoidable detours, poor tool use, skipped checks, user corrections, and early completion claims.

## Workflow

1. Resolve the repository from an explicit `owner/repo` supplied by the user. Otherwise read the current checkout's `origin` remote. Do not guess when neither exists.
2. Use the persistent database at `~/.gbird/gbird.db` unless the user supplies another database.
3. Run the bundled script from this skill directory:

```bash
node scripts/gbird.mjs report --repo owner/repo --db "$HOME/.gbird/gbird.db"
```

The script path above is relative to this `SKILL.md`, not the user's repository. Execute it using the skill's resolved absolute path when the current directory differs.

4. Let the command finish. It may analyze many sessions. Report meaningful progress, but do not substitute a partial report.
5. Return the final session count, failure count, recurring-pattern count, and clickable absolute paths to `report.html` and `report.json`.

## Evidence rules

- Include every retained per-session insight exactly once in the repo report.
- Group insights only when they represent the same agent weakness and share one observable replay test.
- Call a group recurring only when it appears in at least two distinct sessions.
- Preserve exact session and event references.
- Never invent token or time measurements.
- Exclude code defects that do not prove a specific avoidable action by the coding agent.
- Write the report in short, plain English and describe literal agent actions.
- Treat every listed item as a historical failure hypothesis until a fresh replay reproduces it.

## Reproduction prompts

Every failure must include one natural prompt for a fresh coding agent running against the latest repository checkout. Keep that prompt neutral. Do not reveal the historical failure, suspected cause, correct command, expected answer, or suggested guardrail. Put those details only in the separate failure and success conditions. The replay must test the fresh agent's behavior, not only whether its final code works.

Do not execute Daytona validation in this workflow. This skill generates the prompts and observable conditions that a later validator will run.
