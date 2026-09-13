import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { strykerPlugins as eventPlugins } from "../dist/mutation/stryker-event-reporter.js";
import { SentinelVitestRunner } from "../dist/mutation/stryker-proof-runner.js";

const EVENT_PREFIX = "SENTINEL_STRYKER_EVENT_V1:";

function plannedMutant() {
  return {
    id: "m1",
    fileName: "src/value.ts",
    mutatorName: "EqualityOperator",
    location: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 1 },
    },
  };
}

function readyReporter() {
  const Reporter = eventPlugins[0].injectableClass;
  const reporter = new Reporter();
  const mutant = plannedMutant();
  reporter.onMutationTestingPlanReady({
    mutantPlans: [{ plan: "Run", mutant, runOptions: { timeout: 1000 }, netTime: 1 }],
  });
  const result = {
    ...mutant,
    location: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 2 },
    },
    status: "Killed",
  };
  reporter.onMutantTested(result);
  reporter.onMutationTestReportReady({
    projectRoot: "/private/project",
    config: { mutate: ["src/value.ts"] },
    files: {
      "src/value.ts": {
        mutants: [result],
      },
    },
  }, {});
  return reporter;
}

async function emittedEvent(reporter) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (value) => {
    writes.push(String(value));
    return true;
  };
  try {
    await reporter.wrapUp();
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = writes.join("").trim();
  assert.ok(output.startsWith(EVENT_PREFIX));
  return JSON.parse(Buffer.from(output.slice(EVENT_PREFIX.length), "base64url").toString("utf8"));
}

function typedProof() {
  return {
    mutantId: "m1",
    assertionType: "AssertionError",
    testId: "rejects changed value",
    executionNonce: "nonce",
    controlPassed: true,
    assertionFailed: true,
    replayMatched: true,
    cacheObserved: false,
    retryObserved: false,
  };
}

test("event reporter accepts only owner-only regular proof entries", async () => {
  const proofDirectory = await mkdtemp(join(tmpdir(), "sentinel-event-proof-"));
  process.env.SENTINEL_TS_PROOF_DIR = proofDirectory;
  const proofName = `${"a".repeat(64)}.json`;
  await writeFile(join(proofDirectory, proofName), JSON.stringify(typedProof()), { mode: 0o600 });

  const event = await emittedEvent(readyReporter());
  assert.deepEqual(event.proofs, [typedProof()]);

  await writeFile(join(proofDirectory, "unexpected.txt"), "no", { mode: 0o600 });
  await assert.rejects(() => readyReporter().wrapUp(), /sentinelProofEntryInvalid/u);
  delete process.env.SENTINEL_TS_PROOF_DIR;
});

test("event reporter rejects a proof with unsafe file permissions", async () => {
  const proofDirectory = await mkdtemp(join(tmpdir(), "sentinel-event-unsafe-"));
  process.env.SENTINEL_TS_PROOF_DIR = proofDirectory;
  const proofPath = join(proofDirectory, `${"b".repeat(64)}.json`);
  await writeFile(proofPath, JSON.stringify(typedProof()), { mode: 0o600 });
  await chmod(proofPath, 0o644);
  try {
    await assert.rejects(() => readyReporter().wrapUp(), /sentinelProofEntryUnsafe/u);
  } finally {
    delete process.env.SENTINEL_TS_PROOF_DIR;
  }
});

class FakeOfficialRunner {
  constructor(dryRuns, mutantRuns) {
    this.dryRuns = [...dryRuns];
    this.mutantRuns = [...mutantRuns];
    this.ctx = {
      state: {
        errorsSet: new Set(),
        getFiles: () => [{ tasks: [{ result: { errors: [{ name: "", constructor: { name: "AssertionError" } }] } }] }],
      },
      projects: [{ config: { retry: 0 } }],
    };
  }

  capabilities() {
    return { reloadEnvironment: true };
  }

  async init() {
    this.initialized = true;
  }

  async dryRun() {
    return this.dryRuns.shift();
  }

  async mutantRun(options) {
    (this.seenOptions ??= []).push(options);
    return this.mutantRuns.shift();
  }

  async dispose() {
    this.disposed = true;
  }
}

test("proof runner replays controls and assertion kills before writing a typed proof", async () => {
  const control = { status: "complete", tests: [{ id: "value test", status: 0 }] };
  const killed = {
    status: "killed",
    killedBy: ["value test"],
    failureMessage: "expected changed value",
  };
  const delegate = new FakeOfficialRunner([control, control], [killed, killed]);
  const runner = new SentinelVitestRunner(delegate);
  const proofDirectory = await mkdtemp(join(tmpdir(), "sentinel-runner-proof-"));
  process.env.SENTINEL_TS_PROOF_DIR = proofDirectory;
  try {
    assert.deepEqual(runner.capabilities(), { reloadEnvironment: true });
    await runner.init();
    assert.deepEqual(await runner.dryRun({}), control);
    assert.deepEqual(await runner.mutantRun({ activeMutant: { id: "m1" } }), killed);
    await runner.dispose();
    assert.equal(delegate.initialized, true);
    assert.equal(delegate.disposed, true);
    const [proofName] = await readdir(proofDirectory);
    const proof = JSON.parse(await readFile(join(proofDirectory, proofName), "utf8"));
    assert.equal(proof.assertionType, "AssertionError");
    assert.equal(proof.testId, "value test");
    assert.equal(proof.controlPassed, true);
    assert.equal(proof.replayMatched, true);
    assert.equal(proof.retryObserved, false);
  } finally {
    delete process.env.SENTINEL_TS_PROOF_DIR;
  }
});

test("proof runner activates a static mutant before import and leaves runtime mutants alone", async () => {
  const survived = { status: "survived", nrOfTests: 1 };
  const delegate = new FakeOfficialRunner([], [survived, survived, survived, survived]);
  const runner = new SentinelVitestRunner(delegate);

  await runner.mutantRun({ activeMutant: { id: "s1" }, mutantActivation: "runtime", reloadEnvironment: true, testFilter: ["a"] });
  await runner.mutantRun({ activeMutant: { id: "r1" }, mutantActivation: "runtime", reloadEnvironment: false, testFilter: ["a"] });

  assert.deepEqual(delegate.seenOptions.map((options) => [options.activeMutant.id, options.mutantActivation]), [
    ["s1", "static"],
    ["s1", "static"],
    ["r1", "runtime"],
    ["r1", "runtime"],
  ]);
  assert.deepEqual(delegate.seenOptions[0].testFilter, ["a"]);
});

test("proof runner fails closed when the two control runs disagree", async () => {
  const passed = { status: "complete", tests: [{ id: "value test", status: 0 }] };
  const failed = { status: "complete", tests: [{ id: "value test", status: 1 }] };
  const runner = new SentinelVitestRunner(new FakeOfficialRunner([passed, failed], []));

  assert.deepEqual(await runner.dryRun({}), {
    status: "error",
    errorMessage: "sentinelControlReplayMismatch",
  });
});
