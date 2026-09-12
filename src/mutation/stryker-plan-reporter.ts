import path from "node:path";

import {
  MutationProtocolError,
  compareUtf8,
  isStrykerStatus,
  requireMutationId,
  type CandidatePlanKind,
  type MutationCandidate,
  type MutationLocation,
  type MutationPosition,
  type RawMutationOutcome,
  type StrykerMutationRunRecord,
} from "./protocol.js";
import { reportedProductionInventory } from "./stryker-adapter.js";

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, code: string, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MutationProtocolError(code, `${label} must be an object`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new MutationProtocolError(code, `${label} must be a nonempty string`);
  }
  return value;
}

function requirePosition(value: unknown, label: string, minimum = 0): MutationPosition {
  const position = requireObject(value, "invalidCandidateLocation", label);
  for (const key of ["line", "column"] as const) {
    const coordinate = position[key];
    if (
      typeof coordinate !== "number" ||
      !Number.isSafeInteger(coordinate) ||
      coordinate < minimum
    ) {
      throw new MutationProtocolError(
        "invalidCandidateLocation",
        `${label}.${key} must be a safe integer at least ${minimum}`,
      );
    }
  }
  return { line: position.line as number, column: position.column as number };
}

function requireLocation(value: unknown, minimum = 0): MutationLocation {
  const location = requireObject(value, "invalidCandidateLocation", "candidate location");
  const start = requirePosition(location.start, "candidate location start", minimum);
  const end = requirePosition(location.end, "candidate location end", minimum);
  if (end.line < start.line || (end.line === start.line && end.column <= start.column)) {
    throw new MutationProtocolError(
      "invalidCandidateLocation",
      "candidate location must be a nonempty forward range",
    );
  }
  return { start, end };
}

function schemaLocationFromInternal(value: unknown): MutationLocation {
  const internal = requireLocation(value);
  return {
    start: { line: internal.start.line + 1, column: internal.start.column + 1 },
    end: { line: internal.end.line + 1, column: internal.end.column + 1 },
  };
}

function requireModulePath(value: unknown, projectRoot: string): string {
  const rawPath = requireString(value, "invalidCandidatePath", "candidate module path");
  const relativePath = path.isAbsolute(rawPath) ? path.relative(projectRoot, rawPath) : rawPath;
  const modulePath = relativePath.split(path.sep).join("/");
  const parts = modulePath.split("/");
  if (
    modulePath.startsWith("/") ||
    modulePath.includes("\\") ||
    /^[A-Za-z]:/u.test(modulePath) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new MutationProtocolError(
      "invalidCandidatePath",
      "candidate module path must be a canonical project-relative path",
    );
  }
  return modulePath;
}

interface ParsedMutationResult {
  readonly modulePath: string;
  readonly location: MutationLocation;
  readonly operator: string;
  readonly outcome: RawMutationOutcome;
}

function parseCandidate(value: unknown, projectRoot: string): MutationCandidate {
  const plan = requireObject(value, "invalidPlanEvent", "mutant plan");
  if (plan.plan !== "Run" && plan.plan !== "EarlyResult") {
    throw new MutationProtocolError("invalidPlanEvent", "mutant plan kind is unsupported");
  }
  const mutant = requireObject(plan.mutant, "invalidPlanEvent", "planned mutant");
  return {
    id: requireMutationId(mutant.id),
    modulePath: requireModulePath(mutant.fileName, projectRoot),
    operator: requireString(mutant.mutatorName, "invalidCandidateOperator", "candidate operator"),
    planKind: plan.plan as CandidatePlanKind,
    location: schemaLocationFromInternal(mutant.location),
  };
}

function parseResult(
  value: unknown,
  projectRoot: string,
  modulePath?: string,
): ParsedMutationResult {
  const result = requireObject(value, "invalidMutantResult", "mutant result");
  const id = requireMutationId(result.id, "result mutant ID");
  if (!isStrykerStatus(result.status)) {
    throw new MutationProtocolError("unsupportedRawStatus", `unsupported Stryker status for ${id}`);
  }
  return {
    modulePath: modulePath ?? requireModulePath(result.fileName, projectRoot),
    operator: requireString(result.mutatorName, "invalidCandidateOperator", "result operator"),
    location: requireLocation(result.location, 1),
    outcome: { id, rawStatus: result.status },
  };
}

function samePosition(left: MutationPosition, right: MutationPosition): boolean {
  return left.line === right.line && left.column === right.column;
}

function resultMatchesCandidate(result: ParsedMutationResult, candidate: MutationCandidate): boolean {
  return (
    result.modulePath === candidate.modulePath &&
    result.operator === candidate.operator &&
    samePosition(result.location.start, candidate.location.start) &&
    samePosition(result.location.end, candidate.location.end)
  );
}

function matchedOutcome(
  result: ParsedMutationResult,
  candidates: ReadonlyMap<string, MutationCandidate>,
): RawMutationOutcome {
  const candidate = candidates.get(result.outcome.id);
  if (candidate === undefined) {
    throw new MutationProtocolError(
      "candidateResultSetMismatch",
      `result ID was not present in the candidate plan: ${result.outcome.id}`,
    );
  }
  if (!resultMatchesCandidate(result, candidate)) {
    throw new MutationProtocolError(
      "candidateResultIdentityMismatch",
      `result identity differs from candidate ${result.outcome.id}`,
    );
  }
  return result.outcome;
}

function sameIds(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left.keys()) if (!right.has(id)) return false;
  return true;
}

function parseFinalOutcomes(
  report: JsonObject,
  candidates: ReadonlyMap<string, MutationCandidate>,
  projectRoot: string,
  productionFiles: readonly string[],
): Map<string, RawMutationOutcome> {
  const files = requireObject(report.files, "invalidFinalReport", "mutation test report files");
  const outcomes = new Map<string, RawMutationOutcome>();
  const production = new Set(productionFiles);
  const reportedSources = new Set<string>();
  for (const [fileName, file] of Object.entries(files)) {
    const modulePath = requireModulePath(fileName, projectRoot);
    if (!production.has(modulePath)) {
      throw new MutationProtocolError(
        "finalReportSourceOutsideProduction",
        "final mutation report contains a source outside production scope",
      );
    }
    if (reportedSources.has(modulePath)) {
      throw new MutationProtocolError(
        "duplicateFinalReportSource",
        "final mutation report contains duplicate canonical source buckets",
      );
    }
    reportedSources.add(modulePath);
    const fileResult = requireObject(file, "invalidFinalReport", "mutation test file");
    if (!Array.isArray(fileResult.mutants)) {
      throw new MutationProtocolError("invalidFinalReport", "mutation test file mutants must be an array");
    }
    for (const rawResult of fileResult.mutants) {
      const outcome = matchedOutcome(
        parseResult(rawResult, projectRoot, modulePath),
        candidates,
      );
      if (outcomes.has(outcome.id)) {
        throw new MutationProtocolError("duplicateCandidateResult", `duplicate final result ID: ${outcome.id}`);
      }
      outcomes.set(outcome.id, outcome);
    }
  }
  return outcomes;
}

function parseReportedProductionFiles(report: JsonObject): readonly string[] {
  const config = requireObject(report.config, "invalidFinalReport", "mutation test config");
  return reportedProductionInventory(config.mutate);
}

function requireCandidatesInsideProduction(
  candidates: ReadonlyMap<string, MutationCandidate>,
  productionFiles: readonly string[],
): void {
  const production = new Set(productionFiles);
  if ([...candidates.values()].some((candidate) => !production.has(candidate.modulePath))) {
    throw new MutationProtocolError(
      "candidateOutsideReportedProduction",
      "candidate plan contains a source outside the reported production inventory",
    );
  }
}

export class SentinelPlanReporter {
  private candidates: Map<string, MutationCandidate> | undefined;
  private readonly streamedOutcomes = new Map<string, RawMutationOutcome>();
  private finalOutcomes: Map<string, RawMutationOutcome> | undefined;
  private productionFiles: readonly string[] | undefined;
  private outcomeSeen = false;
  private finalSeen = false;

  public constructor(private readonly projectRoot = process.cwd()) {
    if (!path.isAbsolute(projectRoot)) {
      throw new MutationProtocolError("invalidProjectRoot", "reporter project root must be absolute");
    }
  }

  public onMutationTestingPlanReady(event: unknown): void {
    if (this.candidates !== undefined || this.outcomeSeen || this.finalSeen) {
      throw new MutationProtocolError(
        "planEventOrderInvalid",
        "mutation plan must occur exactly once before every result",
      );
    }
    const planEvent = requireObject(event, "invalidPlanEvent", "mutation plan event");
    if (!Array.isArray(planEvent.mutantPlans)) {
      throw new MutationProtocolError("invalidPlanEvent", "mutation plan event must contain mutantPlans");
    }
    const candidates = new Map<string, MutationCandidate>();
    for (const rawPlan of planEvent.mutantPlans) {
      const candidate = parseCandidate(rawPlan, this.projectRoot);
      if (candidates.has(candidate.id)) {
        throw new MutationProtocolError("duplicateCandidateId", `duplicate candidate ID: ${candidate.id}`);
      }
      candidates.set(candidate.id, candidate);
    }
    this.candidates = candidates;
  }

  public onMutantTested(value: unknown): void {
    this.outcomeSeen = true;
    if (this.candidates === undefined) {
      throw new MutationProtocolError("planEventMissing", "mutant result arrived before the plan event");
    }
    if (this.finalSeen) {
      throw new MutationProtocolError("resultEventOrderInvalid", "mutant result arrived after the final report");
    }
    const outcome = matchedOutcome(
      parseResult(value, this.projectRoot),
      this.candidates,
    );
    if (this.streamedOutcomes.has(outcome.id)) {
      throw new MutationProtocolError("duplicateCandidateResult", `duplicate result ID: ${outcome.id}`);
    }
    this.streamedOutcomes.set(outcome.id, outcome);
  }

  public onMutationTestReportReady(report: unknown, _metrics: unknown): void {
    if (this.candidates === undefined) {
      throw new MutationProtocolError("planEventMissing", "final report arrived before the plan event");
    }
    if (this.finalSeen) {
      throw new MutationProtocolError("duplicateFinalReport", "final report occurred more than once");
    }
    this.finalSeen = true;
    const finalReport = requireObject(report, "invalidFinalReport", "mutation test report");
    const productionFiles = parseReportedProductionFiles(finalReport);
    requireCandidatesInsideProduction(this.candidates, productionFiles);
    const finalOutcomes = parseFinalOutcomes(
      finalReport,
      this.candidates,
      this.projectRoot,
      productionFiles,
    );
    if (
      !sameIds(this.candidates, this.streamedOutcomes) ||
      !sameIds(this.candidates, finalOutcomes)
    ) {
      throw new MutationProtocolError(
        "candidateResultSetMismatch",
        "candidate, streamed result, and final result ID sets must be identical",
      );
    }
    for (const [id, streamed] of this.streamedOutcomes) {
      if (finalOutcomes.get(id)?.rawStatus !== streamed.rawStatus) {
        throw new MutationProtocolError(
          "candidateResultStatusMismatch",
          `streamed and final statuses differ for candidate ${id}`,
        );
      }
    }
    this.finalOutcomes = finalOutcomes;
    this.productionFiles = productionFiles;
  }

  public finalize(): StrykerMutationRunRecord {
    if (this.candidates === undefined) {
      throw new MutationProtocolError("planEventMissing", "mutation plan event was not observed");
    }
    if (this.finalOutcomes === undefined) {
      throw new MutationProtocolError("finalReportMissing", "final mutation report was not observed");
    }
    if (this.productionFiles === undefined) {
      throw new MutationProtocolError("reportedProductionInventoryMissing", "production inventory was not observed");
    }
    return {
      productionFiles: this.productionFiles,
      candidates: [...this.candidates.values()].sort((left, right) => compareUtf8(left.id, right.id)),
      outcomes: [...this.finalOutcomes.values()].sort((left, right) => compareUtf8(left.id, right.id)),
    };
  }
}
