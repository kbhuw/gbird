import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installIntoRepo } from "../src/install.js";

const REPO = "DevelopIQ-ai/puffle-traces";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gbird-install-"));
}

test("install writes all six configs into a fresh repo and is idempotent", () => {
  const root = tmpdir();
  const first = installIntoRepo(root, REPO);
  assert.equal(first.length, 6);
  assert.ok(first.every((r) => r.action === "created"));

  const devin = JSON.parse(fs.readFileSync(path.join(root, ".devin/hooks.v1.json"), "utf8"));
  assert.ok(JSON.stringify(devin).includes(REPO));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".devin/config.json"), "utf8"));
  assert.deepEqual(plugin.requiredPlugins, ["kbhuw/gbird"]);

  const second = installIntoRepo(root, REPO);
  assert.ok(second.every((r) => r.action === "unchanged"));
});

test("install preserves foreign entries and replaces stale gbird entries", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".devin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".devin/hooks.v1.json"),
    JSON.stringify({
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "echo foreign" }] },
        { matcher: "", hooks: [{ type: "command", command: "node $HOME/.gbird/gbird-hook.mjs record" }] },
      ],
      PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo other" }] }],
    }),
  );
  fs.writeFileSync(
    path.join(root, ".devin/config.json"),
    JSON.stringify({ requiredPlugins: ["kbhuw/gbird", "other/plugin"], other: true }),
  );

  installIntoRepo(root, REPO);
  const devin = JSON.parse(fs.readFileSync(path.join(root, ".devin/hooks.v1.json"), "utf8"));
  const sessionStart = JSON.stringify(devin.SessionStart);
  assert.ok(sessionStart.includes("echo foreign"), "foreign hook kept");
  assert.ok(sessionStart.includes("gbird-hook v4"), "current gbird hook installed");
  assert.equal(devin.SessionStart.length, 2, "stale gbird group replaced, not duplicated");
  assert.ok(JSON.stringify(devin.PreToolUse).includes("echo other"), "untouched events preserved");

  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".devin/config.json"), "utf8"));
  assert.deepEqual(plugin.requiredPlugins.sort(), ["kbhuw/gbird", "other/plugin"]);
  assert.equal(plugin.other, true);
});

test("install merges into existing .claude/settings.json without clobbering other keys", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude/settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(*)"] }, hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo theirs" }] }] } }),
  );
  installIntoRepo(root, REPO);
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(*)"] });
  const sessionStart = JSON.stringify(settings.hooks.SessionStart);
  assert.ok(sessionStart.includes("echo theirs"));
  assert.ok(sessionStart.includes("gbird-hook"));
});

test("endpoint target emits GBIRD_ENDPOINT/GBIRD_TOKEN instead of GBIRD_REPO", () => {
  const root = tmpdir();
  installIntoRepo(root, { endpoint: "https://traces.example.com:8780", token: "tok123" });
  const devin = JSON.parse(fs.readFileSync(path.join(root, ".devin/hooks.v1.json"), "utf8"));
  const text = JSON.stringify(devin);
  assert.ok(text.includes("GBIRD_ENDPOINT=https://traces.example.com:8780"));
  assert.ok(text.includes("GBIRD_TOKEN=tok123"));
  assert.ok(!text.includes("GBIRD_REPO="));

  const root2 = tmpdir();
  installIntoRepo(root2, { endpoint: "https://traces.example.com" });
  const text2 = JSON.stringify(JSON.parse(fs.readFileSync(path.join(root2, ".devin/hooks.v1.json"), "utf8")));
  assert.ok(text2.includes("GBIRD_ENDPOINT="));
  assert.ok(!text2.includes("GBIRD_TOKEN="), "no token key emitted when unset");
});

test("dry run reports actions without writing", () => {
  const root = tmpdir();
  const results = installIntoRepo(root, REPO, true);
  assert.ok(results.every((r) => r.action === "created"));
  assert.equal(fs.existsSync(path.join(root, ".devin")), false);
});
