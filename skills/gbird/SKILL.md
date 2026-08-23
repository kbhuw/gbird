---
name: gbird
description: Generate a complete, repo-scoped coding-agent failure report from available Codex and Devin sessions, then verify every candidate with context-free subagent replays. Use when the user invokes $gbird, asks to audit a repository's coding-agent history, find recurring coding-agent failures, analyze past agent sessions for one repo, or verify historical agent failures against the latest code.
---

# gbird

Run the bundled gbird engine for one repository. It discovers available Codex and Devin sessions, normalizes them, analyzes every matching session, groups equivalent historical failures, asks fresh subagents to replay each candidate without historical context, and writes one HTML report plus its evidence-preserving JSON source.

gbird analyzes the coding agent's behavior, not functional bugs in its code. Greptile owns code review. gbird looks for wrong commands, wasted searches, repeated work, ignored instructions, avoidable detours, poor tool use, skipped checks, user corrections, and early completion claims.

## Workflow

1. Resolve the repository from an explicit `owner/repo` supplied by the user. Otherwise read the current checkout's `origin` remote. Do not guess when neither exists.
2. Use the persistent database at `~/.gbird/gbird.db` unless the user supplies another database.
3. Inspect the available and already analyzed sessions before choosing a scope:

```bash
node scripts/gbird.mjs inventory --repo owner/repo --db "$HOME/.gbird/gbird.db"
```

4. Choose the scope from the inventory and the user's goal. Use `--all` for a complete audit, an explicit `--limit N` for a bounded recent pass, source-specific `--codex-limit N` and `--devin-limit N` when appropriate, or `--skip-sync` when the imported set is intentionally sufficient. Never accept a hidden default limit. Briefly state the choice and why.
5. Run the bundled script from this skill directory:

```bash
node scripts/gbird.mjs report --repo owner/repo --db "$HOME/.gbird/gbird.db" --all
```

The script path above is relative to this `SKILL.md`, not the user's repository. Execute it using the skill's resolved absolute path when the current directory differs.

6. Let the command finish. It may analyze many sessions. Fresh saved analyses are reused by timeline hash; only new or changed sessions are analyzed. Report meaningful progress, but do not substitute a partial report.
7. Read [references/blind-reproduction.md](references/blind-reproduction.md), then replay every candidate failure with fresh context-free subagents against one recorded checkout SHA.
8. Merge the replay results into the same report:

```bash
node scripts/gbird.mjs verify \
  --db "$HOME/.gbird/gbird.db" \
  --report /absolute/path/to/report.json \
  --results /absolute/path/to/reproductions.json
```

9. Return the chosen scope, final session count, failure count, reproduction counts, and clickable absolute paths to the final `report.html` and `report.json`. These are the only two product outputs.

## Evidence rules

- Include every retained per-session insight exactly once in the repo report.
- Group insights only when they represent the same agent weakness and share one observable replay test.
- Call a group recurring only when it appears in at least two distinct sessions.
- Preserve exact session and event references.
- Never invent token or time measurements.
- Exclude code defects that do not prove a specific avoidable action by the coding agent.
- Write the report in short, plain English and describe literal agent actions.
- Keep historical evidence separate from current replay evidence. A historical failure can be real even when it no longer reproduces on the latest checkout.

## Reproduction prompts

Every failure must include one natural prompt for a fresh coding agent running against the latest repository checkout. Keep that prompt neutral. Do not reveal the historical failure, suspected cause, correct command, expected answer, or suggested guardrail. Put those details only in the separate failure and success conditions. The replay must test the fresh agent's behavior, not only whether its final code works.

The parent agent owns the hidden conditions and verdict. The blind worker only attempts the neutral task and reports what it did. Never let a replay worker judge itself against a failure condition it has seen.
