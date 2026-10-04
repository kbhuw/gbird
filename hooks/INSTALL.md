You are setting up gbird agent-trace capture for a teammate.
When their agent sessions end, the assembled trace is pushed to a git repo
via their own `gh` credentials, under
`sessions/<their-github-username>/<agent>/<session>.json`.

0. Pick the repo traces will land in — ask the human if they haven't already
   told you. Any repo the user can push to works (private recommended; a
   dedicated `agent-traces` repo keeps noise out of code repos). If they
   don't have one yet, create it:

     gh repo create agent-traces --private     # or <org>/agent-traces

   Call it TRACES_REPO (owner/name form, e.g. `myorg/agent-traces`).

1. Verify `gh` is installed and authenticated (this is also what stamps their
   name on traces and what ships them):

     gh auth status

   If unauthenticated, run `gh auth login` (or have the human do it).

2. Download the hook runtime and hooks config into ~/.gbird:

     mkdir -p ~/.gbird
     curl -fsSL https://raw.githubusercontent.com/kbhuw/gbird/main/hooks/gbird-hook.mjs -o ~/.gbird/gbird-hook.mjs
     curl -fsSL https://raw.githubusercontent.com/kbhuw/gbird/main/hooks/hooks.v1.json -o ~/.gbird/hooks.v1.json

3. Point the config at TRACES_REPO — in ~/.gbird/hooks.v1.json replace
   `REPLACE_WITH_YOUR_TRACES_REPO` (in the SessionEnd command) with
   `owner/name`, e.g. `GBIRD_REPO=myorg/agent-traces`.

4. Register the hooks with the agent harness (pick what applies on this machine):

   - Devin CLI / Desktop: merge ~/.gbird/hooks.v1.json into the "hooks" key of
     ~/.config/devin/config.json — or copy it to <repo>/.devin/hooks.v1.json
     for one repository.
   - Claude Code: merge ~/.gbird/hooks.v1.json into the "hooks" key of
     ~/.claude/settings.json.

5. Verify end to end — this should print "shipped gbird-selftest":

     echo '{"hook_event_name":"SessionStart","session_id":"gbird-selftest"}' | node ~/.gbird/gbird-hook.mjs record
     echo '{"hook_event_name":"SessionEnd","session_id":"gbird-selftest","reason":"selftest"}' | GBIRD_REPO=<TRACES_REPO> node ~/.gbird/gbird-hook.mjs ship

   Then confirm the file exists under `sessions/` in TRACES_REPO.

   If it prints "kept" instead of "shipped", the gh account can't write to
   that repo — fix the account's access (repo collaborator / org member).

The hook appends each agent event to ~/.gbird/live/ during the session and
ships the assembled trace at SessionEnd. It never throws — it cannot break
the agent. Traces stay on the local disk too (~/.gbird/sessions/) even when
shipping fails.
