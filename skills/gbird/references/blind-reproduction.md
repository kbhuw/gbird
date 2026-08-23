# Blind reproduction protocol

Verify whether each historical failure still appears when a fresh coding agent works against the current repository without being told what gbird suspects.

## Prepare one clean revision

Fetch the target repository and record the exact commit SHA used for every attempt. Do not disturb the user's checkout. Create a disposable detached worktree for each attempt. All attempts in one report use the same SHA.

## Spawn a context-free worker

Spawn each reproduction worker without inherited conversation turns (`fork_turns: "none"` when supported). Give it only:

- its isolated worktree path;
- the failure's neutral `repro.prompt`;
- the neutral `repro.setup` needed to make the task possible;
- the reporting template below.

Do not give it the report, failure ID, title, category, historical sessions, hypothesis, failure condition, success condition, proposed guardrail, or another worker's result. Do not reveal that a particular behavior is under test.

Tell the worker it owns only its disposable worktree, is not alone in the codebase, and must not revert anyone else's work. It should perform the task normally, then return:

```json
{
  "task_outcome": "completed|blocked|failed",
  "summary": "what happened",
  "observed_actions": ["commands, searches, reads, edits, and checks actually performed"],
  "evidence": ["short concrete results that the parent can verify"],
  "limitations": []
}
```

The worker does not decide whether the hidden failure reproduced.

## Evaluate outside the worker

The parent compares the worker's result and worktree against the hidden `failure_condition` and `success_condition`.

- `reproduced`: the failure condition is observed and the success condition is not.
- `not_reproduced`: the success condition is observed and the failure condition is not.
- `inconclusive`: both, neither, or the task could not be completed.

If the first attempt is inconclusive, run one second fresh worker in a new worktree with the same neutral input. Conflicting decisive attempts are inconclusive.

Do not call a result reproduced merely because the final code is wrong. The observable agent behavior named by the failure condition must occur.

## Write the merge input

After evaluation, write one temporary `reproductions.json` bundle. The parent supplies the IDs and condition booleans; the worker never sees them.

```json
{
  "verification_schema_version": 1,
  "repo": "owner/repo",
  "verified_at": "2026-08-23T12:00:00.000Z",
  "checkout_sha": "full-git-sha",
  "results": [
    {
      "failure_id": "failure-001",
      "attempt_id": "failure-001-attempt-1",
      "checkout_sha": "full-git-sha",
      "agent": "codex-subagent",
      "task_outcome": "completed",
      "summary": "The worker completed the requested task.",
      "observed_actions": ["Read package.json before choosing a setup command."],
      "evidence": ["The documented setup command succeeded on the first attempt."],
      "failure_condition_observed": false,
      "success_condition_observed": true,
      "evaluation": "The fresh worker avoided the historical wrong-command behavior.",
      "limitations": []
    }
  ]
}
```

The merge command rejects missing failures, unknown failures, duplicate attempt IDs, mixed checkout SHAs, and a single inconclusive attempt. Delete the temporary bundle and disposable worktrees after the final HTML and JSON report are written.
