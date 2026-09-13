import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachCoverage, parseIstanbulStatements, type CallableMetric } from "./coverage.js";
import { analyzeTypeScript } from "./crap.js";
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

function runVitest(vitest: string, snapshot: ProjectSnapshot): Promise<number | null> {
  const argv = [
    vitest,
    "run",
    ...(snapshot.vitestConfigFile === null ? [] : ["--config", snapshot.vitestConfigFile]),
    "--coverage.enabled=true",
    "--coverage.provider=v8",
    "--coverage.reporter=json",
    `--coverage.reportsDirectory=${COVERAGE_DIRECTORY}`,
    ...snapshot.productionFiles.map((file) => `--coverage.include=${file}`),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      argv,
      {
        cwd: snapshot.root,
        encoding: "utf8",
        env: {
          HOME: process.env.HOME ?? snapshot.root,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(snapshot.root, ".sentinel-runtime", "cache"),
        },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error) => {
        if (error !== null && !("code" in error)) {
          reject(error);
          return;
        }
        resolve(error === null ? 0 : typeof error.code === "number" ? error.code : null);
      },
    );
  });
}

// The snapshot gets its own node_modules directory whose entries link to the
// locked packages, so Vitest's cache (node_modules/.vite) lands in the snapshot
// and the checker's locked dependency tree is never written.
async function linkDependencies(dependencies: string, target: string): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  for (const entry of await readdir(dependencies)) {
    await symlink(path.join(dependencies, entry), path.join(target, entry));
  }
}

async function measureSnapshot(snapshot: ProjectSnapshot, crapMax: Threshold): Promise<ProjectCrapRun> {
  const root = repositoryRoot();
  const vitest = await requireRegularFile(path.join(root, "node_modules", "vitest", "vitest.mjs"), "vitestExecutableInvalid");
  const dependencies = await requireDependencyTree(root);
  await linkDependencies(dependencies, path.join(snapshot.root, "node_modules"));
  await mkdir(path.join(snapshot.root, ".sentinel-runtime"), { mode: 0o700 });
  const exitCode = await runVitest(vitest, snapshot);
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
    metrics.push(...attachCoverage(callables, coverageFile, crapMax));
  }
  return { metrics };
}

// Fresh coverage for the configured production scope, measured in a disposable
// snapshot with the checker's locked Vitest so the original tree is never written.
export async function collectProjectCrap(
  project: MutationProject,
  crapMax: Threshold = DEFAULT_GATE.crapMax,
): Promise<ProjectCrapRun> {
  return withProjectSnapshot(project, (snapshot) => measureSnapshot(snapshot, crapMax));
}
