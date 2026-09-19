import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";
import { readRunEvidence } from "../dist/history.js";

function runId(character) {
  return `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(12)}`;
}

function plan(id) {
  return {
    plan: "Run",
    mutant: {
      id,
      fileName: "src/value.ts",
      mutatorName: "EqualityOperator",
      location: {
        start: { line: 0, column: 9 },
        end: { line: 0, column: 12 },
      },
    },
    runOptions: { timeout: 1000 },
    netTime: 1,
  };
}

function rawResult(id, status) {
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

function mutationInput(status, proof) {
  const id = "m1";
  return {
    planEvent: { mutantPlans: [plan(id)] },
    streamedResults: [rawResult(id, status)],
    finalReport: {
      config: { mutate: ["src/value.ts"] },
      files: {
        "src/value.ts": {
          mutants: [rawResult(id, status)],
        },
      },
    },
    proofs: proof === undefined ? [] : [proof],
    unauthorizedExclusion: 0,
  };
}

function dependencies(cwd, runIds) {
  const output = [];
  const errors = [];
  return {
    value: {
      cwd,
      now: () => "2026-09-03T00:00:00.000Z",
      newRunId: () => runIds.shift(),
      writeOut: (text) => output.push(text),
      writeError: (text) => errors.push(text),
    },
    output,
    errors,
  };
}

test("help is side-effect free and lists all five commands", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-help-"));
  const io = dependencies(project, []);

  const exitCode = await runCli(["--help"], io.value);

  assert.equal(exitCode, 0);
  assert.match(io.output.join(""), /crap.*mutation.*check.*version.*history/su);
  await assert.rejects(() => readdir(join(project, ".sentinel-ts")), /ENOENT/u);
});

test("mutation records project-local evidence and history reports a repeated defect", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-history-"));
  const inputPath = join(project, "mutation.json");
  await writeFile(inputPath, `${JSON.stringify(mutationInput("Survived"))}\n`, "utf8");

  for (const id of [runId("1"), runId("2")]) {
    const io = dependencies(project, [id]);
    const exitCode = await runCli(
      ["mutation", "--input", inputPath, "--project", project],
      io.value,
    );
    assert.equal(exitCode, 2, io.errors.join(""));
    assert.equal(JSON.parse(io.output.join("")).gate.pass, false);
  }

  const historyIo = dependencies(project, []);
  const historyExit = await runCli(
    ["history", "--project", project, "--repeated"],
    historyIo.value,
  );
  assert.equal(historyExit, 0, historyIo.errors.join(""));
  const history = JSON.parse(historyIo.output.join(""));
  assert.equal(history.runCount, 2);
  assert.equal(history.repeated.length, 1);
  assert.equal(history.repeated[0].occurrences, 2);
  assert.equal(history.repeated[0].state, "survived");

  const historyFiles = await readdir(join(project, ".sentinel", "state-v1", "runs"));
  assert.deepEqual(historyFiles.sort(), [
    runId("1"),
    runId("2"),
  ]);
  const stored = JSON.parse(
    await readFile(
      join(project, ".sentinel", "state-v1", "runs", historyFiles[0], "evidence.json"),
      "utf8",
    ),
  );
  assert.equal(stored.command, "mutation");
  assert.equal(stored.findings, undefined);
  const [record] = await readRunEvidence(project);
  assert.equal(record.findings[0].state, "survived");
  assert.equal(record.findings[0].subject, undefined);
});

test("typed kill proof makes mutation pass while a protocol mismatch exits 6", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-proof-"));
  const proof = {
    mutantId: "m1",
    assertionType: "AssertionError",
    testId: "value rejects mutation",
    executionNonce: "nonce-1",
    controlPassed: true,
    assertionFailed: true,
    replayMatched: true,
    cacheObserved: false,
    retryObserved: false,
  };
  const passedPath = join(project, "passed.json");
  await writeFile(passedPath, `${JSON.stringify(mutationInput("Killed", proof))}\n`, "utf8");
  const passedIo = dependencies(project, [runId("3")]);
  assert.equal(
    await runCli(["mutation", "--input", passedPath, "--project", project], passedIo.value),
    0,
    passedIo.errors.join(""),
  );

  const mismatched = mutationInput("Survived");
  mismatched.finalReport.files["src/value.ts"].mutants = [];
  const mismatchPath = join(project, "mismatch.json");
  await writeFile(mismatchPath, `${JSON.stringify(mismatched)}\n`, "utf8");
  const mismatchIo = dependencies(project, [runId("4")]);
  assert.equal(
    await runCli(["mutation", "--input", mismatchPath, "--project", project], mismatchIo.value),
    6,
  );
  assert.equal(JSON.parse(mismatchIo.errors.join("")).error.code, "candidateResultSetMismatch");
});

test("crap, check, and version expose machine-readable vertical slices", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-check-"));
  const crapRows = {
    rows: [
      { id: "small", complexity: 1, covered: 1, total: 1 },
      { id: "risky", complexity: 9, covered: 1, total: 1 },
    ],
  };
  const crapPath = join(project, "crap.json");
  await writeFile(crapPath, `${JSON.stringify(crapRows)}\n`, "utf8");
  const crapIo = dependencies(project, []);
  assert.equal(await runCli(["crap", "--input", crapPath], crapIo.value), 2);
  assert.equal(JSON.parse(crapIo.output.join("")).rows[0].id, "risky");
  assert.equal(JSON.parse(crapIo.output.join("")).crapMax, "8");

  const raisedIo = dependencies(project, []);
  assert.equal(await runCli(["crap", "--input", crapPath, "--crap-max", "9"], raisedIo.value), 0);
  assert.equal(JSON.parse(raisedIo.output.join("")).crapMax, "9");

  const invalidIo = dependencies(project, []);
  assert.equal(await runCli(["crap", "--input", crapPath, "--crap-max", "9."], invalidIo.value), 3);
  assert.equal(JSON.parse(invalidIo.errors.join("")).error.code, "crapMaxInvalid");

  const checkPath = join(project, "check.json");
  await writeFile(
    checkPath,
    `${JSON.stringify({
      crap: {
        rows: [
          crapRows.rows[0],
          { id: "also-safe", complexity: 2, covered: 1, total: 1 },
        ],
      },
      mutation: mutationInput("Survived"),
    })}\n`,
    "utf8",
  );
  const checkIo = dependencies(project, [runId("5")]);
  assert.equal(
    await runCli(["check", "--input", checkPath, "--project", project], checkIo.value),
    2,
  );
  assert.deepEqual(JSON.parse(checkIo.output.join("")).pass, false);

  const lenientIo = dependencies(project, [runId("6")]);
  assert.equal(
    await runCli(["check", "--input", checkPath, "--project", project, "--mutation-min", "0"], lenientIo.value),
    0,
  );
  const lenient = JSON.parse(lenientIo.output.join(""));
  assert.equal(lenient.pass, true);
  assert.deepEqual(lenient.gate, { crapMax: "8", mutationMin: "0" });
  const recorded = (await readRunEvidence(project)).find((run) => run.runId === runId("6"));
  assert.equal(recorded.components.mutation.mutationMin, "0");
  assert.equal(recorded.components.crap.crapMax, "8");

  const versionIo = dependencies(project, []);
  assert.equal(await runCli(["version"], versionIo.value), 0);
  assert.deepEqual(JSON.parse(versionIo.output.join("")), {
    repository: "SENTINEL_TS",
    node: "22.23.1",
    npm: "10.9.8",
    stryker: "10.0.0",
    vitestRunner: "10.0.0",
    status: "ready",
    diagnostics: [],
  });
});

test("reports authenticated evidence failures with their stable code and exit 7", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-evidence-error-"));
  const stateRoot = join(project, ".sentinel", "state-v1");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(stateRoot, "project.json"),
    '{"fingerprintKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","schemaVersion":"sentinel-project-state-v1"}\n',
    { mode: 0o600 },
  );
  const inputPath = join(project, "mutation.json");
  await writeFile(inputPath, `${JSON.stringify(mutationInput("Survived"))}\n`, "utf8");
  const io = dependencies(project, [runId("6")]);

  assert.equal(
    await runCli(["mutation", "--input", inputPath, "--project", project], io.value),
    7,
  );
  assert.equal(JSON.parse(io.errors.join("")).error.code, "projectStateFieldsInvalid");
});
