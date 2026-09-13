import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type CallableMetric } from "./coverage.js";
import { computeCrap } from "./crap.js";
import { collectProjectCrap, type ProjectCrapRun } from "./crap-runner.js";
import { GateInputError, loadGate, type GateThresholds, type Threshold } from "./gate.js";
import { EvidenceContractError } from "./evidence/contract.js";
import {
  summarizeRepeatedFindings,
  writeRunEvidenceDraft,
  type Finding,
  type RunEvidenceDraft,
} from "./history.js";
import { loadMutationProject, type MutationProject } from "./project.js";
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
    requireKnownOption(name, valueNames, booleanNames);
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
    .map((metric) => ({ id: metricId(metric), ...(metric.crap as ReturnType<typeof computeCrap>) }));
  const unknown = run.metrics.filter((metric) => metric.crap === null).map(metricId);
  rows.sort((left, right) => Buffer.from(left.id).compare(Buffer.from(right.id)));
  return { pass: rows.length > 0 && unknown.length === 0 && rows.every((row) => row.pass), rows, unknown };
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

async function loadSelectedProject(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
): Promise<{ readonly project: MutationProject; readonly projectRoot: string }> {
  const selectedProject = requiredOption(options, "--project");
  const projectRoot = path.resolve(dependencies.cwd, selectedProject);
  const config = options["--config"];
  const module = options["--module"];
  const project = await loadMutationProject(
    projectRoot,
    typeof config === "string" ? config : undefined,
    typeof module === "string" ? module : undefined,
  );
  return { project, projectRoot };
}

async function analyzeProjectMutation(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  mutationMin: Threshold,
): Promise<{ readonly analysis: MutationAnalysis; readonly projectRoot: string }> {
  const { project, projectRoot } = await loadSelectedProject(options, dependencies);
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

async function crapExecution(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  crapMax: Threshold,
): Promise<CrapAnalysis> {
  const input = options["--input"];
  if (typeof input === "string") return analyzeCrap(await readJson(input, dependencies.cwd), crapMax);
  const { project } = await loadSelectedProject(options, dependencies);
  return projectCrapAnalysis(await collectProjectCrap(project, crapMax));
}

async function runCrap(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  const options = parseOptions(arguments_, ["--input", "--project", "--config", "--module", "--crap-max"]);
  const gate = gateOptions(options);
  const analysis = await crapExecution(options, dependencies, gate.crapMax);
  writeJson(dependencies.writeOut, { ...analysis, crapMax: gate.crapMax.text });
  return analysis.pass ? 0 : 2;
}

async function mutationExecution(
  options: Readonly<Record<string, string | true>>,
  dependencies: CliDependencies,
  mutationMin: Threshold,
): Promise<{ readonly analysis: MutationAnalysis; readonly projectRoot: string }> {
  const input = options["--input"];
  if (typeof input !== "string") return analyzeProjectMutation(options, dependencies, mutationMin);
  return {
    analysis: analyzeMutation(await readJson(input, dependencies.cwd), mutationMin),
    projectRoot: requiredOption(options, "--project"),
  };
}

async function runMutation(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  const options = parseOptions(arguments_, ["--input", "--project", "--config", "--module", "--mutation-min"]);
  const gate = gateOptions(options);
  const execution = await mutationExecution(options, dependencies, gate.mutationMin);
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
): Promise<CheckExecution> {
  const { project, projectRoot } = await loadSelectedProject(options, dependencies);
  const crap = projectCrapAnalysis(await collectProjectCrap(project, gate.crapMax));
  const collected = await collectProjectMutation(project);
  const mutation = analyzeMutationRecord(collected.run, collected.proofs, 0, gate.mutationMin);
  return { crap, mutation, projectRoot };
}

async function runCheck(arguments_: readonly string[], dependencies: CliDependencies): Promise<number> {
  const options = parseOptions(arguments_, ["--input", "--project", "--config", "--module", "--crap-max", "--mutation-min"]);
  const gate = gateOptions(options);
  const inputPath = options["--input"];
  const execution = typeof inputPath === "string"
    ? await inputCheckExecution(inputPath, options, dependencies, gate)
    : await projectCheckExecution(options, dependencies, gate);
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
    mutation: { gate: mutation.gate, results: mutation.normalized },
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
  if (gateError) return 3;
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

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
