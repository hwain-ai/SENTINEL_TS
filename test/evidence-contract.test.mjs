import assert from "node:assert/strict";
import test from "node:test";

const PROJECT_STATE = {
  cleanupLeaseKey: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  fingerprintHmacKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  keyEpoch: 1,
  projectIdentifier: "AAECAwQFBgcICQoLDA0ODw",
  schemaVersion: "sentinel-project-state-v1",
  stateVersion: "state-v1",
};

const PROJECT_STATE_FILE_HEX =
  "7b22636c65616e75704c656173654b6579223a22494345694979516c4a69636f4b536f724c4330754c7a41784d6a4d304e5459334f446b364f7a7739506a38222c2266696e6765727072696e74486d61634b6579223a2241414543417751464267634943516f4c4441304f4478415245684d554652595847426b6147787764486838222c226b657945706f6368223a312c2270726f6a6563744964656e746966696572223a2241414543417751464267634943516f4c4441304f4477222c22736368656d6156657273696f6e223a2273656e74696e656c2d70726f6a6563742d73746174652d7631222c22737461746556657273696f6e223a2273746174652d7631227d0a";

const EVIDENCE_BODY = {
  schemaVersion: "sentinel-evidence-v1",
  specVersion: "1.0.0",
  fingerprintVersion: "sentinel-fingerprint-v1",
  correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  language: "python",
  mode: "strict",
  certification: true,
  observationSource: "fresh",
  sourceRunId: null,
  keyEpoch: 1,
  projectStateHmac: "441395de4352207dc696516a31efa8fb34fc5d4df9a9005537342cda21e84354",
  startedSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  diagnosticCodes: [],
  runId: "11111111-1111-4111-8111-111111111111",
  command: "check",
  commitSequence: "1",
  startedAtUtc: "2026-09-03T12:00:00Z",
  completedAtUtc: "2026-09-03T12:00:01.1Z",
  committedAtUtc: "2026-09-03T12:00:01.2Z",
  terminalStatus: "passed",
  exitCode: 0,
  components: {
    crap: {
      callableCount: 1,
      maxNumerator: "8",
      maxDenominator: "1",
      pass: true,
      unknownCount: 0,
    },
    mutation: {
      inScope: 1,
      killed: 1,
      survived: 0,
      uncovered: 0,
      timedOut: 0,
      compileError: 0,
      runtimeError: 0,
      pending: 0,
      ignored: 0,
      toolError: 0,
      unauthorizedExclusion: 0,
      pass: true,
    },
  },
  eventCount: 1,
  events: [
    {
      filename: "00000000000000000000000000000001.json",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ],
};

async function loadContract() {
  try {
    return await import("../dist/evidence/contract.js");
  } catch (error) {
    assert.fail(`evidence contract module must exist: ${String(error)}`);
  }
}

test("canonical JSON matches the SPEC UTF-8 key and control escaping golden", async () => {
  const contract = await loadContract();
  const value = {
    z: "한글/😀",
    a: "quote\" slash/ backslash\\ nul\0 line\n",
  };
  assert.equal(
    contract.canonicalJsonBytes(value).toString("hex"),
    "7b2261223a2271756f74655c2220736c6173682f206261636b736c6173685c5c206e756c5c7530303030206c696e655c7530303061222c227a223a22ed959ceab8802ff09f9880227d",
  );
});

test("canonical JSON rejects non-integer, unsafe, negative, and surrogate values", async () => {
  const contract = await loadContract();
  for (const value of [1.5, 9_007_199_254_740_992, -1, "\ud800", undefined]) {
    assert.throws(() => contract.canonicalJsonBytes({ value }), /canonicalJson/u);
  }
  assert.throws(
    () => contract.canonicalJsonBytes(new Date(0)),
    (error) => error?.code === "canonicalJsonTypeInvalid",
  );
  assert.throws(
    () => contract.canonicalJsonBytes({ [Symbol("not-a-string")]: 1 }),
    (error) => error?.code === "canonicalJsonKeyInvalid",
  );
});

test("project state accepts only the exact canonical separated-key contract", async () => {
  const contract = await loadContract();
  const payload = Buffer.from(PROJECT_STATE_FILE_HEX, "hex");
  assert.deepEqual(contract.validateProjectStateFile(payload).document, PROJECT_STATE);
  assert.equal(
    contract.projectStateHmac(PROJECT_STATE),
    "441395de4352207dc696516a31efa8fb34fc5d4df9a9005537342cda21e84354",
  );

  const sameKeys = { ...PROJECT_STATE, cleanupLeaseKey: PROJECT_STATE.fingerprintHmacKey };
  assert.throws(
    () => contract.validateProjectStateFile(Buffer.concat([contract.canonicalJsonBytes(sameKeys), Buffer.from("\n")])),
    (error) => error?.code === "projectStateKeysNotSeparated",
  );

  const invalidState = { ...PROJECT_STATE, schemaVersion: "project-state-v1" };
  assert.throws(
    () => contract.buildEvidenceFile(EVIDENCE_BODY, invalidState),
    (error) => error?.code === "projectStateSchemaVersionInvalid",
  );
});

test("canonical file parsing rejects lossy number lexemes and duplicate keys with SPEC codes", async () => {
  const contract = await loadContract();
  const canonical = contract.canonicalJsonBytes(PROJECT_STATE).toString("utf8");
  for (const [payload, code] of [
    [canonical.replace('"keyEpoch":1', '"keyEpoch":1.0'), "jsonIntegerLexemeInvalid"],
    [canonical.replace('"keyEpoch":1', '"keyEpoch":1e0'), "jsonIntegerLexemeInvalid"],
    [canonical.replace('"keyEpoch":1', '"keyEpoch":9007199254740992'), "jsonIntegerOutOfRange"],
    [canonical.replace(
      '"schemaVersion":"sentinel-project-state-v1"',
      '"schemaVersion":"sentinel-project-state-v1","schemaVersion":"sentinel-project-state-v1"',
    ), "jsonDuplicateKey"],
  ]) {
    assert.throws(
      () => contract.validateProjectStateFile(Buffer.from(`${payload}\n`)),
      (error) => error?.code === code,
    );
  }
  assert.throws(
    () => contract.parseCanonicalJsonFile(Buffer.from('{"value":-1}\n')),
    (error) => error?.code === "canonicalJsonIntegerOutOfRange",
  );
  assert.throws(
    () => contract.parseCanonicalJsonFile('{"value":1}\n'),
    (error) => error?.code === "jsonBytesRequired",
  );
  assert.throws(
    () => contract.parseCanonicalJsonFile(Buffer.from('{"value":NaN}\n')),
    (error) => error?.code === "jsonIntegerLexemeInvalid",
  );
});

test("commit sequence matches the SPEC derived-key and HMAC golden", async () => {
  const contract = await loadContract();
  const cleanupKey = Buffer.from("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f", "hex");
  const payload = contract.buildCommitSequenceFile("1", cleanupKey);
  assert.equal(
    payload.toString("hex"),
    "7b22686d6163536861323536223a2231353065373833336433666165323436343532643738326664393235353339326265326164393462303463346239346165356262333734623364643762303632222c226c617374416c6c6f6361746564223a2231222c2276657273696f6e223a22636f6d6d69742d73657175656e63652d7631227d0a",
  );
  assert.equal(contract.validateCommitSequenceFile(payload, cleanupKey), 1n);
  assert.throws(
    () => contract.buildCommitSequenceFile("1", "x".repeat(32)),
    (error) => error?.code === "cleanupLeaseKeyInvalid",
  );
});

test("commit sequence state allows gaps and rejects missing, rollback, and duplicate state", async () => {
  const contract = await loadContract();
  const cleanupKey = Buffer.from("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f", "hex");
  const sequence = (value) => value === null ? null : contract.buildCommitSequenceFile(value, cleanupKey);
  assert.equal(contract.validateCommitSequenceState(null, cleanupKey, [], []), 0n);
  assert.equal(contract.validateCommitSequenceState(sequence("5"), cleanupKey, ["1", "3"], ["4"]), 5n);
  for (const [payload, completed, retained, code] of [
    [null, ["1"], [], "commitSequenceMissing"],
    [sequence("3"), ["4"], [], "commitSequenceRollback"],
    [sequence("3"), ["2"], ["4"], "commitSequenceRollback"],
    [sequence("3"), ["2", "2"], [], "commitSequenceDuplicate"],
    [sequence("3"), ["0"], [], "evidenceCommitSequenceInvalid"],
  ]) {
    assert.throws(
      () => contract.validateCommitSequenceState(payload, cleanupKey, completed, retained),
      (error) => error?.code === code,
    );
  }
});

test("event ordinals follow public fingerprint UTF-8 order and reject duplicates", async () => {
  const contract = await loadContract();
  const fingerprints = [
    `hmac-sha256:${"f".repeat(64)}`,
    `hmac-sha256:${"0".repeat(64)}`,
    `hmac-sha256:${"a".repeat(64)}`,
  ];
  assert.deepEqual(contract.assignEventOrdinals(fingerprints), [
    {
      eventId: "00000000000000000000000000000001",
      filename: "00000000000000000000000000000001.json",
      fingerprint: fingerprints[1],
    },
    {
      eventId: "00000000000000000000000000000002",
      filename: "00000000000000000000000000000002.json",
      fingerprint: fingerprints[2],
    },
    {
      eventId: "00000000000000000000000000000003",
      filename: "00000000000000000000000000000003.json",
      fingerprint: fingerprints[0],
    },
  ]);
  assert.throws(
    () => contract.assignEventOrdinals([fingerprints[0], fingerprints[0]]),
    (error) => error?.code === "findingFingerprintDuplicate",
  );
  assert.throws(
    () => contract.assignEventOrdinals(["unkeyed"]),
    (error) => error?.code === "findingFingerprintInvalid",
  );
  assert.throws(
    () => contract.assignEventOrdinals([1]),
    (error) => error?.code === "findingFingerprintInvalid",
  );
  assert.throws(
    () => contract.assignEventOrdinals(null),
    (error) => error?.code === "findingFingerprintsInvalid",
  );
});

test("evidence matches the SPEC HMAC golden and validates the event ordinal", async () => {
  const contract = await loadContract();
  const projectState = contract.validateProjectStateFile(Buffer.from(PROJECT_STATE_FILE_HEX, "hex"));
  const payload = contract.buildEvidenceFile(EVIDENCE_BODY, projectState);
  const document = contract.validateEvidenceFile(payload, projectState);
  assert.equal(document.hmacSha256, "4542679c4ce361bd22a29d30a2f4bfd6149a8e2cbd6ef15984cfa1ff697cae32");
  assert.equal(
    contract.sha256(payload),
    "ab218bbdf80c72b02f93e432a938191612869681803a519f24379ba3b092df6a",
  );

  const invalid = structuredClone(EVIDENCE_BODY);
  invalid.events[0].filename = "00000000000000000000000000000002.json";
  assert.throws(
    () => contract.buildEvidenceFile(invalid, projectState),
    (error) => error?.code === "eventManifestOrdinalInvalid",
  );
});

test("evidence authentication precedes semantic validation and permits historical key epochs", async () => {
  const contract = await loadContract();
  const projectState = contract.validateProjectStateFile(Buffer.from(PROJECT_STATE_FILE_HEX, "hex"));
  const payload = contract.buildEvidenceFile(EVIDENCE_BODY, projectState);
  const tampered = JSON.parse(payload.toString("utf8"));
  tampered.commitSequence = "0";
  const tamperedPayload = Buffer.concat([contract.canonicalJsonBytes(tampered), Buffer.from("\n")]);
  assert.throws(
    () => contract.validateEvidenceFile(tamperedPayload, projectState),
    (error) => error?.code === "evidenceHmacMismatch",
  );

  const rotated = contract.validateProjectStateFile(contract.buildProjectStateFile({
    ...PROJECT_STATE,
    fingerprintHmacKey: Buffer.from(Array.from({ length: 32 }, (_, index) => index + 64)).toString("base64url"),
    keyEpoch: 2,
  }));
  assert.equal(contract.validateEvidenceFile(payload, rotated).keyEpoch, 1);
  assert.throws(
    () => contract.buildEvidenceFile(EVIDENCE_BODY, rotated),
    (error) => error?.code === "keyEpochInvalid",
  );
});

test("fresh evidence requires null sourceRunId and canonical UTC fractions", async () => {
  const contract = await loadContract();
  const projectState = contract.validateProjectStateFile(Buffer.from(PROJECT_STATE_FILE_HEX, "hex"));
  for (const [field, value, code] of [
    ["sourceRunId", "22222222-2222-4222-8222-222222222222", "sourceRunIdInvalid"],
    ["completedAtUtc", "2026-09-03T12:00:01.100Z", "utcTimestampInvalid"],
  ]) {
    const invalid = structuredClone(EVIDENCE_BODY);
    invalid[field] = value;
    assert.throws(
      () => contract.buildEvidenceFile(invalid, projectState),
      (error) => error?.code === code,
    );
  }

  const missingCacheSource = structuredClone(EVIDENCE_BODY);
  missingCacheSource.observationSource = "cache";
  assert.throws(
    () => contract.buildEvidenceFile(missingCacheSource, projectState),
    (error) => error?.code === "sourceRunIdInvalid",
  );

  const earlyYear = structuredClone(EVIDENCE_BODY);
  earlyYear.startedAtUtc = "0001-01-01T00:00:00Z";
  earlyYear.completedAtUtc = "0001-01-01T00:00:01Z";
  earlyYear.committedAtUtc = "0001-01-01T00:00:02Z";
  assert.doesNotThrow(() => contract.buildEvidenceFile(earlyYear, projectState));
});

test("CRAP evidence rejects empty inventories that pass and inconsistent inventory counts", async () => {
  const contract = await loadContract();
  const projectState = contract.validateProjectStateFile(Buffer.from(PROJECT_STATE_FILE_HEX, "hex"));
  for (const [component, code] of [
    [{ callableCount: 0, maxNumerator: "0", maxDenominator: "1", pass: true, unknownCount: 0 },
      "crapComponentSemanticsInvalid"],
    [{ callableCount: 1, maxNumerator: "8", maxDenominator: "1", pass: false, unknownCount: 1 },
      "crapComponentInventoryInvalid"],
    [{ callableCount: 1, maxNumerator: "0", maxDenominator: "1", pass: false, unknownCount: 2 },
      "crapComponentInvalid"],
  ]) {
    const invalid = structuredClone(EVIDENCE_BODY);
    invalid.components.crap = component;
    assert.throws(
      () => contract.buildEvidenceFile(invalid, projectState),
      (error) => error?.code === code,
    );
  }
});

test("mutation tool errors require backendError terminal precedence", async () => {
  const contract = await loadContract();
  const projectState = contract.validateProjectStateFile(Buffer.from(PROJECT_STATE_FILE_HEX, "hex"));
  const invalid = structuredClone(EVIDENCE_BODY);
  invalid.certification = false;
  invalid.terminalStatus = "qualityFailed";
  invalid.exitCode = 2;
  invalid.components.mutation.killed = 0;
  invalid.components.mutation.toolError = 1;
  invalid.components.mutation.pass = false;
  assert.throws(
    () => contract.buildEvidenceFile(invalid, projectState),
    (error) => error?.code === "terminalStatusPrecedenceInvalid",
  );
});
