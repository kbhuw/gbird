import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { remoteCandidates, resolveRemote, pushDirToRepo } from "../src/push.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("remoteCandidates prefers GBIRD_GIT_URL then proxy", () => {
  const prev = process.env.GBIRD_GIT_URL;
  process.env.GBIRD_GIT_URL = "https://example.com/x.git";
  try {
    const c = remoteCandidates("a/b");
    assert.equal(c[0], "https://example.com/x.git");
    assert.equal(c[1], "https://git-manager.devin.ai/proxy/github.com/a/b.git");
  } finally {
    if (prev === undefined) delete process.env.GBIRD_GIT_URL;
    else process.env.GBIRD_GIT_URL = prev;
  }
});

test("resolveRemote picks the first reachable remote", () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "gbird-remote-"));
  const bare = path.join(remote, "repo.git");
  git(["init", "--bare", bare], remote);
  const prev = process.env.GBIRD_GIT_URL;
  process.env.GBIRD_GIT_URL = bare;
  try {
    assert.equal(resolveRemote("x/y"), bare);
  } finally {
    if (prev === undefined) delete process.env.GBIRD_GIT_URL;
    else process.env.GBIRD_GIT_URL = prev;
  }
});

test("pushDirToRepo end-to-end into a file remote", () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "gbird-remote-"));
  const bare = path.join(remote, "repo.git");
  git(["init", "--bare", bare], remote);

  const src = fs.mkdtempSync(path.join(os.tmpdir(), "gbird-src-"));
  fs.mkdirSync(path.join(src, "kush", "devin"), { recursive: true });
  fs.writeFileSync(path.join(src, "kush", "devin", "s1.json"), '{"a":1}');

  const prev = process.env.GBIRD_GIT_URL;
  process.env.GBIRD_GIT_URL = bare;
  try {
    const first = pushDirToRepo({ repo: "x/y", dir: src });
    assert.equal(first.remote, bare);
    assert.equal(first.files, 1);
    assert.equal(first.pushed, true);

    // verify the file landed on the remote
    const verify = fs.mkdtempSync(path.join(os.tmpdir(), "gbird-verify-"));
    git(["clone", bare, verify], remote);
    assert.equal(
      fs.readFileSync(path.join(verify, "sessions", "kush", "devin", "s1.json"), "utf8"),
      '{"a":1}',
    );

    // second push with no changes → no commit
    const second = pushDirToRepo({ repo: "x/y", dir: src });
    assert.equal(second.committed, false);
    assert.equal(second.pushed, false);
  } finally {
    if (prev === undefined) delete process.env.GBIRD_GIT_URL;
    else process.env.GBIRD_GIT_URL = prev;
  }
});
