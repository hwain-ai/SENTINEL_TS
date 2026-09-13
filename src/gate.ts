/**
 * Gate thresholds: the CRAP upper bound and the minimum mutation kill rate.
 *
 * The text contract is shared with SENTINEL_SPEC golden/gate/threshold-v1.json:
 * a decimal string with at most two fractional places, read as an exact fraction.
 */

export const THRESHOLD_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/u;
export const DEFAULT_CRAP_MAX = "8";
export const DEFAULT_MUTATION_MIN = "100";

export interface Threshold {
  readonly text: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface GateThresholds {
  readonly crapMax: Threshold;
  readonly mutationMin: Threshold;
}

export class GateInputError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "GateInputError";
    this.code = code;
  }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function parse(text: unknown, field: string): Threshold {
  if (typeof text !== "string" || !THRESHOLD_PATTERN.test(text)) {
    throw new GateInputError(`${field}Invalid`);
  }
  const [whole, fraction = ""] = text.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);
  const divisor = greatestCommonDivisor(numerator, scale);
  return { text, numerator: numerator / divisor, denominator: scale / divisor };
}

export function parseCrapMax(text: unknown): Threshold {
  const value = parse(text, "crapMax");
  if (value.numerator === 0n) throw new GateInputError("crapMaxOutOfRange");
  return value;
}

export function parseMutationMin(text: unknown): Threshold {
  const value = parse(text, "mutationMin");
  if (value.numerator > 100n * value.denominator) throw new GateInputError("mutationMinOutOfRange");
  return value;
}

export const DEFAULT_GATE: GateThresholds = {
  crapMax: parseCrapMax(DEFAULT_CRAP_MAX),
  mutationMin: parseMutationMin(DEFAULT_MUTATION_MIN),
};

export function loadGate(crapMax?: string, mutationMin?: string): GateThresholds {
  return {
    crapMax: crapMax === undefined ? DEFAULT_GATE.crapMax : parseCrapMax(crapMax),
    mutationMin: mutationMin === undefined ? DEFAULT_GATE.mutationMin : parseMutationMin(mutationMin),
  };
}

export function crapPasses(numerator: bigint, denominator: bigint, crapMax: Threshold): boolean {
  return numerator * crapMax.denominator <= crapMax.numerator * denominator;
}

export function killRatePasses(killed: number, inScope: number, mutationMin: Threshold): boolean {
  return BigInt(killed) * 100n * mutationMin.denominator >= mutationMin.numerator * BigInt(inScope);
}
