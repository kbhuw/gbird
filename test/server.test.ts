import assert from "node:assert/strict";
import test from "node:test";
import { seedDemo } from "../src/demo.js";
import { startServer } from "../src/server.js";
import { TimelineStore } from "../src/store.js";

test("serves the Cookiejar-style repo-filtered session timeline", async () => {
  const priorKey = process.env.DEVIN_API_KEY;
  const priorSecret = process.env.SECRET;
  const priorOrg = process.env.DEVIN_ORG_ID;
  const priorCodexRoot = process.env.CODEX_SESSIONS_ROOT;
  delete process.env.DEVIN_API_KEY;
  delete process.env.SECRET;
  delete process.env.DEVIN_ORG_ID;
  process.env.CODEX_SESSIONS_ROOT = "/tmp/gbird-missing-codex-root";

  const store = new TimelineStore(":memory:");
  seedDemo(store);
  const running = await startServer({ store, port: 0, demo: true });

  try {
    const html = await (await fetch(running.url)).text();
    assert.ok(html.includes("catches slugs"));
    assert.ok(html.includes("<h1>gbird</h1>"));
    assert.ok(html.includes("Codex"));
    assert.ok(html.includes("All agents"));
    assert.equal(html.includes("agent-switch"), false);
    assert.ok(html.includes("aria-haspopup=\"dialog\"") || html.includes("session-dialog"));
    assert.ok(html.includes("timeline-node"));
    assert.ok(html.includes("timeline-mark"));
    assert.ok(html.includes("https://cognition.com/icon.svg"));
    assert.ok(html.includes("https://www.greptile.com/logo-only.svg"));
    assert.ok(html.includes("GitGuardian"));
    assert.ok(html.includes("PR merged"));
    assert.ok(html.includes("pr-opened"));
    assert.ok(html.includes("pr-comment"));
    assert.ok(html.includes("eventPrNumber"));
    assert.ok(html.includes("Normalized data"));

    const state = await (await fetch(new URL("/api/state", running.url))).json() as {
      configured: boolean;
      demo: boolean;
      sessionCount: number;
    };
    assert.equal(state.configured, false);
    assert.equal(state.demo, true);
    assert.equal(state.sessionCount, 3);

    const filtered = await (await fetch(
      new URL("/api/sessions?repo=DevelopIQ-ai%2Fcookiejar", running.url),
    )).json() as { sessions: Array<{ id: string }> };
    assert.deepEqual(filtered.sessions.map((session) => session.id), ["devin-demo-cookiejar"]);

    const timelineResponse = await fetch(
      new URL("/api/sessions/devin-demo-cookiejar", running.url),
    );
    assert.equal(timelineResponse.headers.get("cache-control"), "no-store");
    const timeline = await timelineResponse.json() as { events: Array<{ type: string }> };
    assert.ok(timeline.events.some((event) => event.type === "greptile_comment"));

    const exported = await fetch(
      new URL("/api/sessions/devin-demo-cookiejar/export", running.url),
    );
    assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
    assert.ok((await exported.text()).includes("\"schemaVersion\": 1"));

    const sync = await fetch(new URL("/api/sync", running.url), { method: "POST" });
    assert.equal(sync.status, 503);
    assert.ok((await sync.text()).includes("No agent sources are configured"));
  } finally {
    await running.close();
    store.close();
    if (priorKey === undefined) delete process.env.DEVIN_API_KEY;
    else process.env.DEVIN_API_KEY = priorKey;
    if (priorSecret === undefined) delete process.env.SECRET;
    else process.env.SECRET = priorSecret;
    if (priorOrg === undefined) delete process.env.DEVIN_ORG_ID;
    else process.env.DEVIN_ORG_ID = priorOrg;
    if (priorCodexRoot === undefined) delete process.env.CODEX_SESSIONS_ROOT;
    else process.env.CODEX_SESSIONS_ROOT = priorCodexRoot;
  }
});
