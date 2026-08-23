# gbird

**Repo + coding-agent sessions → verified failure report.**

gbird finds where coding agents waste work: wrong commands, repeated searches, ignored instructions, skipped checks, user corrections, and early completion claims.

## How it works

1. Collect the Codex and Devin sessions for one repository.
2. Walk every session in order and catch evidence-backed failures.
3. Group the same failure across sessions.
4. Give each neutral test to a fresh subagent with no historical context.
5. Mark it `reproduced`, `not reproduced`, or `inconclusive`.

Historical evidence and fresh replay evidence remain separate. The replay worker never sees the suspected failure or the conditions used to judge it.

## Output

gbird writes exactly two files:

- `report.html` — the readable report
- `report.json` — the full evidence and replay results

## Run

Install the Codex plugin, then run from a repository checkout:

```text
$gbird
```

Or name the repository explicitly:

```text
$gbird owner/repo
```

For local development:

```bash
npm install
npm test
npm run build
npm run dev
```

The dashboard runs at `http://127.0.0.1:4189/`; the small product page is at `/about`.
