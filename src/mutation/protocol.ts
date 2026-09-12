export const MUTATION_STATES = [
  "killed",
  "survived",
  "uncovered",
  "timedOut",
  "compileError",
  "runtimeError",
  "pending",
  "ignored",
  "toolError",
] as const;

export type MutationState = (typeof MUTATION_STATES)[number];

export const STRYKER_STATUSES = [
  "Killed",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Timeout",
  "Ignored",
  "Pending",
] as const;

export type StrykerStatus = (typeof STRYKER_STATUSES)[number];
export type CandidatePlanKind = "EarlyResult" | "Run";

export interface MutationPosition {
  readonly line: number;
  readonly column: number;
}

export interface MutationLocation {
  readonly start: MutationPosition;
  readonly end: MutationPosition;
}

export interface MutationCandidate {
  readonly id: string;
  readonly modulePath: string;
  readonly operator: string;
  readonly planKind: CandidatePlanKind;
  readonly location: MutationLocation;
}

export interface RawMutationOutcome {
  readonly id: string;
  readonly rawStatus: string;
}

export interface NormalizedMutationOutcome {
  readonly id: string;
  readonly status: MutationState;
}

export interface TypedKillProof {
  readonly mutantId: string;
  readonly assertionType: string;
  readonly testId: string;
  readonly executionNonce: string;
  readonly controlPassed: boolean;
  readonly assertionFailed: boolean;
  readonly replayMatched: boolean;
  readonly cacheObserved: boolean;
  readonly retryObserved: boolean;
}

export interface MutationRunRecord {
  readonly candidates: readonly MutationCandidate[];
  readonly outcomes: readonly RawMutationOutcome[];
}

export interface StrykerMutationRunRecord extends MutationRunRecord {
  readonly productionFiles: readonly string[];
}

export class MutationProtocolError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "MutationProtocolError";
    this.code = code;
  }
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export function requireMutationId(value: unknown, label = "mutant ID"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new MutationProtocolError("invalidCandidateId", `${label} must be a nonempty single-line string`);
  }
  return value;
}

export function isMutationState(value: unknown): value is MutationState {
  return typeof value === "string" && (MUTATION_STATES as readonly string[]).includes(value);
}

export function isStrykerStatus(value: unknown): value is StrykerStatus {
  return typeof value === "string" && (STRYKER_STATUSES as readonly string[]).includes(value);
}
