import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { MutationProject } from "../project.js";
import { withProjectSnapshot, type ProjectSnapshot } from "../workspace/snapshot.js";
import {
  MutationProtocolError,
  isStrykerStatus,
  requireMutationId,
  type MutationCandidate,
  type MutationRunRecord,
  type RawMutationOutcome,
  type TypedKillProof,
} from "./protocol.js";
import { buildClosedStrykerConfig, reportedProductionInventory } from "./stryker-adapter.js";
import { requireStrykerRuntime } from "./runtime.js";

const EVENT_PREFIX = "SENTINEL_STRYKER_EVENT_V1:";

export interface CollectedMutationRun {
  readonly run: MutationRunRecord;
  readonly proofs: readonly TypedKillProof[];
}

interface ChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function requireExactProductionInventory(
  expected: readonly string[],
  reportedValue: unknown,
): readonly string[] {
  const reported = reportedProductionInventory(reportedValue);
  if (
    expected.length !== reported.length ||
    expected.some((file, index) => file !== reported[index])
  ) {
    throw new MutationProtocolError(
      "reportedProductionInventoryMismatch",
      "Stryker reported a production inventory different from the classified scope",
    );
  }
  return reported;
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

async function requireRegularFile(filePath: string, code: string): Promise<string> {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new MutationProtocolError(code, "locked Stryker bridge artifact must be a regular file");
  }
  return realpath(filePath);
}

async function requireDependencyTree(root: string): Promise<string> {
  const dependencyRoot = path.join(root, "node_modules");
  const metadata = await lstat(dependencyRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new MutationProtocolError("strykerDependencyTreeInvalid", "locked dependency tree is unavailable");
  }
  return realpath(dependencyRoot);
}

function supportFiles(snapshot: ProjectSnapshot): readonly string[] {
  const primary = new Set([...snapshot.productionFiles, ...snapshot.testFiles]);
  return snapshot.snapshotFiles.filter((file) => !primary.has(file));
}

async function executableConfig(snapshot: ProjectSnapshot, root: string): Promise<string> {
  const mutationDirectory = path.join(root, "dist", "mutation");
  const runnerPlugin = await requireRegularFile(
    path.join(mutationDirectory, "stryker-proof-runner.js"),
    "strykerRunnerPluginInvalid",
  );
  const reporterPlugin = await requireRegularFile(
    path.join(mutationDirectory, "stryker-event-reporter.js"),
    "strykerReporterPluginInvalid",
  );
  const base = buildClosedStrykerConfig(
    snapshot.productionFiles,
    snapshot.testFiles,
    snapshot.vitestConfigFile,
    supportFiles(snapshot),
  );
  const configuration = {
    ...base,
    allowConsoleColors: false,
    allowEmpty: false,
    cleanTempDir: "always",
    concurrency: 1,
    disableBail: false,
    fileLogLevel: "off",
    ignorers: [],
    logLevel: "off",
    maxTestRunnerReuse: 0,
    plugins: [runnerPlugin, reporterPlugin],
    reporters: ["sentinel-plan"],
    symlinkNodeModules: true,
    tempDirName: ".sentinel-runtime/stryker-tmp",
    testFiles: [...snapshot.testFiles],
    testRunner: "sentinel-vitest",
    thresholds: { high: 100, low: 100, break: null },
    // The snapshot carries the project's tsconfig files verbatim, so Stryker's tsconfig rewrite
    // (which needs the typescript package the locked tree does not carry) is pointed at no file.
    tsconfigFile: ".sentinel-runtime/tsconfig.none.json",
    vitest: { ...base.vitest, related: false },
  };
  const runtime = path.join(snapshot.root, ".sentinel-runtime");
  await mkdir(runtime, { mode: 0o700 });
  const configPath = path.join(runtime, "stryker.config.json");
  await writeFile(configPath, `${JSON.stringify(configuration)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return configPath;
}

function runChild(executable: string, arguments_: readonly string[], cwd: string, proofDirectory: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [...arguments_],
      {
        cwd,
        encoding: "utf8",
        env: {
          HOME: process.env.HOME ?? cwd,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          SENTINEL_TS_PROOF_DIR: proofDirectory,
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(cwd, ".sentinel-runtime", "cache"),
        },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null && !("code" in error)) {
          reject(error);
          return;
        }
        resolve({
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
        });
      },
    );
  });
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new MutationProtocolError("invalidStrykerBridgeEvent", `${label} must be an array`);
  }
  return value;
}

function requireEventObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MutationProtocolError("invalidStrykerBridgeEvent", "Stryker bridge event must be an object");
  }
  return value as Record<string, unknown>;
}

function decodeEvent(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(EVENT_PREFIX));
  if (lines.length !== 1) {
    throw new MutationProtocolError("strykerBridgeEventCountInvalid", "Stryker must emit exactly one bridge event");
  }
  const encoded = (lines[0] as string).slice(EVENT_PREFIX.length);
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new Error("noncanonical base64url");
    return requireEventObject(JSON.parse(decoded.toString("utf8")));
  } catch (error) {
    if (error instanceof MutationProtocolError) throw error;
    throw new MutationProtocolError("invalidStrykerBridgeEvent", `Stryker bridge event is invalid: ${String(error)}`);
  }
}

function rawOutcomes(value: unknown): readonly RawMutationOutcome[] {
  return requireArray(value, "Stryker outcomes").map((item) => {
    const result = requireEventObject(item);
    const id = requireMutationId(result.id, "Stryker result ID");
    if (!isStrykerStatus(result.rawStatus)) {
      throw new MutationProtocolError("unsupportedRawStatus", `unsupported Stryker status for ${id}`);
    }
    return { id, rawStatus: result.rawStatus };
  });
}

function candidates(value: unknown, productionFiles: readonly string[]): readonly MutationCandidate[] {
  const allowed = new Set(productionFiles);
  return requireArray(value, "Stryker candidates").map((item) => {
    const candidate = requireEventObject(item) as unknown as MutationCandidate;
    requireMutationId(candidate.id, "Stryker candidate ID");
    if (!allowed.has(candidate.modulePath)) {
      throw new MutationProtocolError("candidateOutsideProductionScope", "Stryker planned a file outside production scope");
    }
    return candidate;
  });
}

function collectedRun(stdout: string, productionFiles: readonly string[]): CollectedMutationRun {
  const event = decodeEvent(stdout);
  const reportedProductionFiles = requireExactProductionInventory(
    productionFiles,
    event.productionFiles,
  );
  return {
    run: {
      candidates: candidates(event.candidates, reportedProductionFiles),
      outcomes: rawOutcomes(event.outcomes),
    },
    proofs: requireArray(event.proofs, "Stryker proofs") as readonly TypedKillProof[],
  };
}

async function executeSnapshot(snapshot: ProjectSnapshot): Promise<CollectedMutationRun> {
  const root = repositoryRoot();
  const stryker = await requireRegularFile(
    path.join(root, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js"),
    "strykerExecutableInvalid",
  );
  const dependencies = await requireDependencyTree(root);
  await symlink(dependencies, path.join(snapshot.root, "node_modules"), "dir");
  const configPath = await executableConfig(snapshot, root);
  const proofDirectory = path.join(snapshot.root, ".sentinel-runtime", "proofs");
  await mkdir(proofDirectory, { mode: 0o700 });
  const result = await runChild(process.execPath, [stryker, "run", configPath], snapshot.root, proofDirectory);
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new MutationProtocolError(
      "strykerProcessFailed",
      `Stryker failed without an admissible report (exit=${String(result.exitCode)}, signal=${String(result.signal)})`,
    );
  }
  return collectedRun(result.stdout, snapshot.productionFiles);
}

export async function collectProjectMutation(project: MutationProject): Promise<CollectedMutationRun> {
  await requireStrykerRuntime();
  return withProjectSnapshot(project, executeSnapshot);
}
