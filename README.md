# gbird

**An agent trace store.** Sessions record themselves into plain files — via lifecycle hooks where available, via `pull` for everything else.

Traces land under `GBIRD_DIR` (default `~/.gbird`) as one normalized JSON timeline per session: session metadata plus every captured event (prompts, tool calls, outputs, edits, PR activity) in chronological order. No database, no server — commit the directory to git, rsync it, or point an LLM at it later.

## Capture: the hook

`hooks/` ships a self-contained runtime (`gbird-hook.mjs`, ~250 lines, zero deps) that any agent harness with lifecycle hooks can call:

```bash
./hooks/install.sh        # drops gbird-hook.mjs + hooks.v1.json into ~/.gbird
```

then register `hooks.v1.json` with the agent:

- **Devin CLI / Desktop** — merge into `~/.config/devin/config.json` under `"hooks"`, or drop at `<repo>/.devin/hooks.v1.json` for one repo. (Plugin `hooks.json` also works for local sessions.)
- **Claude Code** — merge into `~/.claude/settings.json` under `"hooks"` (same format).
- **Codex** — no lifecycle hooks, but rollouts already land in `~/.codex/sessions`; keep them pulled with `notify` in `config.toml` or a cron: `gbird pull --source codex`.

Wired events: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `SessionEnd`. Each call appends one normalized event to `~/.gbird/live/<agent>/<session>.jsonl`. At `SessionEnd`, `ship` assembles `sessions/<agent>/<id>.json` and updates `index.json`.

### Leaving the machine

On ephemeral VMs the store dies with the box, so `ship` can push the assembled trace to a private repo:

```bash
export GBIRD_REPO=owner/agent-traces   # requires gh auth with write access
```

`ship` uploads `sessions/<agent>/<id>.json` via the GitHub contents API — no clone needed. Without `GBIRD_REPO`, traces stay local.

## Capture: pull (backfill)

`pull` ingests finished sessions the hook didn't see — history, other machines, sources without hooks:

```bash
npm install
npm run pull                         # all configured sources, incremental
node dist/src/cli.js pull --source devin --all
```

- **Devin** — `DEVIN_API_KEY` + `DEVIN_ORG_ID` (`npm run secret:save` once, or `.env`). Optionally enriches with GitHub PR timelines via `gh` (`--no-github` to skip).
- **Codex** — rollout `.jsonl` files from `~/.codex/sessions` + `archived_sessions` (`CODEX_SESSIONS_ROOT` to override).

Incremental: Devin sessions re-pull only when `updated_at` moves; Codex rollouts only when file contents change (`--force` overrides).

## Read

```bash
node dist/src/cli.js list                      # newest first
node dist/src/cli.js list --repo owner/repo --agent devin --json
node dist/src/cli.js show <session-id>         # one full trace
node dist/src/cli.js path                      # store directory
node dist/src/cli.js hook collect              # fold live hook logs into session files
```

## Layout

```text
~/.gbird/
  index.json                     manifest: session metadata (rebuilt by collect/pull)
  live/<agent>/<id>.jsonl        raw hook event stream, append-only
  sessions/<agent>/<id>.json     one normalized timeline per session
  gbird-hook.mjs                 installed hook runtime
```

## Development

```bash
npm install
npm test
npm run build        # also regenerates hooks/gbird-hook.mjs from src/hookentry.ts
```

`src/hookentry.ts` is deliberately self-contained (node builtins only) so its compiled output *is* the portable hook script — don't import other `src/` modules from it.

Node ≥ 22.5.
