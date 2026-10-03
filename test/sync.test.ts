import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DevinClient } from "../src/devin.js";
import { syncTimeline } from "../src/sync.js";
import { TraceStore } from "../src/tracestore.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gbird-sync-"));
}

interface StubState {
  sessions: Array<Record<string, unknown>>;
  messages: Record<string, Array<Record<string, unknown>>>;
  messageFetches: string[];
}

async function withStubApi(state: StubState, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const messagesMatch = /^\/v3\/organizations\/[^/]+\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (messagesMatch) {
      state.messageFetches.push(messagesMatch[1]!);
      res.end(JSON.stringify({ items: state.messages[messagesMatch[1]!] ?? [] }));
      return;
    }
    if (/^\/v3\/organizations\/[^/]+\/sessions$/.test(url.pathname)) {
      res.end(JSON.stringify({ items: state.sessions }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("syncTimeline writes session files and skips unchanged sessions on re-pull", async () => {
  const state: StubState = {
    sessions: [
      {
        session_id: "devin-one",
        title: "Fix the flake",
        status: "finished",
        created_at: 1756800000,
        updated_at: 1756803600,
        acus_consumed: 1.5,
        url: "https://app.devin.ai/sessions/one",
        tags: ["repo:owner/repo"],
      },
      {
        session_id: "devin-two",
        title: "Docs pass",
        status: "finished",
        created_at: 1756800100,
        updated_at: 1756803700,
      },
    ],
    messages: {
      "devin-one": [
        { event_id: "m1", created_at: 1756800001, source: "user", message: "fix it" },
        { event_id: "m2", created_at: 1756800002, source: "devin", message: "on it" },
      ],
      "devin-two": [],
    },
    messageFetches: [],
  };

  const dir = tmpDir();
  await withStubApi(state, async (baseUrl) => {
    const store = new TraceStore(dir);
    const devin = new DevinClient({ apiKey: "test", orgId: "org-1", baseUrl });

    const first = await syncTimeline({ store, devin });
    assert.equal(first.sessions, 2);
    assert.equal(first.skipped, 0);
    assert.deepEqual(state.messageFetches.sort(), ["devin-one", "devin-two"]);

    const timeline = store.getTimeline("devin-one");
    assert.equal(timeline?.session.title, "Fix the flake");
    assert.equal(timeline?.session.repositories[0], "owner/repo");
    // session_started + 2 messages + session_updated
    assert.equal(timeline?.events.length, 4);

    const second = await syncTimeline({ store, devin });
    assert.equal(second.sessions, 0);
    assert.equal(second.skipped, 2);
    assert.equal(state.messageFetches.length, 2); // no new message fetches

    // A session whose updated_at moved is re-pulled
    state.sessions[0]!.updated_at = 1756807200;
    const third = await syncTimeline({ store, devin });
    assert.equal(third.sessions, 1);
    assert.equal(third.skipped, 1);
    assert.deepEqual(state.messageFetches, ["devin-one", "devin-two", "devin-one"]);
  });
});
