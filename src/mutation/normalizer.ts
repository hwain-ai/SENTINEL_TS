import {
  type MutationState,
  type NormalizedMutationOutcome,
  type RawMutationOutcome,
  type TypedKillProof,
} from "./protocol.js";

function nonempty(value: string | undefined): boolean {
  const text = String(value);
  return typeof value === "string" && text.length > 0 && !text.includes("\0") && !text.includes("\n") && !text.includes("\r");
}

function proofIdentityMatches(outcome: RawMutationOutcome, proof: Partial<TypedKillProof>): boolean {
  return (
    proof.mutantId === outcome.id &&
    proof.assertionType === "AssertionError" &&
    nonempty(proof.testId) &&
    nonempty(proof.executionNonce)
  );
}

function proofExecutionConfirmsKill(proof: Partial<TypedKillProof>): boolean {
  return (
    proof.controlPassed === true &&
    proof.assertionFailed === true &&
    proof.replayMatched === true &&
    proof.cacheObserved === false &&
    proof.retryObserved === false
  );
}

function confirmsKill(outcome: RawMutationOutcome, proof: TypedKillProof | undefined): boolean {
  const candidate = Object(proof) as Partial<TypedKillProof>;
  return proofIdentityMatches(outcome, candidate) && proofExecutionConfirmsKill(candidate);
}

export function normalizeMutationOutcome(
  outcome: RawMutationOutcome,
  proof?: TypedKillProof,
): NormalizedMutationOutcome {
  if (outcome.rawStatus === "Killed") {
    return { id: outcome.id, status: confirmsKill(outcome, proof) ? "killed" : "runtimeError" };
  }
  const status: Readonly<Record<string, MutationState>> = {
    Survived: "survived",
    NoCoverage: "uncovered",
    Timeout: "timedOut",
    CompileError: "compileError",
    RuntimeError: "runtimeError",
    Pending: "pending",
    Ignored: "ignored",
  };
  return { id: outcome.id, status: status[outcome.rawStatus] ?? "toolError" };
}
