import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HOOK = path.resolve(import.meta.dirname, "../src/hookentry.ts");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gbird-hook-"));
}

function runHook(dir: string, args: string[], stdin = ""): string {
  return execFileSync("node", ["--import", "tsx", HOOK, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, GBIRD_DIR: dir, GBIRD_AGENT: "devin" },
  });
}

test("record appends hook events and collect assembles a session file", () => {
  const dir = tmpDir();
  const sid = "devin-sess-1";

  runHook(dir, ["record"], JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: sid,
  }));
  runHook(dir, ["record"], JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: sid,
    prompt_id: "p1",
    prompt: "Fix the login race\nin auth.ts",
  }));
  runHook(dir, ["record"], JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: sid,
    prompt_id: "p1",
    tool_name: "exec",
    tool_input: { command: "npm test" },
    tool_response: { success: true, output: "9 passed", error: null },
  }));
  runHook(dir, ["record"], JSON.stringify({
    hook_event_name: "SessionEnd",
    session_id: sid,
    reason: "completed",
  }));

  const live = path.join(dir, "live", "devin", `${sid}.jsonl`);
  assert.equal(fs.readFileSync(live, "utf8").trim().split("\n").length, 4);

  const out = runHook(dir, ["collect"]);
  assert.match(out, /1 session\(s\) collected/);

  const file = path.join(dir, "sessions", "devin", `${sid}.json`);
  const timeline = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(timeline.session.id, sid);
  assert.equal(timeline.session.agent, "devin");
  assert.equal(timeline.session.title, "Fix the login race");
  assert.equal(timeline.session.status, "ended");
  assert.equal(timeline.session.statusDetail, "completed");
  assert.equal(timeline.events.length, 4);
  assert.deepEqual(
    timeline.events.map((e: { type: string }) => e.type),
    ["session_started", "message_created", "tool_call", "session_ended"],
  );
  assert.equal(timeline.events[2].data.toolName, "exec");

  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.equal(index.sessions[sid].eventCount, 4);
});

test("record ignores malformed input instead of failing", () => {
  const dir = tmpDir();
  runHook(dir, ["record"], "not json at all" as unknown as string);
  runHook(dir, ["record"], "");
  assert.ok(!fs.existsSync(path.join(dir, "live")));
});

test("tool failure marks the event status", () => {
  const dir = tmpDir();
  runHook(dir, ["record"], JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "devin-x",
    tool_name: "exec",
    tool_input: { command: "false" },
    tool_response: { success: false, output: "", error: "exit 1" },
  }));
  runHook(dir, ["collect"]);
  const timeline = JSON.parse(
    fs.readFileSync(path.join(dir, "sessions", "devin", "devin-x.json"), "utf8"),
  );
  assert.equal(timeline.events[0].status, "failure");
});
