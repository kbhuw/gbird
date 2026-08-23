import fs from "node:fs";
import path from "node:path";

const source = path.resolve("src/ui/index.html");
const target = path.resolve("dist/src/ui/index.html");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
