import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDevinSession } from "../src/devin.js";

test("normalizes a Devin session and its messages into stable timeline events", () => {
  const result = normalizeDevinSession({
    session_id: "devin-test",
    title: "Fix auth",
    status: "finished",
    status_detail: "finished",
    origin: "webapp",
    created_at: 1_756_000_000,
    updated_at: 1_756_000_300,
    acus_consumed: 2.5,
    tags: ["repo:DevelopIQ-ai/puffle-app"],
    pull_requests: [{
      pr_state: "merged",
      pr_url: "https://github.com/DevelopIQ-ai/puffle-app/pull/123",
    }],
  }, [{
    event_id: "message-1",
    created_at: 1_756_000_001,
    source: "user",
    message: "Please fix auth.",
  }]);

  assert.equal(result.session.id, "devin-test");
  assert.deepEqual(result.session.repositories, ["DevelopIQ-ai/puffle-app"]);
  assert.equal(result.session.pullRequests[0]?.number, 123);
  assert.equal(result.session.prompt, "Please fix auth.");
  assert.deepEqual(result.events.map((event) => event.type), [
    "session_started",
    "message_created",
    "session_updated",
  ]);
  assert.equal(result.events[1]?.data.message, "Please fix auth.");
  assert.equal(result.events[1]?.title, "You");
});

test("keeps sessions without a PR visible as unlinked", () => {
  const result = normalizeDevinSession({
    session_id: "devin-unlinked",
    status: "running",
    created_at: "2026-08-22T10:00:00Z",
    updated_at: "2026-08-22T10:01:00Z",
  }, []);

  assert.deepEqual(result.session.repositories, []);
  assert.equal(result.session.title, "Untitled Devin session");
  assert.ok(result.events.every((event) => event.repo === null));
});
