// Generates the hook configs committed into a "gbird'd" repo. One source of
// truth shared by the /install prompt (server.ts) and anything that writes the
// files directly, so what the website instructs an agent to write is byte-for-
// byte what the tool itself produces.

export interface RepoHookConfigs {
  /** .devin/hooks.v1.json (Devin CLI) and .devin/hooks.json (Devin Desktop). */
  devin: string;
  /** .devin/config.json — requires the gbird plugin so CLOUD Devin sessions on
   * this repo load its hooks too (repos declare plugins per-checkout; the
   * local hook files below never load in cloud). Merge if the file exists. */
  devinConfig: string;
  /** .claude/settings.json (Claude Code — merge "hooks" if the file exists). */
  claude: string;
  /** .cursor/hooks.json (Cursor). */
  cursor: string;
  /** .codex/hooks.json (Codex CLI — user trusts the hook once via /hooks). */
  codex: string;
}

const HOOK_VERSION_MARKER = "gbird-hook v4";
const HOOK_URL =
  "https://raw.githubusercontent.com/kbhuw/gbird/aca5189839b87b4333fa10e1b9e90baf95f2c642/hooks/gbird-hook.mjs";

export function repoHookConfigs(tracesRepo: string): RepoHookConfigs {
  // Every hook command re-verifies the runtime before running it: a failed
  // SessionStart download must not wedge capture for the whole session, and the
  // curl is time-bounded so an unresponsive endpoint cannot stall the agent.
  const ensure =
    `mkdir -p "$HOME/.gbird" && { ([ -f "$HOME/.gbird/gbird-hook.mjs" ] && grep -q "${HOOK_VERSION_MARKER}" "$HOME/.gbird/gbird-hook.mjs") || { t="$HOME/.gbird/gbird-hook.mjs.$$.tmp" && curl -fsSL --connect-timeout 3 --max-time 15 ${HOOK_URL} -o "$t" && mv -f "$t" "$HOME/.gbird/gbird-hook.mjs"; }; }`;
  // Always-on by default; a developer opts OUT with GBIRD_HOOKS=0 in their
  // environment. Capture is a repo-level decision, but individuals keep an
  // escape hatch when session contents must stay local.
  const off = `[ "\${GBIRD_HOOKS:-1}" = "0" ] && exit 0; `;
  const record = (agent: string) => `${off}${ensure} && GBIRD_AGENT=${agent} node "$HOME/.gbird/gbird-hook.mjs" record || true`;
  const bootstrap = record;
  const ship = (agent: string) =>
    `${off}${ensure} && GBIRD_REPO=${tracesRepo} GBIRD_AGENT=${agent} node "$HOME/.gbird/gbird-hook.mjs" ship || true`;
  const devinEvent = (command: string) => ({ matcher: "", hooks: [{ type: "command", command }] });

  return {
    devinConfig: JSON.stringify({ requiredPlugins: ["kbhuw/gbird"] }, null, 2),
    devin: JSON.stringify(
      {
        SessionStart: [devinEvent(bootstrap("devin"))],
        UserPromptSubmit: [devinEvent(record("devin"))],
        PostToolUse: [devinEvent(record("devin"))],
        SessionEnd: [devinEvent(ship("devin"))],
      },
      null,
      2,
    ),
    claude: JSON.stringify(
      {
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: bootstrap("claude") }] }],
          UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: record("claude") }] }],
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: record("claude") }] }],
          SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: ship("claude") }] }],
        },
      },
      null,
      2,
    ),
    cursor: JSON.stringify(
      {
        version: 1,
        hooks: {
          sessionStart: [{ command: bootstrap("cursor") }],
          beforeSubmitPrompt: [{ command: record("cursor") }],
          postToolUse: [{ command: record("cursor") }],
          sessionEnd: [{ command: ship("cursor") }],
        },
      },
      null,
      2,
    ),
    codex: JSON.stringify(
      {
        description: "gbird agent-trace capture",
        hooks: {
          SessionStart: [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: bootstrap("codex") }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: record("codex") }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: record("codex") }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: ship("codex") }] }],
        },
      },
      null,
      2,
    ),
  };
}
