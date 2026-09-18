import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type CallableMetric } from "./coverage.js";
import { computeCrap } from "./crap.js";
import { selectProject, mutationOwners, type CodeSelection } from "./selection.js";
import { collectProjectCrap, type ProjectCrapRun } from "./crap-runner.js";
import { GateInputError, loadGate, type GateThresholds, type Threshold } from "./gate.js";
import { EvidenceContractError } from "./evidence/contract.js";
import {
  summarizeRepeatedFindings,
  writeRunEvidenceDraft,
  type Finding,
  type RunEvidenceDraft,
} from "./history.js";
import { loadMutationProject, restrictProject, type MutationProject } from "./project.js";
import { evaluateMutationGate, type MutationGateResult } from "./mutation/gate.js";
import { normalizeMutationOutcome } from "./mutation/normalizer.js";
import { collectProjectMutation } from "./mutation/project-runner.js";
import { inspectStrykerRuntime } from "./mutation/runtime.js";
import {
  MutationProtocolError,
  requireMutationId,
  type MutationRunRecord,
  type NormalizedMutationOutcome,
  type TypedKillProof,
} from "./mutation/protocol.js";
import { SentinelPlanReporter } from "./mutation/stryker-plan-reporter.js";

const HELP = "sentinel-ts commands: crap, mutation, check, doctor, history\n";

export interface CliDependencies {
  readonly cwd: string;
  readonly now: () => string;
  readonly newRunId: () => string;
  readonly writeOut: (text: string) => void;
  readonly writeError: (text: string) => void;
}

interface CrapRowInput {
  readonly id: string;
  readonly complexity: unknown;
  readonly covered: unknown;
  readonly total: unknown;
}

interface CrapAnalysis {
  readonly unknownDetails?: readonly Readonly<Record<string, unknown>>[];
  readonly pass: boolean;
  readonly rows: readonly (ReturnType<typeof computeCrap> & { readonly id: string })[];
  readonly unknown: readonly string[];
}

interface MutationAnalysis {
  readonly run: MutationRunRecord;
  readonly normalized: readonly NormalizedMutationOutcome[];
  readonly gate: MutationGateResult;
}

function defaults(): CliDependencies {
  return {
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    newRunId: () => randomUUID(),
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  };
}

function requireObject(value: unknown, code: string, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MutationProtocolError(code, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function readJson(inputPath: string, cwd: string): Promise<unknown> {
  const resolved = path.resolve(cwd, inputPath);
  try {
    return JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new MutationProtocolError("invalidJsonInput", `cannot read JSON input: ${String(error)}`);
  }
}

function parseOptions(
  values: readonly string[],
  valueNames: readonly string[],
  booleanNames: readonly string[] = [],
): Readonly<Record<string, string | true>> {
  const result: Record<string, string | true> = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    requireKnownOption(name, [...valueNames, "--selection"], booleanNames);
    if (name in result) {
      throw new MutationProtocolError("invalidCliArguments", `duplicate command argument: ${name}`);
    }
    if (booleanNames.includes(name)) {
      result[name] = true;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new MutationProtocolError("invalidCliArguments", `command argument requires a value: ${name}`);
    }
    result[name] = value;
    index += 1;
  }
  return result;
}

function requireKnownOption(
  name: string | undefined,
  valueNames: readonly string[],
  booleanNames: readonly string[],
): asserts name is string {
  if (name === undefined) {
    throw new MutationProtocolError("invalidCliArguments", "unsupported command argument");
  }
  if (!valueNames.includes(name) && !booleanNames.includes(name)) {
    throw new MutationProtocolError("invalidCliArguments", `unsupported command argument: ${name}`);
  }
}

const CHANGED_FILE = "--changed-file";
const SELECTION_FIELDS: Readonly<Record<string, "files" | "functions" | "tests">> = { "--file": "files", "--function": "functions", "--tests": "tests" };

function selectionValue(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--")) throw new MutationProtocolError("invalidSelection", "selection requires a value");
  return value;
}

// --changed-file repeats; it is split off before the single-value option parser runs.
function splitChangedFiles(values: readonly string[]): { readonly changed: readonly string[]; readonly rest: readonly string[] } {
  const changed: string[] = [];
  const rest: string[] = [];
  const selection: { files: string[]; functions: string[]; tests: string[] } = { files: [], functions: [], tests: [] };
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const field = SELECTION_FIELDS[name!];
    if (field !== undefined) {
      selection[field].push(selectionValue(values, ++index));
      continue;
    }
    if (name !== CHANGED_FILE) {
      rest.push(name as string);
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new MutationProtocolError("invalidCliArguments", `command argument requires a value: ${CHANGED_FILE}`);
    }
    changed.push(value);
    index += 1;
  }
  if (Object.values(selection).some(values => values.length)) rest.push("--selection", JSON.stringify(selection));
  return { changed, rest };
}

function requiredOption(options: Readonly<Record<string, string | true>>, name: string): string {
  const value = options[name];
  if (typeof value !== "string") {
    throw new MutationProtocolError("invalidCliArguments", `required command argument is missing: ${name}`);
  }
  return value;
}

function analyzeCrap(value: unknown, crapMax: Threshold): CrapAnalysis {
  const input = requireObject(value, "invalidCrapInput", "CRAP input");
  if (!Array.isArray(input.rows)) {
    throw new MutationProtocolError("invalidCrapInput", "CRAP input rows must be an array");
  }
  const seen = new Set<string>();
  const rows = input.rows.map((rawRow) => {
    const row = requireObject(rawRow, "invalidCrapInput", "CRAP row");
    const id = requireMutationId(row.id, "CRAP row ID");
    if (seen.has(id)) throw new MutationProtocolError("duplicateCrapRowId", `duplicate CRAP row ID: ${id}`);
    seen.add(id);
    return { id, ...computeCrap(row.complexity, row.covered, row.total, crapMax) };
  });
  rows.sort((left, right) => Buffer.from(left.id).compare(Buffer.from(right.id)));
  return { pass: rows.length > 0 && rows.every((row) => row.pass), rows, unknown: [] };
}

function metricId(metric: CallableMetric): string {
  return `${metric.modulePath}:${metric.callableId}`;
}

function projectCrapAnalysis(run: ProjectCrapRun): CrapAnalysis {
  const rows = run.metrics
    .filter((metric) => metric.crap !== null)
    .map((metric) => ({ id: metricId(metric), file: metric.modulePath, function: metric.qualifiedName,
      sourceRange: metric.sourceRange, line: metric.line, complexity: metric.complexity, coverage: metric.coverage,
      coverageBasis: "istanbul-statement", ...(metric.crap as ReturnType<typeof computeCrap>) }));
  const unknown = run.metrics.filter((metric) => metric.crap === null).map(metricId);
  const unknownDetails = run.metrics.filter(metric => metric.crap === null).map(metric => ({
    id: metricId(metric), file: metric.modulePath, function: metric.qualifiedName, line: metric.line,
    sourceRange: metric.sourceRange, complexity: metric.complexity, reason: metric.unknownReason,
    score: null, status: "coverageUnknown",
  }));
  rows.sort((left, right) => Buffer.from(left.id).compare(Buffer.from(right.id)));
  return { pass: rows.length > 0 && unknown.length === 0 && rows.every((row) => row.pass), rows, unknown, unknownDetails };
}

function parseProof(value: unknown): TypedKillProof {
  const proof = requireObject(value, "invalidKillProof", "kill proof");
  const textKeys = ["mutantId", "assertionType", "testId", "executionNonce"] as const;
  const booleanKeys = [
    "controlPassed",
    "assertionFailed",
    "replayMatched",
    "cacheObserved",
    "retryObserved",
  ] as const;
  for (const key of textKeys) {
    if (typeof proof[key] !== "string") {
      throw new MutationProtocolError("invalidKillProof", `kill proof ${key} must be a string`);
    }
  }
  for (const key of booleanKeys) {
    if (typeof proof[key] !== "boolean") {
      throw new MutationProtocolError("invalidKillProof", `kill proof ${key} must be a boolean`);
    }
  }
  return proof as unknown as TypedKillProof;
}

function analyzeMutation(value: unknown, mutationMin: Threshold): MutationAnalysis {
  const input = requireObject(value, "invalidMutationInput", "mutation input");
  if (!Array.isArray(input.streamedResults) || !Array.isArray(input.proofs)) {
    throw new MutationProtocolError(
      "invalidMutationInput",
      "mutation input must contain streamedResults and proofs arrays",
    );
  }
  const reporter = new SentinelPlanReporter();
  reporter.onMutationTestingPlanReady(input.planEvent);
  for (const result of input.streamedResults) reporter.onMutantTested(result);
  reporter.onMutationTestReportReady(input.finalReport, {});
  const run = reporter.finalize();

  return analyzeMutationRecord(run, input.proofs, input.unauthorizedExclusion, mutationMin);
}

function analyzeMutationRecord(
  run: MutationRunRecord,
  rawProofs: unknown,
  unauthorizedExclusion: unknown,
  mutationMin: Threshold,
): MutationAnalysis {
  if (!Array.isArray(rawProofs)) {
    throw new MutationProtocolError("invalidMutationInput", "mutation proofs must be an array");
  }
  const proofs = new Map<string, TypedKillProof>();
  for (const rawProof of rawProofs) {
    const proof = parseProof(rawProof);
    const id = requireMutationId(proof.mutantId, "proof mutant ID");
    if (proofs.has(id)) {
      throw new MutationProtocolError("duplicateKillProof", `duplicate kill proof for ${id}`);
    }
    if (!run.outcomes.some((outcome) => outcome.id === id)) {
      throw new MutationProtocolError("orphanKillProof", `kill proof has no candidate: ${id}`);
    }
    proofs.set(id, proof);
  }
  const normalized = run.outcomes.map((outcome) => normalizeMutationOutcome(outcome, proofs.get(outcome.id)));
  if (typeof unauthorizedExclusion !== "number") {
    throw new MutationProtocolError(
      "invalidUnauthorizedExclusionCount",
      "mutation input must contain unauthorizedExclusion",
    );
  }
  const gate = evaluateMutationGate(run.candidates, normalized, unauthorizedExclusion, mutationMin);
  return { run, normalized, gate };
}

class EmptyChangedScope extends Error {
  public constructor() {
    super("no changed production file");
    this.name = "EmptyChangedScope";
  }
}

async function loadSelectedProject(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  changed: readonly string[] = [],
): Promise<{ readonly project: MutationProject; readonly projectRoot: string }> {
  const selectedProject = requiredOption(options, "--project");
  const projectRoot = path.resolve(dependencies.cwd, selectedProject);
  const config = options["--config"];
  const module = options["--module"];
  let loaded = await loadMutationProject(
    projectRoot,
    typeof config === "string" ? config : undefined,
    typeof module === "string" ? module : undefined,
  );
  if (typeof options["--selection"] === "string") loaded = await selectProject(loaded, JSON.parse(options["--selection"]) as CodeSelection);
  if (changed.length === 0) return { project: loaded, projectRoot };
  const project = restrictProject(loaded, changed);
  if (project === null) throw new EmptyChangedScope();
  return { project, projectRoot };
}

// Nothing judged, nothing failed, no evidence: the change touched no production file.
function writeEmptyChangedScope(command: string, dependencies: CliDependencies): number {
  writeJson(dependencies.writeOut, { changedScope: "empty", command, pass: true });
  return 0;
}

async function analyzeProjectMutation(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  mutationMin: Threshold,
  changed: readonly string[] = [],
): Promise<{ readonly analysis: MutationAnalysis; readonly projectRoot: string }> {
  const { project, projectRoot } = await loadSelectedProject(options, dependencies, changed);
  const collected = await collectProjectMutation(project);
  return {
    analysis: analyzeMutationRecord(collected.run, collected.proofs, 0, mutationMin),
    projectRoot,
  };
}

function gateOptions(options: Readonly<Record<string, string | true>>): GateThresholds {
  const crapMax = options["--crap-max"];
  const mutationMin = options["--mutation-min"];
  return loadGate(
    typeof crapMax === "string" ? crapMax : undefined,
    typeof mutationMin === "string" ? mutationMin : undefined,
  );
}

function mutationFindings(analysis: MutationAnalysis): readonly Finding[] {
  return analysis.normalized
    .filter((outcome) => outcome.status !== "killed")
    .map((outcome) => ({
      kind: "mutation" as const,
      subject: outcome.id,
      state: outcome.status,
    }));
}

function crapFindings(analysis: CrapAnalysis): readonly Finding[] {
  const exceeded = analysis.rows
    .filter((row) => !row.pass)
    .map((row) => ({ kind: "crap" as const, subject: row.id, state: "crapAboveLimit" }));
  const unknown = analysis.unknown.map((id) => ({ kind: "crap" as const, subject: id, state: "coverageUnknown" }));
  return [...exceeded, ...unknown];
}

function compareCrapRisk(
  left: CrapAnalysis["rows"][number],
  right: CrapAnalysis["rows"][number],
): number {
  const leftScaled = BigInt(left.numerator) * BigInt(right.denominator);
  const rightScaled = BigInt(right.numerator) * BigInt(left.denominator);
  if (leftScaled === rightScaled) return 0;
  return leftScaled > rightScaled ? 1 : -1;
}

function evidenceCrapComponent(analysis: CrapAnalysis, crapMax: Threshold): Readonly<Record<string, unknown>> {
  const callableCount = analysis.rows.length + analysis.unknown.length;
  if (analysis.rows.length === 0) {
    return {
      callableCount,
      crapMax: crapMax.text,
      maxNumerator: "0",
      maxDenominator: "1",
      pass: false,
      unknownCount: analysis.unknown.length,
    };
  }
  let maximum = analysis.rows[0]!;
  for (const row of analysis.rows.slice(1)) {
    if (compareCrapRisk(row, maximum) > 0) maximum = row;
  }
  return {
    callableCount,
    crapMax: crapMax.text,
    maxNumerator: maximum.numerator,
    maxDenominator: maximum.denominator,
    pass: analysis.pass,
    unknownCount: analysis.unknown.length,
  };
}

function evidenceMutationComponent(analysis: MutationAnalysis, mutationMin: Threshold): Readonly<Record<string, unknown>> {
  return {
    ...analysis.gate.counts,
    inScope: analysis.gate.inScope,
    mutationMin: mutationMin.text,
    pass: analysis.gate.pass,
    unauthorizedExclusion: analysis.gate.unauthorizedExclusion,
  };
}

function evidenceDiagnosticCodes(findings: readonly Finding[]): readonly string[] {
  const values = findings.map((finding) => (
    finding.kind === "mutation" ? `${finding.state}Mutant` : finding.state
  ));
  return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function canonicalUtcTimestamp(value: string): string {
  return value.replace(/\.([0-9]+)Z$/u, (_whole, fraction: string) => {
    const canonical = fraction.replace(/0+$/u, "");
    return canonical.length === 0 ? "Z" : `.${canonical}Z`;
  });
}

async function record(
  command: "check" | "mutation",
  projectRoot: string,
  components: RunEvidenceDraft["components"],
  findings: readonly Finding[],
  dependencies: CliDependencies,
): Promise<void> {
  const runId = dependencies.newRunId();
  const timestamp = canonicalUtcTimestamp(dependencies.now());
  await writeRunEvidenceDraft(path.resolve(dependencies.cwd, projectRoot), {
    runId,
    correlationId: runId,
    command,
    mode: "strict",
    observationSource: "fresh",
    sourceRunId: null,
    startedAtUtc: timestamp,
    completedAtUtc: timestamp,
    committedAtUtc: timestamp,
    components,
    diagnosticCodes: evidenceDiagnosticCodes(findings),
    findings,
  });
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (command === "doctor") return runDoctor(arguments_, dependencies);
  if (command === "history") return runHistory(arguments_, dependencies);
  if (command === "crap") return runCrap(arguments_, dependencies);
  if (command === "mutation") return runMutation(arguments_, dependencies);
  if (command === "check") return runCheck(arguments_, dependencies);
  throw new MutationProtocolError("invalidCliArguments", `unknown command: ${command}`);
}

async function runDoctor(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  if (arguments_.length !== 0) {
    throw new MutationProtocolError("invalidCliArguments", "doctor accepts no arguments");
  }
  const inspection = await inspectStrykerRuntime();
  writeJson(dependencies.writeOut, inspection);
  return inspection.status === "ready" ? 0 : 5;
}

async function runHistory(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  const options = parseOptions(arguments_, ["--project"], ["--repeated"]);
  if (options["--repeated"] !== true) {
    throw new MutationProtocolError("invalidCliArguments", "history currently requires --repeated");
  }
  const summary = await summarizeRepeatedFindings(
    path.resolve(dependencies.cwd, requiredOption(options, "--project")),
  );
  writeJson(dependencies.writeOut, summary);
  return 0;
}

function rejectChangedWithInput(options: Readonly<Record<string, string | true>>, changed: readonly string[]): void {
  if (changed.length > 0 && typeof options["--input"] === "string") {
    throw new MutationProtocolError("invalidCliArguments", `${CHANGED_FILE} applies only to --project runs`);
  }
}

async function crapExecution(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  crapMax: Threshold,
  changed: readonly string[],
): Promise<CrapAnalysis> {
  const input = options["--input"];
  if (typeof input === "string") return analyzeCrap(await readJson(input, dependencies.cwd), crapMax);
  const { project } = await loadSelectedProject(options, dependencies, changed);
  return projectCrapAnalysis(await collectProjectCrap(project, crapMax));
}

async function runCrap(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  const { changed, rest } = splitChangedFiles(arguments_);
  const options = parseOptions(rest, ["--input", "--project", "--config", "--module", "--crap-max"]);
  rejectChangedWithInput(options, changed);
  const gate = gateOptions(options);
  let analysis: CrapAnalysis;
  try {
    analysis = await crapExecution(options, dependencies, gate.crapMax, changed);
  } catch (error) {
    if (error instanceof EmptyChangedScope) return writeEmptyChangedScope("crap", dependencies);
    throw error;
  }
  writeJson(dependencies.writeOut, { ...analysis, crapMax: gate.crapMax.text });
  return analysis.pass ? 0 : 2;
}

async function mutationExecution(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  mutationMin: Threshold,
  changed: readonly string[],
): Promise<{ readonly analysis: MutationAnalysis; readonly projectRoot: string }> {
  const input = options["--input"];
  if (typeof input !== "string") return analyzeProjectMutation(options, dependencies, mutationMin, changed);
  return {
    analysis: analyzeMutation(await readJson(input, dependencies.cwd), mutationMin),
    projectRoot: requiredOption(options, "--project"),
  };
}

async function runMutation(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  const { changed, rest } = splitChangedFiles(arguments_);
  const options = parseOptions(rest, ["--input", "--project", "--config", "--module", "--mutation-min"]);
  rejectChangedWithInput(options, changed);
  const gate = gateOptions(options);
  let execution: { readonly analysis: MutationAnalysis; readonly projectRoot: string };
  try {
    execution = await mutationExecution(options, dependencies, gate.mutationMin, changed);
  } catch (error) {
    if (error instanceof EmptyChangedScope) return writeEmptyChangedScope("mutation", dependencies);
    throw error;
  }
  const analysis = execution.analysis;
  await record(
    "mutation",
    execution.projectRoot,
    { mutation: evidenceMutationComponent(analysis, gate.mutationMin) },
    mutationFindings(analysis),
    dependencies,
  );
  writeJson(dependencies.writeOut, { gate: analysis.gate, mutationMin: gate.mutationMin.text, results: analysis.normalized });
  return analysis.gate.pass ? 0 : 2;
}

interface CheckExecution {
  readonly scope?: { readonly files: readonly string[]; readonly functions: readonly string[]; readonly tests: readonly string[] };
  readonly crap: CrapAnalysis;
  readonly mutation: MutationAnalysis;
  readonly projectRoot: string;
}

async function inputCheckExecution(
  inputPath: string,
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  gate: GateThresholds,
): Promise<CheckExecution> {
  const input = requireObject(await readJson(inputPath, dependencies.cwd), "invalidCheckInput", "check input");
  const legacyInput = "crap" in input || "mutation" in input;
  const crap = analyzeCrap(legacyInput ? input.crap : input, gate.crapMax);
  if (legacyInput) {
    return { crap, mutation: analyzeMutation(input.mutation, gate.mutationMin), projectRoot: requiredOption(options, "--project") };
  }
  const execution = await analyzeProjectMutation(options, dependencies, gate.mutationMin);
  return { crap, mutation: execution.analysis, projectRoot: execution.projectRoot };
}

// Without --input the whole check is native: fresh coverage CRAP and the project mutation run.
async function projectCheckExecution(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  gate: GateThresholds,
  changed: readonly string[],
): Promise<CheckExecution> {
  const { project, projectRoot } = await loadSelectedProject(options, dependencies, changed);
  const crap = projectCrapAnalysis(await collectProjectCrap(project, gate.crapMax));
  const collected = await collectProjectMutation(project);
  const mutation = analyzeMutationRecord(collected.run, collected.proofs, 0, gate.mutationMin);
  const owners = await mutationOwners(project, collected.run.candidates);
  const described = { ...mutation, normalized: mutation.normalized.map(item => ({ ...item, ...(owners.has(item.id) ? { function: owners.get(item.id) } : {}) })) };
  return { crap, mutation: described, projectRoot, scope: { files: project.productionFiles, functions: (project.selectedCallables ?? []).map(item => item.qualifiedName), tests: project.testFiles } };
}

async function runCheck(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  const { changed, rest } = splitChangedFiles(arguments_);
  const options = parseOptions(rest, ["--input", "--project", "--config", "--module", "--crap-max", "--mutation-min"]);
  rejectChangedWithInput(options, changed);
  const gate = gateOptions(options);
  const inputPath = options["--input"];
  let execution: CheckExecution;
  try {
    execution = typeof inputPath === "string"
      ? await inputCheckExecution(inputPath, options, dependencies, gate)
      : await projectCheckExecution(options, dependencies, gate, changed);
  } catch (error) {
    if (error instanceof EmptyChangedScope) return writeEmptyChangedScope("check", dependencies);
    throw error;
  }
  const { crap, mutation } = execution;
  const pass = crap.pass && mutation.gate.pass;
  await record(
    "check",
    execution.projectRoot,
    {
      crap: evidenceCrapComponent(crap, gate.crapMax),
      mutation: evidenceMutationComponent(mutation, gate.mutationMin),
    },
    [...crapFindings(crap), ...mutationFindings(mutation)],
    dependencies,
  );
  writeJson(dependencies.writeOut, {
    pass,
    gate: { crapMax: gate.crapMax.text, mutationMin: gate.mutationMin.text },
    crap,
    ...(execution.scope === undefined ? {} : { scope: execution.scope }),
    mutation: { gate: mutation.gate, results: mutation.normalized.map(result => ({ ...mutation.run.candidates.find(candidate => candidate.id === result.id), ...result })) },
  });
  return pass ? 0 : 2;
}

function writeCliFailure(error: unknown, dependencies: CliDependencies): number {
  const protocolError = error instanceof MutationProtocolError;
  const evidenceError = error instanceof EvidenceContractError;
  const gateError = error instanceof GateInputError;
  const code = protocolError || evidenceError || gateError ? error.code : "internalError";
  const message = error instanceof Error ? error.message : String(error);
  writeJson(dependencies.writeError, { error: { code, message } });
  return failureExitCode(gateError, protocolError, code);
}

function failureExitCode(gateError: boolean, protocolError: boolean, code: string): number {
  if (gateError) return 3;
  if (["invalidSelection", "functionRequiresOneFile", "functionSelectionInvalid"].includes(code)) return 3;
  if (code === "strykerRuntimeUnavailable") return 5;
  return protocolError ? 6 : 7;
}

export async function runCli(
  arguments_: readonly string[],
  suppliedDependencies?: CliDependencies,
): Promise<number> {
  const dependencies = suppliedDependencies ?? defaults();
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    dependencies.writeOut(HELP);
    return 0;
  }
  const [command, ...commandArguments] = arguments_;
  if (command === undefined) {
    dependencies.writeError(HELP);
    return 2;
  }
  try {
    return await runCommand(command, commandArguments, dependencies);
  } catch (error) {
    return writeCliFailure(error, dependencies);
  }
}

// macOS temp and home paths sit behind symlinks (/var, /tmp); compare real paths so the CLI still runs.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === realpathSync(path.resolve(invokedPath))) {
  process.exitCode = await runCli(process.argv.slice(2));
}
