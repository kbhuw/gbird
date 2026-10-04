#!/usr/bin/env bash
# Installs the gbird trace hook for this user.
#
#   ./hooks/install.sh
#
# Places the self-contained hook runtime at ~/.gbird/gbird-hook.mjs and the hook
# config at ~/.gbird/hooks.v1.json. Then point your agent at the config — it is
# NOT registered automatically because hook config lives in different places per
# agent harness (see the printed instructions).
set -euo pipefail

GBIRD_DIR="${GBIRD_DIR:-$HOME/.gbird}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$HERE/gbird-hook.mjs" ]; then
  echo "gbird-hook.mjs is missing — run 'npm run build' first." >&2
  exit 1
fi

mkdir -p "$GBIRD_DIR"
cp "$HERE/gbird-hook.mjs" "$GBIRD_DIR/gbird-hook.mjs"
cp "$HERE/hooks.v1.json" "$GBIRD_DIR/hooks.v1.json"

cat <<EOF
Installed:
  $GBIRD_DIR/gbird-hook.mjs
  $GBIRD_DIR/hooks.v1.json

Register the hooks with each agent:

  Devin CLI / Desktop (all projects):
    merge $GBIRD_DIR/hooks.v1.json into ~/.config/devin/config.json under "hooks"

  Devin CLI / Desktop (one repo):
    cp $GBIRD_DIR/hooks.v1.json <repo>/.devin/hooks.v1.json

  Claude Code (user-level):
    merge $GBIRD_DIR/hooks.v1.json into ~/.claude/settings.json under "hooks"

  Codex: the rollout files already land in ~/.codex/sessions — see the README's
  Codex section for keeping them pulled automatically (notify hook or cron).

Optional, for traces to leave this machine:
  export GBIRD_REPO=owner/repo   # SessionEnd pushes sessions/<agent>/<id>.json
                                 # via the gh CLI to that repo
EOF
