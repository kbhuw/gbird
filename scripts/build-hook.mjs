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
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`wrote ${path.relative(root, target)}`);
