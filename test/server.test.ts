import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mintMember } from "../src/members.js";
import { createGbirdServer } from "../src/server.js";
import type { SessionTimeline } from "../src/schema.js";

const HOOK = path.resolve(import.meta.dirname, "../src/hookentry.ts");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gbird-server-"));
}

function makeTimeline(id: string, title: string): SessionTimeline {
  const now = new Date().toISOString();
  return {
    session: {
      schemaVersion: 1,
      agent: "devin",
      id,
      title,
      prompt: "do the thing",
      status: "ended",
      statusDetail: "completed",
      origin: "hook",
      startedAt: now,
      updatedAt: now,
      acusConsumed: 0,
      url: null,
      repositories: ["owner/repo"],
      pullRequests: [],
      tags: [],
      raw: {},
    },
    events: [
      {
        schemaVersion: 1,
        id: "e1",
        sessionId: id,
        repo: null,
        type: "message_created",
        title: "user message",
        status: "success",
        occurredAt: now,
        source: "hook",
        commitSha: null,
        path: null,
        url: null,
        data: { messageText: "hi" },
      },
    ],
  };
}

async function withServer(
  dir: string,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createGbirdServer({ dir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("POST /v1/traces stores a trace and it is queryable via the API", async () => {
  const dir = tmpDir();
  const member = mintMember(dir, "kush");
  await withServer(dir, async (baseUrl) => {
    const post = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" },
      body: JSON.stringify(makeTimeline("devin-s1", "fix login")),
    });
    assert.equal(post.status, 201);

    const list = await (await fetch(`${baseUrl}/api/sessions`)).json();
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].id, "devin-s1");
    assert.equal(list.sessions[0].member, "kush");

    const filtered = await (await fetch(`${baseUrl}/api/sessions?member=kush`)).json();
    assert.equal(filtered.sessions.length, 1);
    const none = await (await fetch(`${baseUrl}/api/sessions?member=nobody`)).json();
    assert.equal(none.sessions.length, 0);

    const detail = await (await fetch(`${baseUrl}/api/sessions/devin-s1`)).json();
    assert.equal(detail.member, "kush");
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].data.messageText, "hi");

    const members = await (await fetch(`${baseUrl}/api/members`)).json();
    assert.equal(members.members[0].name, "kush");
    assert.ok(!("token" in members.members[0]), "member list must not leak tokens");

    // Stored on disk as files.
    assert.ok(fs.existsSync(path.join(dir, "sessions", "devin", "devin-s1.json")));
  });
});

test("POST /v1/traces rejects unknown and missing tokens", async () => {
  const dir = tmpDir();
  mintMember(dir, "kush");
  await withServer(dir, async (baseUrl) => {
    for (const headers of [{} as Record<string, string>, { authorization: "Bearer bogus" }]) {
      const res = await fetch(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(makeTimeline("x", "x")),
      });
      assert.equal(res.status, 401);
    }
  });
});

test("install page serves a self-setup prompt and hook assets", async () => {
  const dir = tmpDir();
  const member = mintMember(dir, "kush");
  await withServer(dir, async (baseUrl) => {
    const prompt = await (await fetch(`${baseUrl}/install/${member.token}.md`)).text();
    assert.match(prompt, /gbird agent-trace capture for kush/);
    assert.match(prompt, new RegExp(member.token));

    const bad = await fetch(`${baseUrl}/install/not-a-token`);
    assert.equal(bad.status, 404);

    const hooks = await (await fetch(`${baseUrl}/v1/hooks.v1.json?token=${member.token}`)).json();
    const cmd = hooks.SessionEnd[0].hooks[0].command as string;
    assert.match(cmd, /GBIRD_TOKEN=gbird_/);
    assert.match(cmd, /ship/);
  });
});

test("hook ship posts the assembled trace to the server end to end", async () => {
  const dir = tmpDir();
  const member = mintMember(dir, "kush");
  const hookDir = tmpDir();
  const env = {
    ...process.env,
    GBIRD_DIR: hookDir,
    GBIRD_AGENT: "devin",
    GBIRD_ENDPOINT: "", // set inside withServer
    GBIRD_TOKEN: member.token,
  };
  await withServer(dir, async (baseUrl) => {
    const run = (payload: object, sub = "record") =>
      execFileSync("node", ["--import", "tsx", HOOK, sub], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...env, GBIRD_ENDPOINT: baseUrl },
      });
    run({ hook_event_name: "SessionStart", session_id: "devin-e2e" });
    run({ hook_event_name: "UserPromptSubmit", session_id: "devin-e2e", prompt: "hello" });
    run({ hook_event_name: "SessionEnd", session_id: "devin-e2e", reason: "completed" }, "ship");

    const list = await (await fetch(`${baseUrl}/api/sessions?member=kush`)).json();
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].id, "devin-e2e");
    assert.equal(list.sessions[0].title, "hello");

    const detail = await (await fetch(`${baseUrl}/api/sessions/devin-e2e`)).json();
    assert.deepEqual(
      detail.events.map((e: { type: string }) => e.type),
      ["session_started", "message_created", "session_ended"],
    );
  });
});
