import fs from "node:fs";
import path from "node:path";

for (const relative of ["ui/index.html", "ui/about.html", "analysis-output.schema.json", "repo-report-output.schema.json"]) {
  const source = path.resolve("src", relative);
  const target = path.resolve("dist/src", relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
