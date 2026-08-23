import assert from "node:assert/strict";
import test from "node:test";
import { seedDemo } from "../src/demo.js";
import { TimelineStore } from "../src/store.js";

test("filters sessions repo by repo and returns ordered timelines", () => {
  const store = new TimelineStore(":memory:");
  seedDemo(store);

  assert.equal(store.countSessions(), 3);
  assert.deepEqual(store.listRepos().map((repo) => [repo.repo, repo.sessionCount]), [
    ["DevelopIQ-ai/puffle-app", 2],
    ["DevelopIQ-ai/cookiejar", 1],
  ]);
  assert.equal(store.listSessions({ repo: "DevelopIQ-ai/puffle-app" }).length, 2);
  assert.equal(store.listSessions({ repo: "DevelopIQ-ai/cookiejar" }).length, 1);
  assert.equal(store.listSessions({ query: "CSV" })[0]?.id, "devin-demo-export");

  const timeline = store.getTimeline("devin-demo-export");
  assert.ok(timeline);
  assert.ok(timeline.events.length >= 6);
  assert.deepEqual(
    [...timeline.events].map((event) => event.occurredAt),
    [...timeline.events].map((event) => event.occurredAt).sort(),
  );
  assert.ok(timeline.events.some((event) => event.status === "failure"));
  store.close();
});
