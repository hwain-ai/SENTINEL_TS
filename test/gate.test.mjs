import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { computeCrap } from "../dist/crap.js";
import { evaluateMutationGate } from "../dist/mutation/gate.js";
import {
  DEFAULT_GATE,
  THRESHOLD_PATTERN,
  loadGate,
  parseCrapMax,
  parseMutationMin,
} from "../dist/gate.js";

const golden = JSON.parse(await readFile(new URL("./fixtures/spec/threshold-v1.json", import.meta.url), "utf8"));

function code(action) {
  try {
    action();
  } catch (error) {
    return error?.code;
  }
  return null;
}

test("defaults and pattern match the shared threshold vector", () => {
  assert.equal(DEFAULT_GATE.crapMax.text, golden.defaults.crapMax);
  assert.equal(DEFAULT_GATE.mutationMin.text, golden.defaults.mutationMin);
  assert.equal(THRESHOLD_PATTERN.source, golden.thresholdPattern);
  assert.deepEqual(loadGate(undefined, undefined), DEFAULT_GATE);
});

test("threshold text is read as an exact reduced fraction", () => {
  assert.deepEqual(parseCrapMax("8.50"), { text: "8.50", numerator: 17n, denominator: 2n });
  assert.deepEqual(parseMutationMin("75.01"), { text: "75.01", numerator: 7501n, denominator: 100n });
  for (const value of golden.invalidThresholds) assert.equal(code(() => parseCrapMax(value)), "crapMaxInvalid", value);
  for (const value of golden.invalidCrapMaxes) assert.equal(code(() => parseCrapMax(value)), "crapMaxOutOfRange", value);
  for (const value of golden.invalidMutationMins) {
    assert.equal(code(() => parseMutationMin(value)), "mutationMinOutOfRange", value);
  }
});

test("golden CRAP cases pass or fail against the given limit", () => {
  for (const item of golden.crapCases) {
    const { cyclomaticComplexity, coveredUnits, totalUnits } = item.input;
    const value = computeCrap(cyclomaticComplexity, coveredUnits, totalUnits, parseCrapMax(item.crapMax));
    assert.equal(value.pass, item.expected.pass, item.id);
  }
});

test("default mutation minimum accepts 90 percent, rejects 89.99, and preserves explicit 100", () => {
  for (const [killed, total, expected] of [[9, 10, true], [8999, 10000, false]]) {
    const candidates = Array.from({ length: total }, (_, index) => ({ id: `mutant-${index}` }));
    const outcomes = candidates.map(({ id }, index) => ({ id, status: index < killed ? "killed" : "survived" }));
    assert.equal(evaluateMutationGate(candidates, outcomes, 0).pass, expected);
    assert.equal(evaluateMutationGate(candidates, outcomes, 0, parseMutationMin("100")).pass, false);
  }
});

test("golden mutation cases follow the minimum kill rate", () => {
  for (const item of golden.mutationCases) {
    const candidates = [];
    const outcomes = [];
    for (const [state, count] of Object.entries(item.counts)) {
      for (let index = 0; index < count; index += 1) {
        const id = `${state}-${index}`;
        candidates.push({ id });
        outcomes.push({ id, status: state });
      }
    }
    const result = evaluateMutationGate(candidates, outcomes, item.unauthorizedExclusion, parseMutationMin(item.mutationMin));
    assert.equal(result.pass, item.expected.pass, item.id);
  }
});
