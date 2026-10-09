// `gbird install` — writes gbird's hook configs into a target repo, merging
// into any existing files rather than clobbering them. Re-running replaces
// only gbird's own entries (anything mentioning gbird), so it doubles as the
// upgrade path when the hook configs change.
import fs from "node:fs";
import path from "node:path";
import { repoHookConfigs, type ShipTarget } from "./repoconfig.js";

const GBIRD_MARK = /gbird/i;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop array entries that belong to gbird so the fresh generated entries
 * replace them cleanly (works at every level: hook groups containing command
 * strings, and plugin names like "kbhuw/gbird"). */
function mergeInto(existing: unknown, generated: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(generated)) {
    const kept = existing.filter((entry) => !GBIRD_MARK.test(JSON.stringify(entry)));
    return [...kept, ...generated];
  }
  if (isObject(existing) && isObject(generated)) {
    const out: JsonObject = { ...existing };
    for (const [key, value] of Object.entries(generated)) {
      out[key] = mergeInto(out[key], value);
    }
    return out;
  }
  // Preserve existing scalars (e.g. a repo's own "version"/"description")
  // and only fill in keys that are absent.
  return existing === undefined ? generated : existing;
}

function mergeFile(filePath: string, generatedJson: string, dryRun: boolean): "created" | "merged" | "unchanged" {
  const generated = JSON.parse(generatedJson) as unknown;
  let existing: unknown;
  let existed = false;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    existed = true;
  } catch {
    existing = {};
  }
  const merged = mergeInto(existing, generated);
  const rendered = `${JSON.stringify(merged, null, 2)}\n`;
  const previous = existed ? fs.readFileSync(filePath, "utf8") : undefined;
  if (previous === rendered) return "unchanged";
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, rendered);
  }
  return existed ? "merged" : "created";
}

export interface InstallResult {
  file: string;
  action: "created" | "merged" | "unchanged";
}

export function installIntoRepo(root: string, target: ShipTarget | string, dryRun = false): InstallResult[] {
  const configs = repoHookConfigs(target);
  const targets: Array<[string, string]> = [
    [".devin/hooks.v1.json", configs.devin],
    [".devin/hooks.json", configs.devin],
    [".devin/config.json", configs.devinConfig],
    [".claude/settings.json", configs.claude],
    [".cursor/hooks.json", configs.cursor],
    [".codex/hooks.json", configs.codex],
  ];
  return targets.map(([file, json]) => ({
    file,
    action: mergeFile(path.join(root, file), json, dryRun),
  }));
}
