import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDemo } from "../src/demo.js";
import { inspectInventory } from "../src/inventory.js";
import { TimelineStore } from "../src/store.js";

test("shows available, imported, and analyzed counts before scope selection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbird-inventory-"));
  fs.writeFileSync(path.join(root, "one.jsonl"), "{}\n");
  fs.writeFileSync(path.join(root, "two.jsonl"), "{}\n");
  const store = new TimelineStore(":memory:");
  seedDemo(store);
  try {
    const inventory = await inspectInventory({
      store,
      repo: "DevelopIQ-ai/cookiejar",
      codexRoots: [root],
      devin: {
        listSessions: async () => [
          { session_id: "one", tags: ["repo:DevelopIQ-ai/cookiejar"] },
          { session_id: "two", pull_requests: [{ pr_url: "https://github.com/DevelopIQ-ai/cookiejar/pull/1" }] },
          { session_id: "three", tags: ["repo:acme/other"] },
        ],
      },
    });
    assert.deepEqual(inventory.imported, {
      allSessions: 3,
      repoSessions: 1,
      analyzed: 0,
      stale: 0,
      notAnalyzed: 1,
    });
    assert.deepEqual(inventory.available, {
      codexFiles: 2,
      devinSessions: 3,
      devinRepoSessionsFromPrOrTag: 2,
    });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
