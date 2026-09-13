import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { MutationProtocolError } from "../mutation/protocol.js";
import { parseProjectConfigJson } from "../project-json.js";

import { GateInputError, crapPasses, killRatePasses, parseCrapMax, parseMutationMin, type Threshold } from "../gate.js";

const MAX_SAFE_INTEGER_TEXT = "9007199254740991";
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const PROJECT_STATE_FIELDS = [
  "cleanupLeaseKey",
  "fingerprintHmacKey",
  "keyEpoch",
  "projectIdentifier",
  "schemaVersion",
  "stateVersion",
] as const;
const EVIDENCE_BODY_FIELDS = [
  "certification",
  "command",
  "commitSequence",
  "committedAtUtc",
  "completedAtUtc",
  "components",
  "correlationId",
  "diagnosticCodes",
  "eventCount",
  "events",
  "exitCode",
  "fingerprintVersion",
  "keyEpoch",
  "language",
  "mode",
  "observationSource",
  "projectStateHmac",
  "runId",
  "schemaVersion",
  "sourceRunId",
  "specVersion",
  "startedAtUtc",
  "startedSha256",
  "terminalStatus",
] as const;
const CRAP_FIELDS = ["callableCount", "crapMax", "maxDenominator", "maxNumerator", "pass", "unknownCount"] as const;
const MUTATION_STATES = [
  "killed",
  "survived",
  "uncovered",
  "timedOut",
  "compileError",
  "runtimeError",
  "pending",
  "ignored",
  "toolError",
] as const;
const MUTATION_FIELDS = [...MUTATION_STATES, "inScope", "mutationMin", "pass", "unauthorizedExclusion"] as const;
const SEQUENCE_KEY_DOMAIN = Buffer.from("SENTINEL\0commit-sequence-key\0v1\0", "ascii");
const SEQUENCE_MAC_DOMAIN = Buffer.from("SENTINEL\0commit-sequence\0v1\0", "ascii");
const EVIDENCE_KEY_DOMAIN = Buffer.from("SENTINEL\0evidence-key\0v1\0", "ascii");
const EVIDENCE_MAC_DOMAIN = Buffer.from("SENTINEL\0evidence\0v1\0", "ascii");
const PROJECT_STATE_DOMAIN = Buffer.from("SENTINEL\0project-state-binding\0v1\0", "ascii");
const HEX_256 = /^[0-9a-f]{64}$/u;
const POSITIVE_UINT64 = /^[1-9][0-9]*$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const SAFE_CODE = /^[a-z][A-Za-z0-9]{0,63}$/u;
const PUBLIC_FINGERPRINT = /^hmac-sha256:[0-9a-f]{64}$/u;
const EVENT_FILENAME = /^[0-9a-f]{32}\.json$/u;
const UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/u;

const TERMINAL_EXIT: Readonly<Record<string, number>> = {
  passed: 0,
  toolError: 1,
  qualityFailed: 2,
  baselineFailed: 4,
  dependencyError: 5,
  backendError: 6,
  evidenceError: 7,
  cancelled: 8,
};

export interface ProjectStateDocument {
  readonly cleanupLeaseKey: string;
  readonly fingerprintHmacKey: string;
  readonly keyEpoch: number;
  readonly projectIdentifier: string;
  readonly schemaVersion: "sentinel-project-state-v1";
  readonly stateVersion: "state-v1";
}

export interface ValidatedProjectState {
  readonly document: ProjectStateDocument;
  readonly cleanupLeaseKey: Buffer;
  readonly fingerprintHmacKey: Buffer;
  readonly projectIdentifier: Buffer;
}

export type ProjectStateInput = ProjectStateDocument | ValidatedProjectState;

export interface EventOrdinal {
  readonly eventId: string;
  readonly filename: string;
  readonly fingerprint: string;
}

export class EvidenceContractError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "EvidenceContractError";
    this.code = code;
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvidenceContractError(code);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  return actual.length === sortedExpected.length && actual.every((name, index) => name === sortedExpected[index]);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function encodeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceContractError("canonicalJsonIntegerOutOfRange");
  }
  return Buffer.from(String(value), "ascii");
}

function encodeCharacter(character: string): string {
  const codepoint = character.codePointAt(0)!;
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) {
    throw new EvidenceContractError("canonicalJsonUnicodeScalarInvalid");
  }
  if (character === "\"" || character === "\\") return `\\${character}`;
  if (codepoint <= 0x1f) return `\\u${codepoint.toString(16).padStart(4, "0")}`;
  return character;
}

function encodeString(value: string): Buffer {
  let output = "\"";
  for (const character of value) output += encodeCharacter(character);
  return Buffer.from(`${output}\"`, "utf8");
}

function encodeArray(value: readonly unknown[]): Buffer {
  const encoded = value.map((item) => canonicalJsonBytes(item));
  return Buffer.concat([Buffer.from("["), joinBuffers(encoded), Buffer.from("]")]);
}

function encodeObject(value: Record<string, unknown>): Buffer {
  const names = Object.keys(value).sort(compareUtf8);
  const encoded = names.map((name) => Buffer.concat([
    encodeString(name),
    Buffer.from(":"),
    canonicalJsonBytes(value[name]),
  ]));
  return Buffer.concat([Buffer.from("{"), joinBuffers(encoded), Buffer.from("}")]);
}

function joinBuffers(values: readonly Buffer[]): Buffer {
  const output: Buffer[] = [];
  for (const [index, value] of values.entries()) {
    if (index > 0) output.push(Buffer.from(","));
    output.push(value);
  }
  return Buffer.concat(output);
}

function canonicalObject(value: object): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EvidenceContractError("canonicalJsonTypeInvalid");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new EvidenceContractError("canonicalJsonKeyInvalid");
  }
  return value as Record<string, unknown>;
}

export function canonicalJsonBytes(value: unknown): Buffer {
  if (value === null) return Buffer.from("null");
  if (typeof value === "boolean") return Buffer.from(value ? "true" : "false");
  if (typeof value === "number") return encodeInteger(value);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return encodeArray(value);
  if (typeof value === "object") return encodeObject(canonicalObject(value));
  throw new EvidenceContractError("canonicalJsonTypeInvalid");
}

export function assignEventOrdinals(fingerprints: unknown): readonly EventOrdinal[] {
  if (!Array.isArray(fingerprints)) throw new EvidenceContractError("findingFingerprintsInvalid");
  if (fingerprints.some((value) => typeof value !== "string" || !PUBLIC_FINGERPRINT.test(value))) {
    throw new EvidenceContractError("findingFingerprintInvalid");
  }
  const values = fingerprints as string[];
  if (new Set(values).size !== values.length) throw new EvidenceContractError("findingFingerprintDuplicate");
  return [...values].sort(compareUtf8).map((fingerprint, index) => {
    const eventId = (index + 1).toString(16).padStart(32, "0");
    return { eventId, filename: `${eventId}.json`, fingerprint };
  });
}

function parseJsonText(text: string): unknown {
  try {
    return parseProjectConfigJson(text);
  } catch (error) {
    if (error instanceof MutationProtocolError && error.code === "projectConfigDuplicateKey") {
      throw new EvidenceContractError("jsonDuplicateKey");
    }
    throw new EvidenceContractError("jsonSyntaxInvalid");
  }
}

function requireIntegerLexeme(token: string): void {
  if (token === "-0" || /[.eE]/u.test(token)) {
    throw new EvidenceContractError("jsonIntegerLexemeInvalid");
  }
}

function requireSafeIntegerMagnitude(magnitude: string): void {
  const tooLong = magnitude.length > MAX_SAFE_INTEGER_TEXT.length;
  const sameLengthTooLarge = magnitude.length === MAX_SAFE_INTEGER_TEXT.length && magnitude > MAX_SAFE_INTEGER_TEXT;
  if (tooLong || sameLengthTooLarge) throw new EvidenceContractError("jsonIntegerOutOfRange");
}

function validateNumberToken(token: string): void {
  requireIntegerLexeme(token);
  const magnitude = token.startsWith("-") ? token.slice(1) : token;
  requireSafeIntegerMagnitude(magnitude);
}

function validateNumberLexemes(text: string): void {
  const tokens = text.matchAll(
    /"(?:\\.|[^"\\])*"|(?:^|[\s[:,])(NaN|-?Infinity)(?=$|[\s}\],])|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/gu,
  );
  for (const match of tokens) {
    if (match[1] !== undefined) throw new EvidenceContractError("jsonIntegerLexemeInvalid");
    const token = match[0];
    if (!token.startsWith("\"")) validateNumberToken(token);
  }
}

export function parseCanonicalJsonFile(payload: unknown): unknown {
  if (!Buffer.isBuffer(payload)) throw new EvidenceContractError("jsonBytesRequired");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new EvidenceContractError("jsonUtf8Invalid");
  }
  if (text.startsWith("\ufeff")) throw new EvidenceContractError("jsonBomForbidden");
  validateNumberLexemes(text);
  const document = parseJsonText(text);
  if (!payload.equals(Buffer.concat([canonicalJsonBytes(document), Buffer.from("\n")]))) {
    throw new EvidenceContractError("canonicalJsonMismatch");
  }
  return document;
}

function decodeBase64url(value: unknown, size: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new EvidenceContractError("projectStateEncodingInvalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== size || decoded.toString("base64url") !== value) {
    throw new EvidenceContractError("projectStateEncodingInvalid");
  }
  return decoded;
}

function requireSafePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw new EvidenceContractError(code);
  }
  return value;
}

function validateProjectStateDocument(value: unknown): ValidatedProjectState {
  const document = record(value, "projectStateFieldsInvalid");
  if (!exactFields(document, PROJECT_STATE_FIELDS)) {
    throw new EvidenceContractError("projectStateFieldsInvalid");
  }
  if (document.schemaVersion !== "sentinel-project-state-v1") {
    throw new EvidenceContractError("projectStateSchemaVersionInvalid");
  }
  if (document.stateVersion !== "state-v1") {
    throw new EvidenceContractError("projectStateVersionInvalid");
  }
  requireSafePositiveInteger(document.keyEpoch, "keyEpochInvalid");
  const projectIdentifier = decodeBase64url(document.projectIdentifier, 16);
  const fingerprintHmacKey = decodeBase64url(document.fingerprintHmacKey, 32);
  const cleanupLeaseKey = decodeBase64url(document.cleanupLeaseKey, 32);
  if (timingSafeEqual(fingerprintHmacKey, cleanupLeaseKey)) {
    throw new EvidenceContractError("projectStateKeysNotSeparated");
  }
  return {
    document: document as unknown as ProjectStateDocument,
    cleanupLeaseKey,
    fingerprintHmacKey,
    projectIdentifier,
  };
}

export function validateProjectStateFile(payload: Buffer): ValidatedProjectState {
  return validateProjectStateDocument(parseCanonicalJsonFile(payload));
}

export function buildProjectStateFile(document: ProjectStateDocument): Buffer {
  const state = validateProjectStateDocument(document);
  return Buffer.concat([canonicalJsonBytes(state.document), Buffer.from("\n")]);
}

function requireProjectState(value: ProjectStateInput): ValidatedProjectState {
  const candidate = record(value, "projectStateFieldsInvalid");
  const document = "document" in candidate ? candidate.document : value;
  return validateProjectStateDocument(document);
}

export function projectStateHmac(value: ProjectStateInput): string {
  const state = requireProjectState(value);
  return createHmac("sha256", state.cleanupLeaseKey)
    .update(PROJECT_STATE_DOMAIN)
    .update(state.projectIdentifier)
    .digest("hex");
}

function recordHmac(
  cleanupKey: Buffer,
  keyDomain: Buffer,
  macDomain: Buffer,
  body: Record<string, unknown>,
): string {
  if (!Buffer.isBuffer(cleanupKey) || cleanupKey.length !== 32) {
    throw new EvidenceContractError("cleanupLeaseKeyInvalid");
  }
  const derivedKey = createHmac("sha256", cleanupKey).update(keyDomain).digest();
  return createHmac("sha256", derivedKey).update(macDomain).update(canonicalJsonBytes(body)).digest("hex");
}

function parseUint64(value: unknown, code: string, allowZero = false): bigint {
  const pattern = allowZero ? NONNEGATIVE_DECIMAL : POSITIVE_UINT64;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new EvidenceContractError(code);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) throw new EvidenceContractError(code);
  return parsed;
}

export function buildCommitSequenceFile(lastAllocated: string, cleanupKey: Buffer): Buffer {
  parseUint64(lastAllocated, "commitSequenceInvalid");
  const body = { lastAllocated, version: "commit-sequence-v1" };
  const document = {
    hmacSha256: recordHmac(cleanupKey, SEQUENCE_KEY_DOMAIN, SEQUENCE_MAC_DOMAIN, body),
    ...body,
  };
  return Buffer.concat([canonicalJsonBytes(document), Buffer.from("\n")]);
}

export function validateCommitSequenceFile(payload: Buffer, cleanupKey: Buffer): bigint {
  const document = record(parseCanonicalJsonFile(payload), "commitSequenceFieldsInvalid");
  if (!exactFields(document, ["hmacSha256", "lastAllocated", "version"])) {
    throw new EvidenceContractError("commitSequenceFieldsInvalid");
  }
  if (document.version !== "commit-sequence-v1") {
    throw new EvidenceContractError("commitSequenceVersionInvalid");
  }
  const parsed = parseUint64(document.lastAllocated, "commitSequenceInvalid");
  requireHex(document.hmacSha256, "commitSequenceHmacInvalid");
  const body = { lastAllocated: document.lastAllocated, version: document.version };
  const expected = recordHmac(cleanupKey, SEQUENCE_KEY_DOMAIN, SEQUENCE_MAC_DOMAIN, body);
  if (!safeHexEqual(document.hmacSha256 as string, expected)) {
    throw new EvidenceContractError("commitSequenceHmacMismatch");
  }
  return parsed;
}

function sequenceValues(values: unknown, allowZero: boolean, code: string): readonly bigint[] {
  if (!Array.isArray(values)) throw new EvidenceContractError(code);
  return values.map((value) => parseUint64(value, code, allowZero));
}

function maximumSequence(values: readonly bigint[]): bigint {
  let maximum = 0n;
  for (const value of values) if (value > maximum) maximum = value;
  return maximum;
}

export function validateCommitSequenceState(
  sequencePayload: Buffer | null,
  cleanupKey: Buffer,
  completedSequences: unknown,
  retentionHighWaters: unknown,
): bigint {
  const completed = sequenceValues(completedSequences, false, "evidenceCommitSequenceInvalid");
  if (new Set(completed).size !== completed.length) throw new EvidenceContractError("commitSequenceDuplicate");
  const retention = sequenceValues(retentionHighWaters, true, "retentionHighWaterInvalid");
  const floor = maximumSequence([...completed, ...retention]);
  if (sequencePayload === null) {
    if (floor > 0n) throw new EvidenceContractError("commitSequenceMissing");
    return 0n;
  }
  const current = validateCommitSequenceFile(sequencePayload, cleanupKey);
  if (current < floor) throw new EvidenceContractError("commitSequenceRollback");
  return current;
}

function requireHex(value: unknown, code: string): string {
  if (typeof value !== "string" || !HEX_256.test(value)) throw new EvidenceContractError(code);
  return value;
}

function safeHexEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new EvidenceContractError(code);
  return value;
}

function validateSourceRun(body: Record<string, unknown>): void {
  if (body.observationSource === "fresh") {
    if (body.sourceRunId !== null) throw new EvidenceContractError("sourceRunIdInvalid");
    return;
  }
  requireUuid(body.sourceRunId, "sourceRunIdInvalid");
  if (body.sourceRunId === body.runId) throw new EvidenceContractError("sourceRunIdInvalid");
}

function requireEvidenceSchemaVersion(body: Record<string, unknown>): void {
  if (body.schemaVersion !== "sentinel-evidence-v1") throw new EvidenceContractError("evidenceSchemaVersionInvalid");
}

function requireSpecVersion(body: Record<string, unknown>): void {
  if (typeof body.specVersion !== "string" || !SEMVER.test(body.specVersion)) throw new EvidenceContractError("specVersionInvalid");
}

function requireFingerprintVersion(body: Record<string, unknown>): void {
  if (body.fingerprintVersion !== "sentinel-fingerprint-v1") throw new EvidenceContractError("fingerprintVersionInvalid");
}

function validateEvidenceVersions(body: Record<string, unknown>): void {
  requireEvidenceSchemaVersion(body);
  requireSpecVersion(body);
  requireFingerprintVersion(body);
}

function validateEvidenceRouting(body: Record<string, unknown>): void {
  requireUuid(body.runId, "runIdInvalid");
  requireUuid(body.correlationId, "correlationIdInvalid");
  if (!new Set(["crap", "mutation", "check"]).has(body.command as string)) throw new EvidenceContractError("commandInvalid");
  if (!new Set(["python", "typescript", "go", "java", "clojure"]).has(body.language as string)) throw new EvidenceContractError("languageInvalid");
}

function requireEvidenceMode(body: Record<string, unknown>): void {
  if (body.mode !== "strict" && body.mode !== "local") throw new EvidenceContractError("modeInvalid");
}

function requireObservationSource(body: Record<string, unknown>): void {
  if (body.observationSource !== "fresh" && body.observationSource !== "cache") throw new EvidenceContractError("observationSourceInvalid");
}

function requireStrictFreshObservation(body: Record<string, unknown>): void {
  if (body.mode === "strict" && body.observationSource === "cache") throw new EvidenceContractError("strictCacheInvalid");
}

function validateEvidenceObservation(body: Record<string, unknown>): void {
  requireEvidenceMode(body);
  requireObservationSource(body);
}

function validateEvidenceAuthentication(body: Record<string, unknown>): void {
  parseUint64(body.commitSequence, "commitSequenceInvalid");
  requireSafePositiveInteger(body.keyEpoch, "keyEpochInvalid");
  requireHex(body.projectStateHmac, "projectStateHmacInvalid");
  requireHex(body.startedSha256, "startedSha256Invalid");
}

function validateEvidenceIdentity(body: Record<string, unknown>): void {
  validateEvidenceVersions(body);
  validateEvidenceRouting(body);
  validateEvidenceObservation(body);
  validateEvidenceAuthentication(body);
  validateSourceRun(body);
  requireStrictFreshObservation(body);
}

function timestampKey(value: unknown): readonly [number, number] {
  if (typeof value !== "string") throw new EvidenceContractError("utcTimestampInvalid");
  const match = UTC.exec(value);
  if (match === null || match[7]?.endsWith("0")) throw new EvidenceContractError("utcTimestampInvalid");
  const fields = match.slice(1, 7).map(Number);
  if (fields[0] === 0) throw new EvidenceContractError("utcTimestampInvalid");
  const instant = new Date(0);
  instant.setUTCFullYear(fields[0]!, fields[1]! - 1, fields[2]!);
  instant.setUTCHours(fields[3]!, fields[4]!, fields[5]!, 0);
  const milliseconds = instant.getTime();
  const canonical = instant.toISOString().slice(0, 19);
  if (canonical !== value.slice(0, 19)) throw new EvidenceContractError("utcTimestampInvalid");
  return [milliseconds, Number((match[7] ?? "0").padEnd(9, "0"))];
}

function compareTimestamp(left: readonly [number, number], right: readonly [number, number]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] - right[1];
}

function validateEvidenceTimes(body: Record<string, unknown>): void {
  const started = timestampKey(body.startedAtUtc);
  const completed = timestampKey(body.completedAtUtc);
  const committed = timestampKey(body.committedAtUtc);
  if (compareTimestamp(started, completed) > 0 || compareTimestamp(completed, committed) > 0) {
    throw new EvidenceContractError("evidenceTimeOrderInvalid");
  }
}

function decimalText(value: unknown, allowZero: boolean, maxLength: number, code: string): bigint {
  const pattern = allowZero ? NONNEGATIVE_DECIMAL : POSITIVE_UINT64;
  if (typeof value !== "string" || value.length > maxLength || !pattern.test(value)) {
    throw new EvidenceContractError(code);
  }
  return BigInt(value);
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function requireCrapShape(value: unknown): Record<string, unknown> {
  const component = record(value, "crapComponentInvalid");
  if (!exactFields(component, CRAP_FIELDS) || typeof component.pass !== "boolean") {
    throw new EvidenceContractError("crapComponentInvalid");
  }
  return component;
}

function requireReducedFraction(numerator: bigint, denominator: bigint): void {
  if (greatestCommonDivisor(numerator, denominator) !== 1n) {
    throw new EvidenceContractError("crapComponentFractionInvalid");
  }
}

function requireCrapPass(component: Record<string, unknown>, expected: boolean): boolean {
  if (component.pass !== expected) throw new EvidenceContractError("crapComponentSemanticsInvalid");
  return component.pass as boolean;
}

function requireCrapInventory(
  component: Record<string, unknown>,
  numerator: bigint,
  denominator: bigint,
): readonly [number, number] {
  const callableCount = requireSafeCount(component.callableCount, "crapComponentInvalid");
  const unknownCount = requireSafeCount(component.unknownCount, "crapComponentInvalid");
  if (unknownCount > callableCount) throw new EvidenceContractError("crapComponentInvalid");
  const hasNoKnownCallable = callableCount === unknownCount;
  const hasZeroMaximum = numerator === 0n && denominator === 1n;
  if (hasNoKnownCallable !== hasZeroMaximum) {
    throw new EvidenceContractError("crapComponentInventoryInvalid");
  }
  return [callableCount, unknownCount];
}

function validateCrapComponent(value: unknown): boolean {
  const component = requireCrapShape(value);
  const numerator = decimalText(component.maxNumerator, true, 96, "crapComponentInvalid");
  const denominator = decimalText(component.maxDenominator, false, 48, "crapComponentInvalid");
  requireReducedFraction(numerator, denominator);
  const [callableCount, unknownCount] = requireCrapInventory(component, numerator, denominator);
  const crapMax = threshold(component.crapMax, parseCrapMax, "crapComponentInvalid");
  const expected = callableCount > 0 && unknownCount === 0 && crapPasses(numerator, denominator, crapMax);
  return requireCrapPass(component, expected);
}

function validateMutationCounts(component: Record<string, unknown>): number {
  let total = 0;
  for (const state of MUTATION_STATES) {
    const value = component[state];
    if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
      throw new EvidenceContractError("mutationComponentInvalid");
    }
    total += value;
  }
  return total;
}

function threshold(value: unknown, parser: (text: unknown) => Threshold, code: string): Threshold {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof GateInputError) throw new EvidenceContractError(code);
    throw error;
  }
}

// At the default 100 percent this is exactly killed === inScope with every other state at zero.
function mutationPassExpected(
  component: Record<string, unknown>,
  inScope: number,
  unauthorized: number,
): boolean {
  const mutationMin = threshold(component.mutationMin, parseMutationMin, "mutationComponentInvalid");
  return inScope > 0 && unauthorized === 0 && killRatePasses(component.killed as number, inScope, mutationMin);
}

function validateMutationComponent(value: unknown): boolean {
  const component = record(value, "mutationComponentInvalid");
  if (!exactFields(component, MUTATION_FIELDS) || typeof component.pass !== "boolean") {
    throw new EvidenceContractError("mutationComponentInvalid");
  }
  const total = validateMutationCounts(component);
  const inScope = requireSafeCount(component.inScope, "mutationComponentInvalid");
  const unauthorized = requireSafeCount(component.unauthorizedExclusion, "mutationComponentInvalid");
  if (total !== inScope) throw new EvidenceContractError("mutationComponentInvalid");
  const expected = mutationPassExpected(component, inScope, unauthorized);
  if (component.pass !== expected) throw new EvidenceContractError("mutationComponentSemanticsInvalid");
  return component.pass;
}

function requireSafeCount(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new EvidenceContractError(code);
  }
  return value;
}

function validateComponents(command: unknown, value: unknown): boolean {
  const components = record(value, "evidenceComponentsInvalid");
  const required = command === "check" ? ["crap", "mutation"] : [String(command)];
  if (!exactFields(components, required)) throw new EvidenceContractError("evidenceComponentsInvalid");
  const results: boolean[] = [];
  if ("crap" in components) results.push(validateCrapComponent(components.crap));
  if ("mutation" in components) results.push(validateMutationComponent(components.mutation));
  return results.every(Boolean);
}

function terminalStatus(body: Record<string, unknown>): string {
  if (typeof body.terminalStatus !== "string") {
    throw new EvidenceContractError("terminalStatusExitCodeMismatch");
  }
  const expectedExit = TERMINAL_EXIT[body.terminalStatus];
  if (expectedExit === undefined || body.exitCode !== expectedExit) {
    throw new EvidenceContractError("terminalStatusExitCodeMismatch");
  }
  return body.terminalStatus;
}

function passedStatusMatches(status: string, componentsPass: boolean): boolean {
  return status !== "passed" || componentsPass;
}

function qualityFailedStatusMatches(status: string, componentsPass: boolean): boolean {
  return status !== "qualityFailed" || !componentsPass;
}

function validateTerminalComponents(status: string, componentsPass: boolean): void {
  if (!passedStatusMatches(status, componentsPass)) throw new EvidenceContractError("terminalComponentMismatch");
  if (!qualityFailedStatusMatches(status, componentsPass)) throw new EvidenceContractError("terminalComponentMismatch");
}

function validateTerminalPrecedence(body: Record<string, unknown>, status: string): void {
  const components = body.components as Record<string, Record<string, unknown>>;
  const mutation = components.mutation;
  if (mutation !== undefined && (mutation.toolError as number) > 0 && status !== "backendError") {
    throw new EvidenceContractError("terminalStatusPrecedenceInvalid");
  }
}

function expectedCertification(body: Record<string, unknown>, status: string, componentsPass: boolean): boolean {
  return body.mode === "strict" && body.observationSource === "fresh" && status === "passed" && componentsPass;
}

function validateCertification(body: Record<string, unknown>, expected: boolean): void {
  if (typeof body.certification !== "boolean" || body.certification !== expected) {
    throw new EvidenceContractError("certificationInvalid");
  }
}

function validateTerminal(body: Record<string, unknown>, componentsPass: boolean): void {
  const status = terminalStatus(body);
  validateTerminalPrecedence(body, status);
  validateTerminalComponents(status, componentsPass);
  validateCertification(body, expectedCertification(body, status, componentsPass));
}

function manifestFilename(value: unknown): string {
  const entry = record(value, "eventManifestInvalid");
  if (!exactFields(entry, ["filename", "sha256"])) throw new EvidenceContractError("eventManifestInvalid");
  if (typeof entry.filename !== "string" || !EVENT_FILENAME.test(entry.filename)) {
    throw new EvidenceContractError("eventManifestFilenameInvalid");
  }
  requireHex(entry.sha256, "eventManifestDigestInvalid");
  return entry.filename;
}

function manifestNames(body: Record<string, unknown>): readonly string[] {
  const count = requireSafeCount(body.eventCount, "eventManifestInvalid");
  if (!Array.isArray(body.events)) throw new EvidenceContractError("eventManifestInvalid");
  if (count !== body.events.length) throw new EvidenceContractError("eventManifestCountMismatch");
  return body.events.map(manifestFilename);
}

function requireUniqueManifest(names: readonly string[]): void {
  if (new Set(names).size !== names.length) throw new EvidenceContractError("eventManifestDuplicate");
}

function requireManifestOrdinals(names: readonly string[]): void {
  const expected = names.map((_, index) => `${(index + 1).toString(16).padStart(32, "0")}.json`);
  if (names.some((name, index) => name !== expected[index])) throw new EvidenceContractError("eventManifestOrdinalInvalid");
}

function requireFreshManifest(body: Record<string, unknown>, names: readonly string[]): void {
  if (body.observationSource === "cache" && names.length > 0) throw new EvidenceContractError("cacheObservationHasEvents");
}

function validateManifest(body: Record<string, unknown>): void {
  const names = manifestNames(body);
  requireUniqueManifest(names);
  requireManifestOrdinals(names);
  requireFreshManifest(body, names);
}

function validateDiagnostics(value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !SAFE_CODE.test(item))) {
    throw new EvidenceContractError("diagnosticCodesInvalid");
  }
  const sorted = [...value].sort(compareUtf8);
  if (new Set(value).size !== value.length || value.some((item, index) => item !== sorted[index])) {
    throw new EvidenceContractError("diagnosticCodesInvalid");
  }
}

function validateProjectBinding(
  body: Record<string, unknown>,
  state: ValidatedProjectState,
  allowHistoricalEpoch: boolean,
): void {
  const evidenceEpoch = body.keyEpoch as number;
  const currentEpoch = state.document.keyEpoch;
  if (evidenceEpoch > currentEpoch || (!allowHistoricalEpoch && evidenceEpoch !== currentEpoch)) {
    throw new EvidenceContractError("keyEpochInvalid");
  }
  if (!safeHexEqual(body.projectStateHmac as string, projectStateHmac(state))) {
    throw new EvidenceContractError("projectStateBindingInvalid");
  }
}

function validateEvidenceBody(
  value: unknown,
  state: ValidatedProjectState,
  allowHistoricalEpoch: boolean,
): Record<string, unknown> {
  const body = record(value, "evidenceFieldsInvalid");
  if (!exactFields(body, EVIDENCE_BODY_FIELDS)) throw new EvidenceContractError("evidenceFieldsInvalid");
  validateEvidenceIdentity(body);
  validateEvidenceTimes(body);
  const componentsPass = validateComponents(body.command, body.components);
  validateTerminal(body, componentsPass);
  validateManifest(body);
  validateDiagnostics(body.diagnosticCodes);
  validateProjectBinding(body, state, allowHistoricalEpoch);
  return body;
}

export function buildEvidenceFile(body: Record<string, unknown>, stateInput: ProjectStateInput): Buffer {
  const state = requireProjectState(stateInput);
  const validated = validateEvidenceBody(body, state, false);
  const hmacSha256 = recordHmac(
    state.cleanupLeaseKey,
    EVIDENCE_KEY_DOMAIN,
    EVIDENCE_MAC_DOMAIN,
    validated,
  );
  return Buffer.concat([canonicalJsonBytes({ ...validated, hmacSha256 }), Buffer.from("\n")]);
}

export function validateEvidenceFile(payload: Buffer, stateInput: ProjectStateInput): Record<string, unknown> {
  const document = record(parseCanonicalJsonFile(payload), "evidenceFieldsInvalid");
  const state = requireProjectState(stateInput);
  if (!exactFields(document, [...EVIDENCE_BODY_FIELDS, "hmacSha256"])) {
    throw new EvidenceContractError("evidenceFieldsInvalid");
  }
  requireHex(document.hmacSha256, "evidenceHmacInvalid");
  const body = Object.fromEntries(Object.entries(document).filter(([name]) => name !== "hmacSha256"));
  const expected = recordHmac(state.cleanupLeaseKey, EVIDENCE_KEY_DOMAIN, EVIDENCE_MAC_DOMAIN, body);
  if (!safeHexEqual(document.hmacSha256 as string, expected)) {
    throw new EvidenceContractError("evidenceHmacMismatch");
  }
  validateEvidenceBody(body, state, true);
  return document;
}

export function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}
