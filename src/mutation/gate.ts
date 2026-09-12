import {
  MUTATION_STATES,
  MutationProtocolError,
  isMutationState,
  requireMutationId,
  type MutationState,
  type NormalizedMutationOutcome,
} from "./protocol.js";

export interface CandidateIdentity {
  readonly id: string;
}

export interface MutationGateResult {
  readonly pass: boolean;
  readonly inScope: number;
  readonly counts: Readonly<Record<MutationState, number>>;
  readonly unauthorizedExclusion: number;
}

function emptyCounts(): Record<MutationState, number> {
  return Object.fromEntries(MUTATION_STATES.map((state) => [state, 0])) as Record<
    MutationState,
    number
  >;
}

function requireUnauthorizedExclusion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MutationProtocolError(
      "invalidUnauthorizedExclusionCount",
      "unauthorized exclusion count must be a nonnegative safe integer",
    );
  }
}

function candidateIdSet(candidates: readonly CandidateIdentity[]): Set<string> {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const id = requireMutationId(candidate.id);
    if (ids.has(id)) {
      throw new MutationProtocolError("duplicateCandidateId", `duplicate candidate ID: ${id}`);
    }
    ids.add(id);
  }
  return ids;
}

function countOutcomes(outcomes: readonly NormalizedMutationOutcome[]): {
  readonly counts: Record<MutationState, number>;
  readonly resultIds: Set<string>;
} {
  const resultIds = new Set<string>();
  const counts = emptyCounts();
  for (const outcome of outcomes) {
    const id = requireMutationId(outcome.id, "result mutant ID");
    if (resultIds.has(id)) {
      throw new MutationProtocolError("duplicateCandidateResult", `duplicate result ID: ${id}`);
    }
    if (!isMutationState(outcome.status)) {
      throw new MutationProtocolError("invalidMutationState", `invalid mutation state for ${id}`);
    }
    resultIds.add(id);
    counts[outcome.status] += 1;
  }
  return { counts, resultIds };
}

function requireExactResultSet(candidateIds: Set<string>, resultIds: Set<string>): void {
  const missing = [...candidateIds].some((id) => !resultIds.has(id));
  if (candidateIds.size !== resultIds.size || missing) {
    throw new MutationProtocolError(
      "candidateResultSetMismatch",
      "candidate and normalized result ID sets must be identical",
    );
  }
}

function mutationPassed(
  inScope: number,
  counts: Readonly<Record<MutationState, number>>,
  unauthorizedExclusion: number,
): boolean {
  const onlyKilled = MUTATION_STATES.every((state) => state === "killed" || counts[state] === 0);
  return inScope > 0 && counts.killed === inScope && onlyKilled && unauthorizedExclusion === 0;
}

export function evaluateMutationGate(
  candidates: readonly CandidateIdentity[],
  outcomes: readonly NormalizedMutationOutcome[],
  unauthorizedExclusion: number,
): MutationGateResult {
  requireUnauthorizedExclusion(unauthorizedExclusion);
  const candidateIds = candidateIdSet(candidates);
  const { counts, resultIds } = countOutcomes(outcomes);
  requireExactResultSet(candidateIds, resultIds);
  const inScope = candidateIds.size;
  const pass = mutationPassed(inScope, counts, unauthorizedExclusion);
  return { pass, inScope, counts, unauthorizedExclusion };
}
