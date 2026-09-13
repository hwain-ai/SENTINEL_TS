import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readRunEvidence,
  writeRunEvidenceDraft,
} from "../dist/history.js";
import {
  buildCommitSequenceFile,
  buildProjectStateFile,
  projectStateHmac,
  sha256,
  validateCommitSequenceFile,
  validateEvidenceFile,
  validateProjectStateFile,
} from "../dist/evidence/contract.js";

const FIRST_RUN = "11111111-1111-4111-8111-111111111111";
const SECOND_RUN = "22222222-2222-4222-8222-222222222222";

function mutationComponent(pass = false) {
  return {
    inScope: 1,
    killed: pass ? 1 : 0,
    survived: pass ? 0 : 1,
    uncovered: 0,
    timedOut: 0,
    compileError: 0,
    runtimeError: 0,
    pending: 0,
    ignored: 0,
    toolError: 0,
    unauthorizedExclusion: 0,
    mutationMin: "100",
    pass,
  };
}

function draft(runId, pass = false) {
  return {
    runId,
    correlationId: FIRST_RUN,
    command: "mutation",
    mode: "strict",
    observationSource: "fresh",
    sourceRunId: null,
    startedAtUtc: "2026-09-03T12:00:00Z",
    completedAtUtc: "2026-09-03T12:00:01Z",
    committedAtUtc: "2026-09-03T12:00:02Z",
    components: { mutation: mutationComponent(pass) },
    diagnosticCodes: pass ? [] : ["survivedMutant"],
    findings: pass ? [] : [{ kind: "mutation", subject: "private-mutant-id", state: "survived" }],
  };
}

function stateDirectory(project) {
  return join(project, ".sentinel", "state-v1");
}

test("stores an authenticated project, sequence, event manifest, and terminal evidence", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-auth-store-"));
  await assert.doesNotReject(() => writeRunEvidenceDraft(project, draft(FIRST_RUN)));

  const stateRoot = stateDirectory(project);
  const projectPayload = await readFile(join(stateRoot, "project.json"));
  const projectState = validateProjectStateFile(projectPayload);
  assert.notEqual(projectState.document.fingerprintHmacKey, projectState.document.cleanupLeaseKey);
  assert.equal(projectState.document.projectIdentifier.length, 22);
  assert.equal((await stat(join(stateRoot, "project.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateRoot, "commit.lock"))).mode & 0o777, 0o600);

  const sequencePayload = await readFile(join(stateRoot, "commit-sequence.json"));
  assert.equal(validateCommitSequenceFile(sequencePayload, projectState.cleanupLeaseKey), 1n);

  const runRoot = join(stateRoot, "runs", FIRST_RUN);
  const evidencePayload = await readFile(join(runRoot, "evidence.json"));
  const evidence = validateEvidenceFile(evidencePayload, projectState);
  assert.equal(evidence.schemaVersion, "sentinel-evidence-v1");
  assert.equal(evidence.commitSequence, "1");
  assert.equal(evidence.sourceRunId, null);
  assert.equal(evidence.language, "typescript");
  assert.equal(evidence.findings, undefined);
  assert.deepEqual(evidence.events.map((entry) => entry.filename), [
    "00000000000000000000000000000001.json",
  ]);
  const eventPayload = await readFile(join(runRoot, "events", evidence.events[0].filename));
  assert.equal(sha256(eventPayload), evidence.events[0].sha256);
  assert.doesNotMatch(evidencePayload.toString("utf8"), /private-mutant-id/u);
});

test("allocates increasing authenticated sequence values and orders history by them", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-auth-sequence-"));
  await writeRunEvidenceDraft(project, draft(FIRST_RUN));
  await writeRunEvidenceDraft(project, draft(SECOND_RUN));

  const records = await readRunEvidence(project);
  assert.deepEqual(records.map((record) => record.commitSequence), ["1", "2"]);
  const state = validateProjectStateFile(await readFile(join(stateDirectory(project), "project.json")));
  assert.equal(
    validateCommitSequenceFile(
      await readFile(join(stateDirectory(project), "commit-sequence.json")),
      state.cleanupLeaseKey,
    ),
    2n,
  );
});

test("rejects evidence HMAC tampering without rewriting the record", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-auth-tamper-"));
  await writeRunEvidenceDraft(project, draft(FIRST_RUN));
  const evidencePath = join(stateDirectory(project), "runs", FIRST_RUN, "evidence.json");
  const before = await readFile(evidencePath);
  const document = JSON.parse(before);
  document.diagnosticCodes = ["otherCode"];
  await writeFile(evidencePath, `${JSON.stringify(document)}\n`, { mode: 0o600 });

  await assert.rejects(
    () => readRunEvidence(project),
    (error) => error?.code === "evidenceHmacMismatch",
  );
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
});

test("rejects a validly signed commit sequence rollback below retained evidence", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-auth-rollback-"));
  await writeRunEvidenceDraft(project, draft(FIRST_RUN));
  await writeRunEvidenceDraft(project, draft(SECOND_RUN));
  const root = stateDirectory(project);
  const state = validateProjectStateFile(await readFile(join(root, "project.json")));
  await writeFile(
    join(root, "commit-sequence.json"),
    buildCommitSequenceFile("1", state.cleanupLeaseKey),
    { mode: 0o600 },
  );

  await assert.rejects(
    () => readRunEvidence(project),
    (error) => error?.code === "commitSequenceRollback",
  );
});

test("project binding survives fingerprint-key rotation but binds another project identifier", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-auth-binding-"));
  await writeRunEvidenceDraft(project, draft(FIRST_RUN));
  const path = join(stateDirectory(project), "project.json");
  const original = validateProjectStateFile(await readFile(path));
  const rotatedDocument = {
    ...original.document,
    fingerprintHmacKey: Buffer.alloc(32, 0x7f).toString("base64url"),
    keyEpoch: 2,
  };
  const rotated = validateProjectStateFile(buildProjectStateFile(rotatedDocument));
  assert.equal(projectStateHmac(rotated), projectStateHmac(original));

  const other = validateProjectStateFile(buildProjectStateFile({
    ...rotatedDocument,
    projectIdentifier: Buffer.alloc(16, 0x7f).toString("base64url"),
  }));
  assert.notEqual(projectStateHmac(other), projectStateHmac(original));
});

test("does not replace an old unauthenticated project state", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-old-state-"));
  const root = stateDirectory(project);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const oldPayload = Buffer.from(`${JSON.stringify({
    fingerprintKey: Buffer.alloc(32, 1).toString("base64url"),
    schemaVersion: "sentinel-project-state-v1",
  })}\n`);
  const statePath = join(root, "project.json");
  await writeFile(statePath, oldPayload, { mode: 0o600 });
  await assert.rejects(() => writeRunEvidenceDraft(project, draft(FIRST_RUN)));
  assert.deepEqual(await readFile(statePath), oldPayload);
  assert.deepEqual(await readdir(root), ["project.json"]);
});

test("fails closed when an established state loses its commit lock", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-missing-commit-lock-"));
  await writeRunEvidenceDraft(project, draft(FIRST_RUN));
  await unlink(join(stateDirectory(project), "commit.lock"));

  await assert.rejects(
    () => readRunEvidence(project),
    (error) => error?.code === "commitLockMissing",
  );
});

test("rejects duplicate public finding fingerprints before publishing evidence", async () => {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-duplicate-finding-"));
  const duplicate = draft(FIRST_RUN);
  duplicate.findings = [duplicate.findings[0], duplicate.findings[0]];
  await assert.rejects(
    () => writeRunEvidenceDraft(project, duplicate),
    (error) => error?.code === "findingFingerprintDuplicate",
  );
  const runRoot = join(stateDirectory(project), "runs", FIRST_RUN);
  assert.deepEqual(await readdir(runRoot), []);
});
