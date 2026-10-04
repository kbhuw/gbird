// Generates the hook configs committed into a "gbird'd" repo. One source of
// truth shared by the /install prompt (server.ts) and anything that writes the
// files directly, so what the website instructs an agent to write is byte-for-
// byte what the tool itself produces.

export interface RepoHookConfigs {
  /** .devin/hooks.v1.json (Devin CLI) and .devin/hooks.json (Devin Desktop). */
  devin: string;
  /** .claude/settings.json (Claude Code — merge "hooks" if the file exists). */
  claude: string;
  /** .cursor/hooks.json (Cursor). */
  cursor: string;
}

const HOOK_VERSION_MARKER = "gbird-hook v2";
const HOOK_URL =
  "https://raw.githubusercontent.com/kbhuw/gbird/e842f0594027b6900927760c4d73f2bd0adce3c8/hooks/gbird-hook.mjs";

export function repoHookConfigs(tracesRepo: string): RepoHookConfigs {
  const record = (agent: string) => `GBIRD_AGENT=${agent} node "$HOME/.gbird/gbird-hook.mjs" record`;
  const bootstrap = (agent: string) =>
    `mkdir -p "$HOME/.gbird" && { ([ -f "$HOME/.gbird/gbird-hook.mjs" ] && grep -q "${HOOK_VERSION_MARKER}" "$HOME/.gbird/gbird-hook.mjs") || { t="$HOME/.gbird/gbird-hook.mjs.$$.tmp" && curl -fsSL ${HOOK_URL} -o "$t" && mv -f "$t" "$HOME/.gbird/gbird-hook.mjs"; }; } && ${record(agent)} || true`;
  const ship = (agent: string) =>
    `GBIRD_REPO=${tracesRepo} GBIRD_AGENT=${agent} node "$HOME/.gbird/gbird-hook.mjs" ship`;
  const devinEvent = (command: string) => ({ matcher: "", hooks: [{ type: "command", command }] });

  return {
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
  };
}
