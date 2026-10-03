import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NormalizedSession, SessionTimeline, TimelineEvent } from "../src/schema.js";
import { TraceStore } from "../src/tracestore.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gbird-store-"));
}

function session(id: string, overrides: Partial<NormalizedSession> = {}): NormalizedSession {
  return {
    schemaVersion: 1,
    agent: "devin",
    id,
    title: `Session ${id}`,
    prompt: null,
    status: "finished",
    statusDetail: null,
    origin: null,
    startedAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T11:00:00.000Z",
    acusConsumed: 0,
    url: null,
    repositories: ["owner/repo"],
    pullRequests: [],
    tags: [],
    raw: {},
    ...overrides,
  };
}

function event(id: string, sessionId: string, occurredAt = "2026-09-01T10:05:00.000Z"): TimelineEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    repo: "owner/repo",
    occurredAt,
    source: "devin",
    type: "message_created",
    title: "Model",
    status: null,
    commitSha: null,
    path: null,
    url: null,
    data: {},
  };
}

test("round-trips a session timeline through the file store", () => {
  const dir = tmpDir();
  const store = new TraceStore(dir);
  const s = session("devin-abc");
  store.upsertSession(s);
  store.upsertEvents([event("e1", s.id), event("e2", s.id, "2026-09-01T10:04:00.000Z")]);

  const timeline = store.getTimeline(s.id);
  assert.ok(timeline);
  assert.equal(timeline.session.id, s.id);
  assert.equal(timeline.events.length, 2);
  assert.equal(timeline.events[0]!.id, "e2"); // sorted by occurredAt
  assert.equal(timeline.events[1]!.id, "e1");

  const file = path.join(dir, "sessions", "devin", "devin-abc.json");
  assert.ok(fs.existsSync(file));
  const written = JSON.parse(fs.readFileSync(file, "utf8")) as SessionTimeline;
  assert.equal(written.events.length, 2);

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.equal(manifest.sessions["devin-abc"].eventCount, 2);
  assert.equal(manifest.sessions["devin-abc"].repositories[0], "owner/repo");
});

test("upsertSession preserves events already stored", () => {
  const dir = tmpDir();
  const store = new TraceStore(dir);
  const s = session("devin-abc");
  store.upsertSession(s);
  store.upsertEvents([event("e1", s.id)]);
  store.upsertSession({ ...s, status: "blocked" });

  const timeline = store.getTimeline(s.id);
  assert.equal(timeline?.events.length, 1);
  assert.equal(timeline?.session.status, "blocked");
});

test("upsertEvents merges by event id", () => {
  const dir = tmpDir();
  const store = new TraceStore(dir);
  const s = session("devin-abc");
  store.upsertSession(s);
  store.upsertEvents([event("e1", s.id)]);
  store.upsertEvents([{ ...event("e1", s.id), title: "Updated" }, event("e2", s.id)]);

  const timeline = store.getTimeline(s.id);
  assert.equal(timeline?.events.length, 2);
  assert.equal(timeline?.events.find((e) => e.id === "e1")?.title, "Updated");
});

test("lists and filters sessions via the manifest", () => {
  const dir = tmpDir();
  const store = new TraceStore(dir);
  store.upsertSession(session("devin-1", { repositories: ["owner/repo"] }));
  store.upsertSession(session("codex-1", { agent: "codex", repositories: ["other/x"], startedAt: "2026-09-02T10:00:00.000Z" }));

  assert.equal(store.countSessions(), 2);
  assert.equal(store.countSessions("codex"), 1);
  assert.deepEqual(store.listSessions({ agent: "devin" }).map((s) => s.id), ["devin-1"]);
  assert.deepEqual(store.listSessions({ repo: "other/x" }).map((s) => s.id), ["codex-1"]);
  assert.deepEqual(store.listRepos(), [
    { repo: "other/x", sessionCount: 1 },
    { repo: "owner/repo", sessionCount: 1 },
  ]);

  // newest first
  assert.deepEqual(store.listSessions().map((s) => s.id), ["codex-1", "devin-1"]);
});

test("persists across TraceStore instances and skips unchanged sources", () => {
  const dir = tmpDir();
  const rollout = path.join(tmpDir(), "rollout.jsonl");
  fs.writeFileSync(rollout, "{\"type\":\"session_meta\"}\n");

  const store = new TraceStore(dir);
  store.upsertSession(session("codex-1", { agent: "codex" }));
  store.recordSource(rollout, "codex-1");

  const reopened = new TraceStore(dir);
  assert.equal(reopened.lookupSource(rollout), "codex-1");
  assert.equal(reopened.getMeta("codex-1")?.agent, "codex");

  fs.appendFileSync(rollout, "{\"type\":\"event_msg\"}\n");
  assert.equal(reopened.lookupSource(rollout), null); // changed file = re-ingest
});
