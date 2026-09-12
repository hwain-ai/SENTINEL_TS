import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeTypeScript } from "../dist/crap.js";

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(filePath));
    else if (entry.isFile() && filePath.endsWith(".ts")) files.push(filePath);
  }
  return files;
}

test("native analyzer inventories every production callable without ambiguity", async () => {
  const rows = [];
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const filePath of await sourceFiles(path.join(projectRoot, "src"))) {
    const source = await readFile(filePath, "utf8");
    const modulePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
    rows.push(...analyzeTypeScript(source, modulePath));
  }

  assert.ok(rows.length > 0);
  assert.deepEqual(
    rows
      .filter((row) => row.complexity > 8)
      .map((row) => `${row.modulePath}:${row.qualifiedName}:${row.complexity}`),
    [],
  );
});
