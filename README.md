# gbird

**An agent trace store.** Pull coding-agent sessions into plain files you can keep forever.

gbird ingests Devin and Codex sessions, normalizes them into one event schema, and writes them to a directory — nothing else. Run it on a schedule and your trace history accumulates on its own; point an LLM at the directory later to hunt for behavioral patterns.

## The store

Everything lives under `GBIRD_DIR` (default `~/.gbird`):

```text
~/.gbird/
  index.json                     manifest: every session's metadata + source hashes
  sessions/
    devin/<session-id>.json      one normalized timeline per file
    codex/<session-id>.json
```

Each session file is a `SessionTimeline`: normalized session metadata plus every captured event (messages, tool calls, edits, commands, PR activity) in chronological order. Plain JSON, no database — commit the directory to git, rsync it, or read it directly.

## Pull

```bash
npm install
npm run pull                 # all configured sources, incremental
```

Incremental by default: Devin sessions are re-pulled only when `updated_at` moved, Codex rollout files only when their contents changed. `--force` re-pulls everything listed.

```bash
node dist/src/cli.js pull --source devin --all     # every Devin session
node dist/src/cli.js pull --source codex --limit 500
```

### Sources

- **Devin** — `DEVIN_API_KEY` + `DEVIN_ORG_ID` (save once with `npm run secret:save`, or put them in `.env`). Optionally enriches each session with its GitHub PR timeline when the `gh` CLI is available (`--no-github` to skip).
- **Codex** — reads rollout `.jsonl` files from `~/.codex/sessions` and `~/.codex/archived_sessions` (override with `CODEX_SESSIONS_ROOT`). No credentials needed.

## Read

```bash
node dist/src/cli.js list                      # newest first
node dist/src/cli.js list --repo owner/repo    # filter
node dist/src/cli.js list --json               # machine-readable
node dist/src/cli.js show <session-id>         # one full trace
node dist/src/cli.js path                      # store directory
```

## Automatic

The store is just files, so any scheduler works. A cron or scheduled agent that runs `gbird pull` and commits `~/.gbird` to a private repo gives you durable, versioned traces with zero infrastructure.

## Development

```bash
npm install
npm test
npm run build
```

Node ≥ 22.5.
