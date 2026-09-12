import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";
import { readRunEvidence } from "../dist/history.js";

const SECRET_MUTANT_ID = "private-mutant-id-canary";

function runId(character) {
  return `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(12)}`;
}

function plan() {
  return {
    plan: "Run",
    mutant: {
      id: SECRET_MUTANT_ID,
      fileName: "src/private-name.ts",
      mutatorName: "EqualityOperator",
      location: {
        start: { line: 0, column: 0 },
        end: { line: 0, column: 1 },
      },
    },
  };
}

function result() {
  return {
    id: SECRET_MUTANT_ID,
    status: "Survived",
    fileName: "src/private-name.ts",
    mutatorName: "EqualityOperator",
    location: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 2 },
    },
  };
}

function mutationInput() {
  return {
    planEvent: { mutantPlans: [plan()] },
    streamedResults: [result()],
    finalReport: {
      config: { mutate: ["src/private-name.ts"] },
      files: {
        "src/private-name.ts": {
          mutants: [result()],
        },
      },
    },
    proofs: [],
    unauthorizedExclusion: 0,
  };
}

function dependencies(cwd, runId) {
  const output = [];
  const errors = [];
  return {
    value: {
      cwd,
      now: () => "2026-09-03T12:00:00.000Z",
      newRunId: () => runId,
      writeOut: (text) => output.push(text),
      writeError: (text) => errors.push(text),
    },
    output,
    errors,
  };
}

async function recordFailure(project, runId) {
  const inputPath = join(project, "mutation.json");
  await writeFile(inputPath, `${JSON.stringify(mutationInput())}\n`, "utf8");
  const io = dependencies(project, runId);
  const exitCode = await runCli(
    ["mutation", "--input", inputPath, "--project", project],
    io.value,
  );
  assert.equal(exitCode, 2, io.errors.join(""));
  return io;
}

async function firstEvidence(project) {
  const runs = join(project, ".sentinel", "state-v1", "runs");
  const [runId] = await readdir(runs);
  assert.ok(runId);
  return join(runs, runId, "evidence.json");
}

async function firstEvent(project) {
  const evidencePath = await firstEvidence(project);
  const runRoot = join(evidencePath, "..");
  const [eventName] = await readdir(join(runRoot, "events"));
  assert.ok(eventName);
  return join(runRoot, "events", eventName);
}

test("stores only a project-keyed fingerprint in owner-only immutable evidence", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-private-history-"));
  await recordFailure(project, runId("1"));

  const evidencePath = await firstEvidence(project);
  const before = await readFile(evidencePath);
  const text = before.toString("utf8");
  assert.doesNotMatch(text, new RegExp(SECRET_MUTANT_ID, "u"));
  assert.doesNotMatch(text, /private-name/u);
  assert.doesNotMatch(text, new RegExp(project.replaceAll("/", "\\/"), "u"));
  assert.match(text, /"hmacSha256":"[0-9a-f]{64}"/u);
  assert.match(await readFile(await firstEvent(project), "utf8"), /hmac-sha256:[0-9a-f]{64}/u);
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(project, ".sentinel", "state-v1"))).mode & 0o777, 0o700);

  await recordFailure(project, runId("2"));
  assert.deepEqual(await readFile(evidencePath), before);
});

test("uses a different stable fingerprint key for each inspected project", async () => {
  const first = await mkdtemp(join(tmpdir(), "sentinel-ts-project-a-"));
  const second = await mkdtemp(join(tmpdir(), "sentinel-ts-project-b-"));
  await recordFailure(first, runId("3"));
  await recordFailure(second, runId("4"));

  const [firstDocument] = await readRunEvidence(first);
  const [secondDocument] = await readRunEvidence(second);
  assert.notEqual(
    firstDocument.findings[0].fingerprint,
    secondDocument.findings[0].fingerprint,
  );
});

test("fails closed for malformed evidence fields and findings", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-invalid-history-"));
  await recordFailure(project, runId("5"));
  const evidencePath = await firstEvidence(project);
  const original = await readFile(evidencePath);
  const evidence = JSON.parse(original);
  evidence.diagnosticCodes = ["otherCode"];
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => readRunEvidence(project),
    (error) => error?.code === "evidenceHmacMismatch",
  );

  await writeFile(evidencePath, original, { mode: 0o600 });
  const eventPath = await firstEvent(project);
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  event.state = "changed";
  await writeFile(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => readRunEvidence(project),
    (error) => error?.code === "eventManifestDigestMismatch",
  );
});
