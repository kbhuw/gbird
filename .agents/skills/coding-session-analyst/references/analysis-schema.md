# Session analysis schema

Write one JSON object with this structure:

```json
{
  "analysis_schema_version": 1,
  "session_id": "stable-session-id",
  "repo": "owner/repository-or-null",
  "outcome": {
    "status": "completed|partial|failed|abandoned|unknown",
    "summary": "Factual description of what the session delivered",
    "evidence_event_ids": ["event-id"]
  },
  "coverage": {
    "events_total": 0,
    "events_reviewed": 0,
    "events_with_token_usage": 0,
    "events_with_timing": 0,
    "limitations": []
  },
  "insights": [
    {
      "id": "insight-001",
      "category": "open-ended-snake-case-category",
      "title": "Specific, neutral title",
      "severity": "low|medium|high|critical",
      "confidence": 0.0,
      "observed": "Only what the evidence directly establishes",
      "why_it_matters": "Concrete effect on this session",
      "evidence": [
        {
          "event_id": "event-id",
          "occurred_at": "ISO timestamp or null",
          "kind": "message|tool_call|tool_result|edit|test|review|other",
          "summary": "Short factual description"
        }
      ],
      "waste": {
        "tokens": null,
        "token_measurement": "exact|lower_bound|unavailable",
        "seconds": null,
        "time_measurement": "exact|elapsed_span|lower_bound|unavailable",
        "event_ids": ["event-id"]
      },
      "hypothesis": "A falsifiable explanation for the observed issue",
      "counterevidence": [],
      "replay": {
        "task": "Prompt for a fresh coding agent",
        "setup": [],
        "failure_condition": "Observable condition that confirms recurrence",
        "success_condition": "Observable condition that rejects recurrence"
      }
    }
  ],
  "totals": {
    "wasted_tokens": null,
    "token_measurement": "exact|lower_bound|unavailable",
    "wasted_seconds": null,
    "time_measurement": "exact|elapsed_span|lower_bound|unavailable",
    "notes": []
  }
}
```

## Field rules

- `events_reviewed` should equal `events_total` after a complete analysis.
- `confidence` ranges from `0` to `1`.
- Evidence IDs must exist in the input transcript or be deterministic IDs assigned from stable event order.
- Each insight requires at least two evidence events unless one event is independently decisive, such as an explicit user correction or failed final check.
- `waste.event_ids` lists every event included in that insight's waste calculation.
- A non-null token count cannot use `unavailable`.
- A non-null seconds count cannot use `unavailable`.
- `totals` use the union of waste event IDs across insights; do not blindly add overlapping spans.
- If `insights` is empty because no avoidable work survived the skeptical pass, use exact zero for both totals. This is the measured size of an empty waste set.
- If avoidable work exists but its token cost cannot be attributed, use `wasted_tokens: null` with `token_measurement: "unavailable"`, not zero.
- If avoidable work exists but its duration cannot be attributed, use `wasted_seconds: null` with `time_measurement: "unavailable"`, not zero.
- `replay` may be `null` when the hypothesis cannot be isolated in a fresh coding session.
- `replay` is an unexecuted test specification. Its presence does not mean the hypothesis was reproduced.
- Store Daytona replay evidence separately; do not rewrite historical observations to make a hypothesis look confirmed.

## Outcome guidance

- `completed`: the requested artifact or answer was delivered and available evidence shows no unresolved blocker.
- `partial`: useful work was delivered but material requested work remained.
- `failed`: the requested outcome was not achieved because of a demonstrated failure.
- `abandoned`: work stopped without achieving the requested outcome and without a demonstrated terminal failure.
- `unknown`: the transcript does not establish the outcome.

Do not infer success from a final confident message alone. Prefer tests, tool results, resulting artifacts, PR state, or explicit user acceptance.
