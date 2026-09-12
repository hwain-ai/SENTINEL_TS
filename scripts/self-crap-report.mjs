import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { attachCoverage, parseIstanbulStatements } from "../dist/coverage.js";
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

const root = process.cwd();
const coverageDocument = JSON.parse(await readFile(".sentinel-self-coverage/coverage-final.json", "utf8"));
const metrics = [];
for (const filePath of await sourceFiles(path.join(root, "src"))) {
  const source = await readFile(filePath, "utf8");
  const modulePath = path.relative(root, filePath).split(path.sep).join("/");
  const callables = analyzeTypeScript(source, modulePath);
  const coverage = parseIstanbulStatements(coverageDocument, modulePath, root, source);
  metrics.push(...attachCoverage(callables, coverage));
}
const unknown = metrics.filter((metric) => metric.crap === null);
const failed = metrics.filter((metric) => metric.crap !== null && !metric.crap.pass);
const known = metrics.filter((metric) => metric.crap !== null);
const maximum = known.reduce((current, metric) => {
  if (current === null) return metric;
  const left = BigInt(metric.crap.numerator) * BigInt(current.crap.denominator);
  const right = BigInt(current.crap.numerator) * BigInt(metric.crap.denominator);
  return left > right ? metric : current;
}, null);
console.log(JSON.stringify({
  callables: metrics.length,
  failed: failed.map((metric) => ({
    callable: `${metric.modulePath}:${metric.qualifiedName}`,
    complexity: metric.complexity,
    coverage: metric.coverage,
    crap: metric.crap.decimal,
  })),
  maximum: maximum === null ? null : `${maximum.modulePath}:${maximum.qualifiedName}:${maximum.crap.decimal}`,
  unknown: unknown.map((metric) => `${metric.modulePath}:${metric.qualifiedName}:${metric.unknownReason}`),
}, null, 2));
process.exitCode = failed.length === 0 && unknown.length === 0 ? 0 : 1;
