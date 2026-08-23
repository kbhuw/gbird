import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexRollout } from "../src/codex.js";

test("normalizes a Codex rollout without copying reasoning or raw tool payloads", () => {
  const records = [
    {
      timestamp: "2026-08-22T10:00:00Z",
      type: "session_meta",
      payload: {
        id: "thread-123",
        cwd: "/tmp/project",
        originator: "Codex Desktop",
        source: "vscode",
        model_provider: "openai",
        base_instructions: "do not copy this",
      },
    },
    {
      timestamp: "2026-08-22T10:00:01Z",
      type: "turn_context",
      payload: { cwd: "/tmp/project", model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-08-22T10:00:02Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    },
    {
      timestamp: "2026-08-22T10:00:03Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Fix the login race" },
    },
    {
      timestamp: "2026-08-22T10:00:04Z",
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Inspecting the auth path." },
    },
    {
      timestamp: "2026-08-22T10:00:05Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-1",
        status: "completed",
        input: "await tools.exec_command({cmd: 'contains a secret'})",
      },
    },
    {
      timestamp: "2026-08-22T10:00:06Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        success: true,
        changes: { "/tmp/project/src/auth.ts": { type: "update", content: "secret patch" } },
      },
    },
    {
      timestamp: "2026-08-22T10:00:07Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 5_000 },
    },
  ] as Parameters<typeof normalizeCodexRollout>[0];

  const normalized = normalizeCodexRollout(records, "/tmp/rollout.jsonl", () => "acme/project");
  assert.ok(normalized);
  assert.equal(normalized.session.agent, "codex");
  assert.equal(normalized.session.id, "codex:thread-123");
  assert.equal(normalized.session.title, "Fix the login race");
  assert.equal(normalized.session.status, "completed");
  assert.deepEqual(normalized.session.repositories, ["acme/project"]);
  assert.equal(JSON.stringify(normalized).includes("contains a secret"), false);
  assert.equal(JSON.stringify(normalized).includes("secret patch"), false);
  assert.ok(normalized.events.some((event) => event.type === "message_created" && event.data.messageSource === "codex"));
  assert.ok(normalized.events.some((event) => event.type === "tool_call" && event.data.toolCategory === "shell"));
  assert.ok(normalized.events.some((event) => event.type === "code_changed" && event.path === "src/auth.ts"));
  assert.ok(normalized.events.some((event) => event.type === "turn_completed" && event.status === "completed"));
});
