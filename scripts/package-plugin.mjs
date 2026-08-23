import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.resolve(process.env.GBIRD_PLUGIN_TARGET ?? path.join(os.homedir(), "plugins", "gbird"));
if (path.basename(target) !== "gbird") throw new Error(`Refusing to package into unexpected target: ${target}`);

fs.mkdirSync(target, { recursive: true });
for (const relative of [".codex-plugin", "dist", "runtime", path.join("skills", "gbird")]) {
  fs.rmSync(path.join(target, relative), { recursive: true, force: true });
}

const copies = [
  [path.join(root, ".codex-plugin"), path.join(target, ".codex-plugin")],
  [path.join(root, "dist"), path.join(target, "dist")],
  [path.join(root, "skills", "gbird"), path.join(target, "skills", "gbird")],
  [path.join(root, "skills", "coding-session-analyst"), path.join(target, "runtime", "coding-session-analyst")],
  [path.join(root, "package.json"), path.join(target, "package.json")],
];

for (const [source, destination] of copies) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

process.stdout.write(`Packaged gbird plugin: ${target}\n`);
