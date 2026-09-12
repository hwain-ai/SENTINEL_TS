import assert from "node:assert/strict";
import test from "node:test";

import { evaluateMutationGate } from "../dist/mutation/gate.js";
import { normalizeMutationOutcome } from "../dist/mutation/normalizer.js";
import { buildClosedStrykerConfig } from "../dist/mutation/stryker-adapter.js";
import { SentinelPlanReporter } from "../dist/mutation/stryker-plan-reporter.js";

function plan(id, planKind = "Run") {
  const mutant = {
    id,
    fileName: "src/value.ts",
    mutatorName: "EqualityOperator",
    location: {
      start: { line: 0, column: 9 },
      end: { line: 0, column: 12 },
    },
  };
  return planKind === "Run"
    ? { plan: planKind, mutant, runOptions: { timeout: 1000 }, netTime: 1 }
    : { plan: planKind, mutant: { ...mutant, status: "Ignored" } };
}

function result(id, status) {
  return {
    id,
    status,
    fileName: "src/value.ts",
    mutatorName: "EqualityOperator",
    location: {
      start: { line: 1, column: 10 },
      end: { line: 1, column: 13 },
    },
  };
}

function finalReport(results) {
  return {
    schemaVersion: "2.0",
    thresholds: { high: 80, low: 60 },
    projectRoot: "/private/project",
    config: { mutate: ["src/value.ts"] },
    files: {
      "src/value.ts": {
        language: "typescript",
        source: "export const value = 1;",
        mutants: results.map(({ fileName: _fileName, ...item }) => item),
      },
    },
  };
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

test("freezes the plan and exact-joins streamed and final result IDs", () => {
  const reporter = new SentinelPlanReporter();
  reporter.onMutationTestingPlanReady({ mutantPlans: [plan("m2"), plan("m1")] });
  reporter.onMutantTested(result("m1", "Killed"));
  reporter.onMutantTested(result("m2", "Survived"));
  reporter.onMutationTestReportReady(
    finalReport([result("m2", "Survived"), result("m1", "Killed")]),
    {},
  );

  assert.deepEqual(reporter.finalize(), {
    productionFiles: ["src/value.ts"],
    candidates: [
      {
        id: "m1",
        modulePath: "src/value.ts",
        operator: "EqualityOperator",
        planKind: "Run",
        location: {
          start: { line: 1, column: 10 },
          end: { line: 1, column: 13 },
        },
      },
      {
        id: "m2",
        modulePath: "src/value.ts",
        operator: "EqualityOperator",
        planKind: "Run",
        location: {
          start: { line: 1, column: 10 },
          end: { line: 1, column: 13 },
        },
      },
    ],
    outcomes: [
      { id: "m1", rawStatus: "Killed" },
      { id: "m2", rawStatus: "Survived" },
    ],
  });
});

test("normalizes Stryker absolute candidate paths beneath the fixed project root", () => {
  const reporter = new SentinelPlanReporter("/private/project");
  const absolutePlan = plan("m1");
  absolutePlan.mutant.fileName = "/private/project/src/value.ts";
  reporter.onMutationTestingPlanReady({ mutantPlans: [absolutePlan] });
  reporter.onMutantTested(result("m1", "Survived"));
  reporter.onMutationTestReportReady(finalReport([result("m1", "Survived")]), {});

  assert.equal(reporter.finalize().candidates[0].modulePath, "src/value.ts");
});

test("rejects streamed results whose source identity differs from the frozen candidate", () => {
  const mismatches = [
    { fileName: "src/other.ts" },
    { mutatorName: "BooleanLiteral" },
    { location: { start: { line: 1, column: 9 }, end: { line: 1, column: 13 } } },
  ];
  for (const mismatch of mismatches) {
    const reporter = new SentinelPlanReporter();
    reporter.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] });
    assert.throws(
      () => reporter.onMutantTested({ ...result("m1", "Killed"), ...mismatch }),
      (error) => errorCode(error) === "candidateResultIdentityMismatch",
    );
  }
});

test("rejects a final result placed under a different production source", () => {
  const reporter = new SentinelPlanReporter();
  reporter.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] });
  reporter.onMutantTested(result("m1", "Killed"));
  const report = finalReport([result("m1", "Killed")]);
  report.files["src/other.ts"] = report.files["src/value.ts"];
  delete report.files["src/value.ts"];

  assert.throws(
    () => reporter.onMutationTestReportReady(report, {}),
    (error) => errorCode(error) === "finalReportSourceOutsideProduction",
  );
});

test("rejects extra and duplicate canonical final-report source buckets", () => {
  const extra = new SentinelPlanReporter();
  extra.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] });
  extra.onMutantTested(result("m1", "Killed"));
  const extraReport = finalReport([result("m1", "Killed")]);
  extraReport.files["src/other.ts"] = { mutants: [] };
  assert.throws(
    () => extra.onMutationTestReportReady(extraReport, {}),
    (error) => errorCode(error) === "finalReportSourceOutsideProduction",
  );

  const duplicate = new SentinelPlanReporter("/private/project");
  duplicate.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] });
  duplicate.onMutantTested(result("m1", "Killed"));
  const duplicateReport = finalReport([result("m1", "Killed")]);
  duplicateReport.files["/private/project/src/value.ts"] = { mutants: [] };
  assert.throws(
    () => duplicate.onMutationTestReportReady(duplicateReport, {}),
    (error) => errorCode(error) === "duplicateFinalReportSource",
  );
});

test("rejects missing, duplicate, and late plan events", () => {
  const missing = new SentinelPlanReporter();
  assert.throws(
    () => missing.onMutantTested(result("m1", "Killed")),
    (error) => errorCode(error) === "planEventMissing",
  );

  const duplicate = new SentinelPlanReporter();
  duplicate.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] });
  assert.throws(
    () => duplicate.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] }),
    (error) => errorCode(error) === "planEventOrderInvalid",
  );

  const late = new SentinelPlanReporter();
  assert.throws(() => late.onMutantTested(result("m1", "Killed")));
  assert.throws(
    () => late.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] }),
    (error) => errorCode(error) === "planEventOrderInvalid",
  );
});

test("rejects duplicate candidates and any candidate-result set mismatch", () => {
  const duplicate = new SentinelPlanReporter();
  assert.throws(
    () => duplicate.onMutationTestingPlanReady({ mutantPlans: [plan("m1"), plan("m1")] }),
    (error) => errorCode(error) === "duplicateCandidateId",
  );

  const mismatch = new SentinelPlanReporter();
  mismatch.onMutationTestingPlanReady({ mutantPlans: [plan("m1"), plan("m2")] });
  mismatch.onMutantTested(result("m1", "Killed"));
  assert.throws(
    () => mismatch.onMutationTestReportReady(finalReport([result("m1", "Killed")]), {}),
    (error) => errorCode(error) === "candidateResultSetMismatch",
  );

  const statusMismatch = new SentinelPlanReporter();
  statusMismatch.onMutationTestingPlanReady({ mutantPlans: [plan("m1")] });
  statusMismatch.onMutantTested(result("m1", "Killed"));
  assert.throws(
    () => statusMismatch.onMutationTestReportReady(finalReport([result("m1", "Survived")]), {}),
    (error) => errorCode(error) === "candidateResultStatusMismatch",
  );
});

test("normalizes all Stryker states without trusting an untyped Failed result", () => {
  const expected = new Map([
    ["Survived", "survived"],
    ["NoCoverage", "uncovered"],
    ["Timeout", "timedOut"],
    ["CompileError", "compileError"],
    ["RuntimeError", "runtimeError"],
    ["Pending", "pending"],
    ["Ignored", "ignored"],
  ]);
  for (const [rawStatus, status] of expected) {
    assert.deepEqual(normalizeMutationOutcome({ id: "m1", rawStatus }), {
      id: "m1",
      status,
    });
  }
  assert.deepEqual(normalizeMutationOutcome({ id: "m1", rawStatus: "Killed" }), {
    id: "m1",
    status: "runtimeError",
  });
  assert.deepEqual(
    normalizeMutationOutcome(
      { id: "m1", rawStatus: "Killed" },
      {
        mutantId: "m1",
        assertionType: "AssertionError",
        testId: "value rejects mutation",
        executionNonce: "nonce-1",
        controlPassed: true,
        assertionFailed: true,
        replayMatched: true,
        cacheObserved: false,
        retryObserved: false,
      },
    ),
    { id: "m1", status: "killed" },
  );
  assert.deepEqual(normalizeMutationOutcome({ id: "m1", rawStatus: "FutureState" }), {
    id: "m1",
    status: "toolError",
  });
});

test("rejects a typed proof whose failure is not an approved assertion", () => {
  assert.deepEqual(
    normalizeMutationOutcome(
      { id: "m1", rawStatus: "Killed" },
      {
        mutantId: "m1",
        assertionType: "TypeError",
        testId: "value crashes while loading",
        executionNonce: "nonce-1",
        controlPassed: true,
        assertionFailed: true,
        replayMatched: true,
        cacheObserved: false,
        retryObserved: false,
      },
    ),
    { id: "m1", status: "runtimeError" },
  );
});

test("passes only a nonempty exact all-killed 9-state gate", () => {
  const candidates = [{ id: "m1" }, { id: "m2" }];
  const passed = evaluateMutationGate(
    candidates,
    [
      { id: "m2", status: "killed" },
      { id: "m1", status: "killed" },
    ],
    0,
  );
  assert.equal(passed.pass, true);
  assert.equal(passed.inScope, 2);
  assert.deepEqual(passed.counts, {
    killed: 2,
    survived: 0,
    uncovered: 0,
    timedOut: 0,
    compileError: 0,
    runtimeError: 0,
    pending: 0,
    ignored: 0,
    toolError: 0,
  });

  for (const status of Object.keys(passed.counts).filter((value) => value !== "killed")) {
    const failed = evaluateMutationGate([{ id: "m1" }], [{ id: "m1", status }], 0);
    assert.equal(failed.pass, false, status);
  }
  assert.equal(evaluateMutationGate([], [], 0).pass, false);
  assert.equal(evaluateMutationGate([{ id: "m1" }], [{ id: "m1", status: "killed" }], 1).pass, false);
  assert.throws(
    () => evaluateMutationGate([{ id: "m1" }], [{ id: "other", status: "killed" }], 0),
    (error) => errorCode(error) === "candidateResultSetMismatch",
  );
});

test("builds the one closed Stryker configuration and rejects ambiguous scope", () => {
  const configuration = buildClosedStrykerConfig(
    ["src/z.ts", "src/a.ts"],
    ["test/z.test.ts", "test/a.test.ts"],
    "test/sentinel.vitest.config.mjs",
  );
  assert.deepEqual(configuration, {
    mutate: ["src/a.ts", "src/z.ts"],
    testRunner: "vitest",
    vitest: { configFile: "test/sentinel.vitest.config.mjs" },
    coverageAnalysis: "perTest",
    mutator: { excludedMutations: [], plugins: null },
    incremental: false,
    force: true,
    inPlace: false,
    ignoreStatic: false,
    disableTypeChecks: false,
    ignorePatterns: [
      "**",
      "!src/a.ts",
      "!src/z.ts",
      "!test/a.test.ts",
      "!test/z.test.ts",
    ],
  });
  assert.throws(
    () => buildClosedStrykerConfig(["src/a.ts", "src/a.ts"], ["test/a.test.ts"]),
    (error) => errorCode(error) === "duplicateScopePath",
  );
  assert.throws(
    () => buildClosedStrykerConfig([], ["test/a.test.ts"]),
    (error) => errorCode(error) === "emptyProductionScope",
  );
});
