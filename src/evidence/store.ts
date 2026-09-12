import { createHmac, randomBytes } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  assignEventOrdinals,
  buildCommitSequenceFile,
  buildEvidenceFile,
  buildProjectStateFile,
  canonicalJsonBytes,
  EvidenceContractError,
  parseCanonicalJsonFile,
  projectStateHmac,
  sha256,
  validateCommitSequenceState,
  validateEvidenceFile,
  validateProjectStateFile,
  type ProjectStateDocument,
  type ValidatedProjectState,
} from "./contract.js";
import { withPosixCommitLock } from "./fcntl-lock.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FINGERPRINT = /^hmac-sha256:[0-9a-f]{64}$/u;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const EVENT_FIELDS = ["commitSequence", "fingerprint", "kind", "schemaVersion", "state"] as const;
const transactionQueues = new Map<string, Promise<void>>();

export interface Finding {
  readonly kind: "crap" | "mutation";
  readonly subject: string;
  readonly state: string;
}

export interface StoredFinding {
  readonly fingerprint: string;
  readonly kind: Finding["kind"];
  readonly state: string;
}

export interface RunEvidenceDraft {
  readonly runId: string;
  readonly correlationId: string;
  readonly command: "crap" | "mutation" | "check";
  readonly mode: "strict" | "local";
  readonly observationSource: "fresh" | "cache";
  readonly sourceRunId: string | null;
  readonly startedAtUtc: string;
  readonly completedAtUtc: string;
  readonly committedAtUtc: string;
  readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly diagnosticCodes: readonly string[];
  readonly findings: readonly Finding[];
}

export interface RunEvidence extends Record<string, unknown> {
  readonly commitSequence: string;
  readonly runId: string;
  readonly findings: readonly StoredFinding[];
}

interface EventDocument extends StoredFinding {
  readonly commitSequence: string;
  readonly schemaVersion: "sentinel-history-event-provisional-v1";
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  return actual.length === sortedExpected.length && actual.every((name, index) => name === sortedExpected[index]);
}

function historyObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvidenceContractError(code);
  }
  return value as Record<string, unknown>;
}

function isPrivateDirectory(metadata: Stats): boolean {
  return !metadata.isSymbolicLink() && metadata.isDirectory() && metadata.uid === process.getuid?.() &&
    (metadata.mode & 0o777) === 0o700;
}

async function privateDirectoryExists(directory: string): Promise<boolean> {
  try {
    if (!isPrivateDirectory(await lstat(directory))) {
      throw new EvidenceContractError("unsafeHistoryDirectory");
    }
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return false;
  }
}

async function requirePrivateDirectory(directory: string, create: boolean): Promise<boolean> {
  if (await privateDirectoryExists(directory)) return true;
  if (!create) return false;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  if (!isPrivateDirectory(await lstat(directory))) {
    throw new EvidenceContractError("unsafeHistoryDirectory");
  }
  return true;
}

async function requireProjectRoot(projectRoot: string): Promise<string> {
  if (!path.isAbsolute(projectRoot)) throw new EvidenceContractError("invalidProjectRoot");
  const metadata = await lstat(projectRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new EvidenceContractError("invalidProjectRoot");
  }
  return realpath(projectRoot);
}

async function stateDirectory(projectRoot: string, create: boolean): Promise<string | null> {
  const root = await requireProjectRoot(projectRoot);
  const sentinel = path.join(root, ".sentinel");
  if (!(await requirePrivateDirectory(sentinel, create))) return null;
  const state = path.join(sentinel, "state-v1");
  if (!(await requirePrivateDirectory(state, create))) return null;
  return state;
}

async function runsDirectory(stateRoot: string, create: boolean): Promise<string | null> {
  const runs = path.join(stateRoot, "runs");
  return (await requirePrivateDirectory(runs, create)) ? runs : null;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isPrivateFile(metadata: Stats): boolean {
  return !metadata.isSymbolicLink() && metadata.isFile() && metadata.uid === process.getuid?.() &&
    metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600;
}

async function readPrivateFile(filePath: string): Promise<Buffer> {
  if (!isPrivateFile(await lstat(filePath))) throw new EvidenceContractError("unsafeHistoryFile");
  return readFile(filePath);
}

async function writeTemporaryFile(directory: string, name: string, payload: Buffer): Promise<string> {
  const temporaryPath = path.join(directory, `.${name}.${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporaryPath;
}

async function publishPrivateFile(directory: string, name: string, payload: Buffer): Promise<void> {
  const temporaryPath = await writeTemporaryFile(directory, name, payload);
  try {
    await link(temporaryPath, path.join(directory, name));
    await unlink(temporaryPath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function replacePrivateFile(directory: string, name: string, payload: Buffer): Promise<void> {
  const temporaryPath = await writeTemporaryFile(directory, name, payload);
  try {
    await rename(temporaryPath, path.join(directory, name));
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function freshProjectState(): ProjectStateDocument {
  const fingerprintHmacKey = randomBytes(32);
  let cleanupLeaseKey = randomBytes(32);
  while (cleanupLeaseKey.equals(fingerprintHmacKey)) cleanupLeaseKey = randomBytes(32);
  return {
    cleanupLeaseKey: cleanupLeaseKey.toString("base64url"),
    fingerprintHmacKey: fingerprintHmacKey.toString("base64url"),
    keyEpoch: 1,
    projectIdentifier: randomBytes(16).toString("base64url"),
    schemaVersion: "sentinel-project-state-v1",
    stateVersion: "state-v1",
  };
}

async function loadOrCreateProjectState(stateRoot: string): Promise<ValidatedProjectState> {
  const statePath = path.join(stateRoot, "project.json");
  try {
    return validateProjectStateFile(await readPrivateFile(statePath));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const payload = buildProjectStateFile(freshProjectState());
  try {
    await publishPrivateFile(stateRoot, "project.json", payload);
    return validateProjectStateFile(payload);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    return validateProjectStateFile(await readPrivateFile(statePath));
  }
}

async function preflightExistingProjectState(stateRoot: string): Promise<boolean> {
  const payload = await optionalPrivateFile(path.join(stateRoot, "project.json"));
  if (payload === null) return false;
  validateProjectStateFile(payload);
  return true;
}

function validateRunId(runId: string): void {
  if (!UUID.test(runId)) throw new EvidenceContractError("runIdInvalid");
}

function redactFinding(key: Buffer, finding: Finding): StoredFinding {
  const payload = `sentinel-finding-v1\0typescript\0${finding.kind}\0${finding.subject}\0${finding.state}`;
  const digest = createHmac("sha256", key).update(payload, "utf8").digest("hex");
  return { fingerprint: `hmac-sha256:${digest}`, kind: finding.kind, state: finding.state };
}

function uniqueFindings(key: Buffer, findings: readonly Finding[]): readonly StoredFinding[] {
  const stored = findings.map((finding) => redactFinding(key, finding));
  const byFingerprint = new Map(stored.map((finding) => [finding.fingerprint, finding]));
  return assignEventOrdinals(stored.map((finding) => finding.fingerprint))
    .map((ordinal) => byFingerprint.get(ordinal.fingerprint)!);
}

function eventDocument(finding: StoredFinding, commitSequence: string): EventDocument {
  return {
    commitSequence,
    fingerprint: finding.fingerprint,
    kind: finding.kind,
    schemaVersion: "sentinel-history-event-provisional-v1",
    state: finding.state,
  };
}

async function writeEvents(
  runRoot: string,
  findings: readonly StoredFinding[],
  commitSequence: string,
): Promise<readonly Record<string, string>[]> {
  if (findings.length === 0) return [];
  const directory = path.join(runRoot, "events");
  await requirePrivateDirectory(directory, true);
  const manifest: Record<string, string>[] = [];
  for (const [index, finding] of findings.entries()) {
    const filename = `${(index + 1).toString(16).padStart(32, "0")}.json`;
    const payload = Buffer.concat([canonicalJsonBytes(eventDocument(finding, commitSequence)), Buffer.from("\n")]);
    await publishPrivateFile(directory, filename, payload);
    manifest.push({ filename, sha256: sha256(payload) });
  }
  await syncDirectory(directory);
  return manifest;
}

function startedDigest(draft: RunEvidenceDraft): string {
  return sha256(canonicalJsonBytes({
    command: draft.command,
    correlationId: draft.correlationId,
    mode: draft.mode,
    observationSource: draft.observationSource,
    runId: draft.runId,
    sourceRunId: draft.sourceRunId,
    startedAtUtc: draft.startedAtUtc,
  }));
}

function componentsPassed(components: RunEvidenceDraft["components"]): boolean {
  return Object.values(components).every((component) => component.pass === true);
}

function evidenceBody(
  draft: RunEvidenceDraft,
  state: ValidatedProjectState,
  commitSequence: string,
  events: readonly Record<string, string>[],
): Record<string, unknown> {
  const passed = componentsPassed(draft.components);
  return {
    certification: draft.mode === "strict" && draft.observationSource === "fresh" && passed,
    command: draft.command,
    commitSequence,
    committedAtUtc: draft.committedAtUtc,
    completedAtUtc: draft.completedAtUtc,
    components: draft.components,
    correlationId: draft.correlationId,
    diagnosticCodes: draft.diagnosticCodes,
    eventCount: events.length,
    events,
    exitCode: passed ? 0 : 2,
    fingerprintVersion: "sentinel-fingerprint-v1",
    keyEpoch: state.document.keyEpoch,
    language: "typescript",
    mode: draft.mode,
    observationSource: draft.observationSource,
    projectStateHmac: projectStateHmac(state),
    runId: draft.runId,
    schemaVersion: "sentinel-evidence-v1",
    sourceRunId: draft.sourceRunId,
    specVersion: "1.0.0",
    startedAtUtc: draft.startedAtUtc,
    startedSha256: startedDigest(draft),
    terminalStatus: passed ? "passed" : "qualityFailed",
  };
}

async function withStateTransaction<T>(stateRoot: string, operation: () => Promise<T>): Promise<T> {
  const previous = transactionQueues.get(stateRoot) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  transactionQueues.set(stateRoot, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (transactionQueues.get(stateRoot) === queued) transactionQueues.delete(stateRoot);
  }
}

async function optionalPrivateFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readPrivateFile(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function highestSequence(records: readonly RunEvidence[]): bigint {
  let highest = 0n;
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.commitSequence)) throw new EvidenceContractError("commitSequenceDuplicate");
    seen.add(record.commitSequence);
    const sequence = BigInt(record.commitSequence);
    if (sequence > highest) highest = sequence;
  }
  return highest;
}

async function allocateCommitSequence(
  stateRoot: string,
  state: ValidatedProjectState,
  retained: readonly RunEvidence[],
): Promise<string> {
  const sequencePath = path.join(stateRoot, "commit-sequence.json");
  const payload = await optionalPrivateFile(sequencePath);
  const completed = retained.map((record) => record.commitSequence);
  const current = validateCommitSequenceState(payload, state.cleanupLeaseKey, completed, []);
  if (current === MAX_UINT64) throw new EvidenceContractError("commitSequenceExhausted");
  const next = String(current + 1n);
  await replacePrivateFile(stateRoot, "commit-sequence.json", buildCommitSequenceFile(next, state.cleanupLeaseKey));
  return next;
}

function requireRunEntry(entry: Dirent): void {
  if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new EvidenceContractError("invalidHistoryRecord");
  }
}

function requireEventShape(value: unknown): Record<string, unknown> {
  const event = historyObject(value, "invalidHistoryRecord");
  if (!exactFields(event, EVENT_FIELDS) || event.schemaVersion !== "sentinel-history-event-provisional-v1") {
    throw new EvidenceContractError("invalidHistoryRecord");
  }
  return event;
}

function requireEventIdentity(event: Record<string, unknown>, commitSequence: string): void {
  if (event.commitSequence !== commitSequence || typeof event.fingerprint !== "string" || !FINGERPRINT.test(event.fingerprint)) {
    throw new EvidenceContractError("eventEvidenceMismatch");
  }
}

function requireEventKind(event: Record<string, unknown>): void {
  if (event.kind !== "crap" && event.kind !== "mutation") throw new EvidenceContractError("invalidHistoryRecord");
}

function requireEventState(event: Record<string, unknown>): void {
  if (typeof event.state !== "string" || event.state.length === 0) throw new EvidenceContractError("invalidHistoryRecord");
}

function requireEventFinding(event: Record<string, unknown>): void {
  requireEventKind(event);
  requireEventState(event);
}

function parseEvent(value: unknown, commitSequence: string): EventDocument {
  const event = requireEventShape(value);
  requireEventIdentity(event, commitSequence);
  requireEventFinding(event);
  return event as unknown as EventDocument;
}

function manifestFilesMatch(names: readonly string[], manifest: readonly Record<string, string>[]): boolean {
  return names.length === manifest.length && names.every((name, index) => name === manifest[index]?.filename);
}

function manifestItem(item: Record<string, string>): readonly [string, string] {
  if (typeof item.filename !== "string" || typeof item.sha256 !== "string") {
    throw new EvidenceContractError("eventManifestInvalid");
  }
  return [item.filename, item.sha256];
}

async function readManifestEvent(
  directory: string,
  item: Record<string, string>,
  commitSequence: string,
): Promise<StoredFinding> {
  const [filename, digest] = manifestItem(item);
  const payload = await readPrivateFile(path.join(directory, filename));
  if (sha256(payload) !== digest) throw new EvidenceContractError("eventManifestDigestMismatch");
  return parseEvent(parseCanonicalJsonFile(payload), commitSequence);
}

async function readManifestEvents(
  runRoot: string,
  evidence: Record<string, unknown>,
): Promise<readonly StoredFinding[]> {
  const manifest = evidence.events as readonly Record<string, string>[];
  if (manifest.length === 0) return [];
  const directory = path.join(runRoot, "events");
  if (!(await requirePrivateDirectory(directory, false))) throw new EvidenceContractError("eventManifestMissing");
  const names = (await readdir(directory)).sort(compareUtf8);
  if (!manifestFilesMatch(names, manifest)) throw new EvidenceContractError("eventManifestSetMismatch");
  const findings: StoredFinding[] = [];
  for (const item of manifest) {
    findings.push(await readManifestEvent(directory, item, evidence.commitSequence as string));
  }
  return findings;
}

async function readEvidenceEntry(
  runsRoot: string,
  entry: Dirent,
  state: ValidatedProjectState,
): Promise<RunEvidence | null> {
  requireRunEntry(entry);
  const runRoot = path.join(runsRoot, entry.name);
  if (!isPrivateDirectory(await lstat(runRoot))) throw new EvidenceContractError("invalidHistoryRecord");
  const payload = await optionalPrivateFile(path.join(runRoot, "evidence.json"));
  if (payload === null) return null;
  const document = validateEvidenceFile(payload, state);
  if (document.runId !== entry.name) throw new EvidenceContractError("runIdDirectoryMismatch");
  const findings = await readManifestEvents(runRoot, document);
  return { ...document, commitSequence: document.commitSequence as string, runId: entry.name, findings };
}

async function readCompletedRuns(
  stateRoot: string,
  state: ValidatedProjectState,
): Promise<readonly RunEvidence[]> {
  const runsRoot = await runsDirectory(stateRoot, false);
  if (runsRoot === null) return [];
  const records: RunEvidence[] = [];
  const entries = await readdir(runsRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    const evidence = await readEvidenceEntry(runsRoot, entry, state);
    if (evidence !== null) records.push(evidence);
  }
  highestSequence(records);
  return records.sort((left, right) => BigInt(left.commitSequence) < BigInt(right.commitSequence) ? -1 : 1);
}

function preflightDraft(draft: RunEvidenceDraft): void {
  validateRunId(draft.runId);
  validateRunId(draft.correlationId);
  if (draft.sourceRunId !== null) validateRunId(draft.sourceRunId);
  if (!Array.isArray(draft.findings) || !Array.isArray(draft.diagnosticCodes)) {
    throw new EvidenceContractError("evidenceDraftInvalid");
  }
}

export async function writeRunEvidenceDraft(projectRoot: string, draft: RunEvidenceDraft): Promise<void> {
  preflightDraft(draft);
  const stateRoot = await stateDirectory(projectRoot, true);
  if (stateRoot === null) throw new EvidenceContractError("historyUnavailable");
  const establishedState = await preflightExistingProjectState(stateRoot);
  await withStateTransaction(stateRoot, async () => {
    await withPosixCommitLock(stateRoot, "exclusive", async () => {
      const state = await loadOrCreateProjectState(stateRoot);
      const retained = await readCompletedRuns(stateRoot, state);
      const commitSequence = await allocateCommitSequence(stateRoot, state, retained);
      const runsRoot = await runsDirectory(stateRoot, true);
      if (runsRoot === null) throw new EvidenceContractError("historyUnavailable");
      const runRoot = path.join(runsRoot, draft.runId);
      await mkdir(runRoot, { mode: 0o700 });
      if (!isPrivateDirectory(await lstat(runRoot))) throw new EvidenceContractError("unsafeHistoryDirectory");
      const findings = uniqueFindings(state.fingerprintHmacKey, draft.findings);
      const events = await writeEvents(runRoot, findings, commitSequence);
      const payload = buildEvidenceFile(evidenceBody(draft, state, commitSequence, events), state);
      await publishPrivateFile(runRoot, "evidence.json", payload);
      await syncDirectory(runRoot);
      await syncDirectory(runsRoot);
    }, { create: !establishedState });
  });
}

export async function readRunEvidence(projectRoot: string): Promise<readonly RunEvidence[]> {
  const stateRoot = await stateDirectory(projectRoot, false);
  if (stateRoot === null) return [];
  return withStateTransaction(stateRoot, () => withPosixCommitLock(stateRoot, "shared", async () => {
    const state = validateProjectStateFile(await readPrivateFile(path.join(stateRoot, "project.json")));
    const records = await readCompletedRuns(stateRoot, state);
    const sequencePayload = await optionalPrivateFile(path.join(stateRoot, "commit-sequence.json"));
    const completed = records.map((record) => record.commitSequence);
    validateCommitSequenceState(sequencePayload, state.cleanupLeaseKey, completed, []);
    return records;
  }));
}
