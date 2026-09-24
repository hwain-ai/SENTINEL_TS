import { runProcess } from "./workspace/process.js";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { linkDependencies } from "./workspace/dependencies.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachCoverage, parseIstanbulStatements, type CallableMetric } from "./coverage.js";
import { analyzeTypeScript } from "./crap.js";
import { positionAt } from "./selection.js";
import { DEFAULT_GATE, type Threshold } from "./gate.js";
import { MutationProtocolError } from "./mutation/protocol.js";
import type { MutationProject } from "./project.js";
import { withProjectSnapshot, type ProjectSnapshot } from "./workspace/snapshot.js";

const COVERAGE_DIRECTORY = ".sentinel-runtime/coverage";

export interface ProjectCrapRun {
  readonly metrics: readonly CallableMetric[];
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function requireRegularFile(filePath: string, code: string): Promise<string> {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new MutationProtocolError(code, "locked Vitest artifact must be a regular file");
  }
  return realpath(filePath);
}

async function requireDependencyTree(root: string): Promise<string> {
  const dependencyRoot = path.join(root, "node_modules");
  const metadata = await lstat(dependencyRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new MutationProtocolError("vitestDependencyTreeInvalid", "locked dependency tree is unavailable");
  }
  return realpath(dependencyRoot);
}

async function runVitest(vitest: string, snapshot: ProjectSnapshot, signal?: AbortSignal): Promise<number | null> {
  const argv = [
    vitest,
    "run",
    ...snapshot.testFiles,
    "--testTimeout=0",
    "--hookTimeout=0",
    ...(snapshot.vitestConfigFile === null ? [] : ["--config", snapshot.vitestConfigFile]),
    "--coverage.enabled=true",
    "--coverage.provider=v8",
    "--coverage.reporter=json",
    `--coverage.reportsDirectory=${COVERAGE_DIRECTORY}`,
    ...snapshot.productionFiles.map((file) => `--coverage.include=${file}`),
  ];
  const result = await runProcess(process.execPath, argv, snapshot.root, {
          HOME: process.env.HOME ?? snapshot.root,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(snapshot.root, ".sentinel-runtime", "cache"),
        }, signal);
  return result.exitCode;
}

async function measureSnapshot(snapshot: ProjectSnapshot, crapMax: Threshold, signal?: AbortSignal): Promise<ProjectCrapRun> {
  const root = repositoryRoot();
  const vitest = await requireRegularFile(path.join(root, "node_modules", "vitest", "vitest.mjs"), "vitestExecutableInvalid");
  const dependencies = await requireDependencyTree(root);
  await linkDependencies(dependencies, path.join(snapshot.root, "node_modules"), snapshot.projectDependencies);
  await mkdir(path.join(snapshot.root, ".sentinel-runtime"), { mode: 0o700 });
  const exitCode = await runVitest(vitest, snapshot, signal);
  if (exitCode !== 0) {
    throw new MutationProtocolError("coverageProcessFailed", `Vitest coverage run failed (exit=${String(exitCode)})`);
  }
  const reportPath = path.join(snapshot.root, COVERAGE_DIRECTORY, "coverage-final.json");
  let document: unknown;
  try {
    document = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new MutationProtocolError("coverageReportUnavailable", `cannot read coverage report: ${String(error)}`);
  }
  const metrics: CallableMetric[] = [];
  for (const modulePath of snapshot.productionFiles) {
    const source = await readFile(path.join(snapshot.root, modulePath), "utf8");
    const callables = analyzeTypeScript(source, modulePath);
    const coverageFile = parseIstanbulStatements(document, modulePath, snapshot.root, source);
    const selected = snapshot.selectedCallables ?? [];
    metrics.push(...attachCoverage(callables, coverageFile, crapMax)
      .filter(item => !selected.length || selected.some(value => value.callableId === item.callableId))
      .map(item => ({ ...item, line: positionAt(source, item.sourceRange.startByte).line })));
  }
  return { metrics };
}

// Fresh coverage for the configured production scope, measured in a disposable
// snapshot with the checker's locked Vitest so the original tree is never written.
export async function collectProjectCrap(
  project: MutationProject,
  crapMax: Threshold = DEFAULT_GATE.crapMax,
  signal?: AbortSignal,
): Promise<ProjectCrapRun> {
  return withProjectSnapshot(project, (snapshot) => measureSnapshot(snapshot, crapMax, signal));
}
