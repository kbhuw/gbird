#!/usr/bin/env node
// Copies the compiled, self-contained hook runtime to hooks/gbird-hook.mjs so
// hooks can run with zero install: `node gbird-hook.mjs record|collect|ship`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist", "src", "hookentry.js");
const target = path.join(root, "hooks", "gbird-hook.mjs");

if (!fs.existsSync(source)) {
  console.error(`missing ${source} — run tsc first`);
  process.exit(1);
}
// Version banner: repo-scoped bootstrap commands grep for this marker to
// detect a stale cached hook and re-download. Bump when the hook changes in a
// way repo configs must pick up.
const BANNER = "// gbird-hook v2\n";
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
const body = fs.readFileSync(target, "utf8");
fs.writeFileSync(target, body.startsWith("// gbird-hook v") ? body : BANNER + body);
console.log(`wrote ${path.relative(root, target)}`);
