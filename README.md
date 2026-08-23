# gbird

**gbird catches slugs.**

A slug is one evidence-backed place where a coding-agent session wasted work, failed, looped, misunderstood a requirement, or needed a user correction.

gbird ingests Codex and Devin sessions into a repo-filtered timeline, joins them with GitHub PRs, commits, CI checks, reviews, and Greptile comments, then analyzes each session chronologically to catch slugs. Every slug cites the exact events that support it, measures attributable token/time waste without guessing, and includes a clean replay test.

The ingestion and timeline UI are executable now. The slug-analysis contract and validator live in `skills/coding-session-analyst/`; wiring that analyzer into the server is the next vertical slice.

## Run the UI with demo data

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4189`.

The product site is available at `http://127.0.0.1:4189/about`; the session dashboard remains at `/`.

## Import real sessions

Import the 50 most recent local Codex tasks:

```bash
npm run sync:codex
```

The Codex importer intentionally excludes hidden reasoning, raw tool arguments, tool output, and patch contents.

To import Devin sessions, create a Devin service-user token with `ViewOrgSessions`, then configure only the non-secret organization ID:

```bash
cp .env.example .env
```

Set `DEVIN_ORG_ID` in `.env`. Save the token to macOS Keychain through Secret Valet's hidden terminal prompt:

```bash
npm run secret:save
npm run sync:secure
npm run build
npm run start:secure
```

GitHub data uses the locally authenticated `gh` CLI. The local SQLite database is stored at `.data/gbird.db`. The Devin credential is injected only at runtime and is never stored in the project or timeline.

## Normalized output

Each session can be downloaded from the UI as JSON:

```json
{
  "session": {
    "schemaVersion": 1,
    "agent": "codex",
    "id": "codex:…",
    "repositories": ["owner/repo"]
  },
  "events": [
    {
      "schemaVersion": 1,
      "source": "codex",
      "type": "message_created",
      "occurredAt": "2026-08-22T16:08:00.000Z",
      "data": {}
    }
  ]
}
```

## Failure hypotheses

Open a session and press **Analyze**. gbird gives that session's normalized JSON timeline to the bundled `coding-session-analyst` skill through an ephemeral, read-only Codex run. The result is stored in SQLite and shown above the event timeline.

Each hypothesis contains exact evidence event IDs, conservative token/time accounting, counterevidence, and a neutral replay specification. Evidence buttons jump to the supporting timeline node.

This stage does not claim a recurring failure. A later validator will run the replay task with a fresh coding agent in a clean Daytona sandbox and classify it as `reproduced`, `not_reproduced`, or `inconclusive`.
