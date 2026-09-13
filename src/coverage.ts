import path from "node:path";

import {
  CallableIdentityError,
  type CallableRecord,
  computeCrap,
  type CrapValue,
  renderCanonicalDecimal,
  type SourceRange,
} from "./crap.js";
import { DEFAULT_GATE, crapPasses, type Threshold } from "./gate.js";
import {
  UnicodeScalarError,
  PathTextError,
  assertCanonicalModulePath,
  assertUnicodeScalarSequence,
  assertValidPathText,
  digestSource,
  isUnicodeScalarBoundary,
  utf8ByteOffset,
} from "./source-text.js";

export interface StatementHit {
  readonly id: string;
  readonly range: SourceRange;
  readonly count: number;
}

export interface FunctionHit {
  readonly id: string;
  readonly name: string;
  readonly declarationRange: SourceRange;
  readonly range: SourceRange;
  readonly count: number;
}

const V8_OMITTED_FUNCTION = Symbol("v8-omitted-function");
type InternalFunctionHit = FunctionHit & { readonly [V8_OMITTED_FUNCTION]?: true };

export interface CoverageFileRecord {
  readonly modulePath: string;
  readonly source: string;
  readonly sourceDigest: string;
  readonly statements: readonly StatementHit[];
  readonly functions: readonly FunctionHit[];
}

export interface CallableMetric extends CallableRecord {
  readonly coverage: { readonly covered: number; readonly total: number } | null;
  readonly crap: CrapValue | null;
  readonly unknownReason: "coverageFileMissing" | "coverageUnitsMissing" | null;
}

type JsonObject = Record<string, unknown>;

export class CoverageFormatError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "CoverageFormatError";
    this.code = code;
  }
}

function requireObject(value: unknown, code: string, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoverageFormatError(code, `${label} must be an object`);
  }
  return value as JsonObject;
}

function normalizeModulePath(value: string): string {
  try {
    assertCanonicalModulePath(value);
  } catch (error) {
    if (error instanceof UnicodeScalarError || error instanceof PathTextError) {
      throw new CoverageFormatError("invalidModulePath", `invalid module path ${JSON.stringify(value)}: ${error.message}`);
    }
    throw error;
  }
  return value;
}

function validateCoveragePathText(value: string): void {
  try {
    assertValidPathText(value);
  } catch (error) {
    if (error instanceof UnicodeScalarError || error instanceof PathTextError) {
      throw new CoverageFormatError("invalidModulePath", `invalid coverage path ${JSON.stringify(value)}: ${error.message}`);
    }
    throw error;
  }
}

function normalizeCoveragePath(value: string, projectRoot: string): string {
  validateCoveragePathText(value);
  validateCoveragePathText(projectRoot);
  if (!path.isAbsolute(projectRoot)) {
    throw new CoverageFormatError("invalidProjectRoot", `project root must be absolute: ${projectRoot}`);
  }
  const absoluteRoot = path.resolve(projectRoot);
  if (path.isAbsolute(value)) {
    const relative = path.relative(absoluteRoot, path.resolve(value));
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new CoverageFormatError("coveragePathOutsideProject", `coverage path is outside the project: ${value}`);
    }
    return relative.split(path.sep).join("/");
  }
  return normalizeModulePath(value);
}

interface LineIndex {
  readonly text: readonly string[];
  readonly byteStarts: readonly number[];
}

function validateCoverageSource(source: string): void {
  try {
    assertUnicodeScalarSequence(source);
  } catch (error) {
    if (error instanceof UnicodeScalarError) {
      throw new CoverageFormatError("invalidUnicodeScalar", error.message);
    }
    throw error;
  }
}

function lineTerminatorWidth(source: string, index: number): number {
  const code = source.charCodeAt(index);
  if (code === 0x0d) return source.charCodeAt(index + 1) === 0x0a ? 2 : 1;
  return code === 0x0a || code === 0x2028 || code === 0x2029 ? 1 : 0;
}

function buildLineIndex(source: string): LineIndex {
  const text: string[] = [];
  const byteStarts: number[] = [];
  let lineStart = 0;
  let lineStartByte = 0;
  let index = 0;
  while (index < source.length) {
    const width = lineTerminatorWidth(source, index);
    if (width === 0) {
      index += 1;
      continue;
    }
    byteStarts.push(lineStartByte);
    text.push(source.slice(lineStart, index));
    const nextLineStart = index + width;
    lineStartByte += Buffer.byteLength(source.slice(lineStart, nextLineStart), "utf8");
    lineStart = nextLineStart;
    index = nextLineStart;
  }
  byteStarts.push(lineStartByte);
  text.push(source.slice(lineStart));
  return { text, byteStarts };
}

function requireLine(value: unknown, lines: LineIndex, code: string, label: string): number {
  const line = value;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || line > lines.text.length) {
    throw new CoverageFormatError(code, `${label}.line must identify a source line`);
  }
  return line;
}

function resolveColumn(value: unknown, lineText: string, allowLineEnd: boolean, code: string, label: string): number {
  if (value === null) {
    if (!allowLineEnd) throw new CoverageFormatError(code, `${label}.column cannot use the end-of-line marker`);
    return lineText.length;
  }
  if (typeof value !== "number") throw new CoverageFormatError(code, `${label}.column must be an integer`);
  if (!Number.isSafeInteger(value)) throw new CoverageFormatError(code, `${label}.column must be an integer`);
  if (value < 0 || value > lineText.length || !isUnicodeScalarBoundary(lineText, value)) {
    throw new CoverageFormatError(code, `${label}.column must identify a Unicode scalar boundary on the line`);
  }
  return value;
}

function requireLocationPoint(
  value: unknown,
  label: string,
  lines: LineIndex,
  code: string,
  allowLineEnd: boolean,
): SourceRange["startByte"] {
  const point = requireObject(value, code, label);
  const line = requireLine(point.line, lines, code, label);
  const lineText = lines.text[line - 1] ?? "";
  const resolvedColumn = resolveColumn(point.column, lineText, allowLineEnd, code, label);
  return (lines.byteStarts[line - 1] ?? 0) + utf8ByteOffset(lineText, resolvedColumn);
}

function parseLocation(value: unknown, lines: LineIndex, code: string, label: string): SourceRange {
  const location = requireObject(value, code, label);
  const startByte = requireLocationPoint(location.start, `${label} start`, lines, code, false);
  const endByte = requireLocationPoint(location.end, `${label} end`, lines, code, true);
  if (endByte <= startByte) {
    throw new CoverageFormatError(code, `${label} must be a nonempty half-open source range`);
  }
  return { startByte, endByte };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactKeys(object: JsonObject): readonly string[] {
  return Object.keys(object).sort(compareUtf8);
}

function requireExactIdSet(left: JsonObject, right: JsonObject, code: string, label: string): readonly string[] {
  const leftIds = exactKeys(left);
  const rightIds = exactKeys(right);
  if (leftIds.length !== rightIds.length || leftIds.some((id, index) => id !== rightIds[index])) {
    throw new CoverageFormatError(code, `${label} must have identical IDs`);
  }
  return leftIds;
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CoverageFormatError("invalidCoverageCount", `${label} count must be a nonnegative safe integer`);
  }
  return value;
}

function compareRangeAndId(
  left: { readonly range: SourceRange; readonly id: string },
  right: { readonly range: SourceRange; readonly id: string },
): number {
  return (
    left.range.startByte - right.range.startByte ||
    left.range.endByte - right.range.endByte ||
    compareUtf8(left.id, right.id)
  );
}

function parseCoverageEntry(
  entry: JsonObject,
  modulePath: string,
  source: string,
  lines: LineIndex,
): CoverageFileRecord {
  const statementMap = requireObject(entry.statementMap, "invalidCoverageFile", "statementMap");
  const statementCounts = requireObject(entry.s, "invalidCoverageFile", "statement counts");
  const statementIds = requireExactIdSet(
    statementMap,
    statementCounts,
    "statementSetMismatch",
    "statementMap and statement counts",
  );
  const fnMap = requireObject(entry.fnMap, "invalidCoverageFile", "fnMap");
  const functionCounts = requireObject(entry.f, "invalidCoverageFile", "function counts");
  const functionIds = requireExactIdSet(fnMap, functionCounts, "functionSetMismatch", "fnMap and function counts");

  const statements = statementIds.map((id): StatementHit => ({
    id,
    range: parseLocation(statementMap[id], lines, "invalidStatementLocation", `statement ${id}`),
    count: requireCount(statementCounts[id], `statement ${id}`),
  }));
  const functions = functionIds.map((id): FunctionHit => {
    const rawFunction = requireObject(fnMap[id], "invalidFunctionLocation", `function ${id}`);
    if (typeof rawFunction.name !== "string") {
      throw new CoverageFormatError("invalidFunctionLocation", `function ${id} name must be a string`);
    }
    if (
      typeof rawFunction.line !== "number" ||
      !Number.isSafeInteger(rawFunction.line) ||
      rawFunction.line < 1 ||
      rawFunction.line > lines.text.length
    ) {
      throw new CoverageFormatError("invalidFunctionLocation", `function ${id} line must identify a source line`);
    }
    return {
      id,
      name: rawFunction.name,
      declarationRange: parseLocation(rawFunction.decl, lines, "invalidFunctionLocation", `function ${id} declaration`),
      range: parseLocation(rawFunction.loc, lines, "invalidFunctionLocation", `function ${id} location`),
      count: requireCount(functionCounts[id], `function ${id}`),
    };
  });
  return {
    modulePath,
    source,
    sourceDigest: digestSource(source),
    statements: statements.sort(compareRangeAndId),
    functions: functions.sort(compareRangeAndId),
  };
}

export function parseIstanbulStatements(
  rawDocument: unknown,
  rawModulePath: string,
  projectRoot: string,
  source: string,
): CoverageFileRecord | null {
  validateCoverageSource(source);
  const modulePath = normalizeModulePath(rawModulePath);
  const document = requireObject(rawDocument, "invalidCoverageDocument", "coverage document");
  const normalizedEntries = new Map<string, JsonObject>();

  for (const [rawPath, rawEntry] of Object.entries(document)) {
    const entry = requireObject(rawEntry, "invalidCoverageFile", `coverage entry ${rawPath}`);
    if (typeof entry.path !== "string") {
      throw new CoverageFormatError("invalidCoverageFile", `coverage entry ${rawPath} path must be a string`);
    }
    const keyModulePath = normalizeCoveragePath(rawPath, projectRoot);
    const recordModulePath = normalizeCoveragePath(entry.path, projectRoot);
    if (keyModulePath !== recordModulePath) {
      throw new CoverageFormatError(
        "coveragePathMismatch",
        `coverage key and record path disagree: ${rawPath} != ${entry.path}`,
      );
    }
    if (normalizedEntries.has(keyModulePath)) {
      throw new CoverageFormatError("coveragePathAmbiguous", `multiple coverage entries normalize to ${keyModulePath}`);
    }
    normalizedEntries.set(keyModulePath, entry);
  }

  const entry = normalizedEntries.get(modulePath);
  if (entry === undefined) return null;
  return parseCoverageEntry(entry, modulePath, source, buildLineIndex(source));
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.startByte <= inner.startByte && inner.endByte <= outer.endByte;
}

function rangesEqual(left: SourceRange, right: SourceRange): boolean {
  return left.startByte === right.startByte && left.endByte === right.endByte;
}

function declarationEndsInCallableHeader(functionHit: FunctionHit, callable: CallableRecord): boolean {
  return (
    functionHit.declarationRange.startByte <= callable.bodyRange.startByte &&
    functionHit.declarationRange.endByte > callable.sourceRange.startByte &&
    functionHit.declarationRange.endByte <= callable.bodyRange.startByte
  );
}

function isConciseBodyRange(functionHit: FunctionHit, callable: CallableRecord): boolean {
  const startsAtBody = functionHit.range.startByte === callable.bodyRange.startByte;
  const startsAtParenthesizedValue =
    callable.syntaxKind === "arrowFunction" &&
    functionHit.range.startByte === callable.bodyRange.startByte + 1;
  return (
    (startsAtBody || startsAtParenthesizedValue) &&
    callable.sourceRange.endByte <= functionHit.range.endByte
  );
}

function isVitestTrailingDelimiterRange(functionHit: FunctionHit, callable: CallableRecord): boolean {
  return (
    callable.syntaxKind === "arrowFunction" &&
    functionHit.range.startByte === callable.bodyRange.startByte &&
    functionHit.range.endByte === callable.sourceRange.endByte + 1
  );
}

function sliceUtf8(source: string, startByte: number, endByte: number): string {
  return Buffer.from(source, "utf8").subarray(startByte, endByte).toString("utf8");
}

function isTransparentArrowBodyRange(
  functionHit: FunctionHit,
  callable: CallableRecord,
  source: string,
): boolean {
  if (callable.syntaxKind !== "arrowFunction") return false;
  const { startByte, endByte } = functionHit.range;
  if (startByte < callable.bodyRange.startByte || endByte > callable.sourceRange.endByte) return false;
  const prefix = sliceUtf8(source, callable.bodyRange.startByte, startByte);
  const suffix = sliceUtf8(source, endByte, callable.sourceRange.endByte);
  return /^[\s(]*$/u.test(prefix) && /^[\s)]*$/u.test(suffix);
}

function isTrimmedArrowSourceRange(
  functionHit: FunctionHit,
  callable: CallableRecord,
  source: string,
): boolean {
  if (callable.syntaxKind !== "arrowFunction") return false;
  const { startByte, endByte } = functionHit.range;
  if (startByte < callable.sourceRange.startByte || startByte > callable.bodyRange.startByte) return false;
  if (endByte < callable.bodyRange.endByte || endByte > callable.sourceRange.endByte) return false;
  const prefix = sliceUtf8(source, callable.sourceRange.startByte, startByte);
  const suffix = sliceUtf8(source, endByte, callable.sourceRange.endByte);
  return /^[\s(]*$/u.test(prefix) && /^[\s)]*$/u.test(suffix);
}

function functionMatchesCallable(functionHit: FunctionHit, callable: CallableRecord, source: string): boolean {
  if (rangesEqual(functionHit.range, callable.bodyRange)) return true;
  if (isVitestTrailingDelimiterRange(functionHit, callable)) return true;
  if (isTransparentArrowBodyRange(functionHit, callable, source)) return true;
  if (isTrimmedArrowSourceRange(functionHit, callable, source)) return true;
  if (!declarationEndsInCallableHeader(functionHit, callable)) return false;
  return isConciseBodyRange(functionHit, callable);
}

function validateCoverageIdentity(callables: readonly CallableRecord[], coverageFile: CoverageFileRecord): void {
  if (
    callables.some(
      (callable) =>
        callable.modulePath !== coverageFile.modulePath || callable.sourceDigest !== coverageFile.sourceDigest,
    )
  ) {
    throw new CoverageFormatError(
      "coverageIdentityMismatch",
      "every callable must match the coverage file module path and source digest",
    );
  }
}

function mapFunctions(
  callables: readonly CallableRecord[],
  functions: readonly FunctionHit[],
  statements: readonly StatementHit[],
  source: string,
): ReadonlyMap<string, FunctionHit> {
  const byCallableId = mapExistingFunctions(callables, functions, source);
  requireEveryFunctionMapped(byCallableId, functions);
  supplementOmittedArrows(byCallableId, callables, statements, functions, source);
  return byCallableId;
}

function mapExistingFunctions(
  callables: readonly CallableRecord[],
  functions: readonly FunctionHit[],
  source: string,
): Map<string, FunctionHit> {
  const matchedFunctionIds = new Set<string>();
  const byCallableId = new Map<string, FunctionHit>();
  for (const callable of callables) {
    const candidates = functions.filter((functionHit) => functionMatchesCallable(functionHit, callable, source));
    if (candidates.length > 1 || matchedFunctionIds.has(candidates[0]?.id ?? "")) {
      throw new CoverageFormatError(
        "functionMappingMismatch",
        `callable ${callable.callableId} must map to exactly one unique Istanbul function range`,
      );
    }
    const matched = candidates[0];
    if (matched === undefined) continue;
    matchedFunctionIds.add(matched.id);
    byCallableId.set(callable.callableId, matched);
  }
  return byCallableId;
}

function requireEveryFunctionMapped(
  byCallableId: ReadonlyMap<string, FunctionHit>,
  functions: readonly FunctionHit[],
): void {
  const mappedIds = new Set([...byCallableId.values()].map((functionHit) => functionHit.id));
  if (mappedIds.size !== functions.length) {
    throw new CoverageFormatError(
      "functionMappingMismatch",
      "every Istanbul function range must map to exactly one callable",
    );
  }
}

function supplementOmittedArrows(
  byCallableId: Map<string, FunctionHit>,
  callables: readonly CallableRecord[],
  statements: readonly StatementHit[],
  functions: readonly FunctionHit[],
  source: string,
): void {
  for (const callable of callables) {
    if (byCallableId.has(callable.callableId)) continue;
    const evidence = omittedArrowEvidence(callable, callables, statements, source);
    byCallableId.set(callable.callableId, synthesizeOmittedArrow(callable, evidence, functions));
  }
}

function descendantBodyRanges(
  callable: CallableRecord,
  callables: readonly CallableRecord[],
): readonly SourceRange[] {
  return callables
    .filter(
      (candidate) =>
        candidate.callableId !== callable.callableId && contains(callable.bodyRange, candidate.sourceRange),
    )
    .map((candidate) => candidate.bodyRange);
}

function ownedStatementsForCallable(
  callable: CallableRecord,
  callables: readonly CallableRecord[],
  statements: readonly StatementHit[],
): readonly StatementHit[] {
  const excludedRanges = descendantBodyRanges(callable, callables);
  return statements.filter(
    (statement) =>
      contains(callable.bodyRange, statement.range) &&
      !excludedRanges.some((range) => contains(range, statement.range)),
  );
}

function uniquelyContainingStatement(
  callable: CallableRecord,
  callables: readonly CallableRecord[],
  statements: readonly StatementHit[],
): readonly StatementHit[] {
  const candidates = statements.filter((statement) => contains(statement.range, callable.sourceRange));
  if (candidates.length !== 1) return [];
  const candidate = candidates[0] as StatementHit;
  const containedCallables = callables.filter((item) => contains(candidate.range, item.sourceRange));
  return containedCallables.length === 1 && containedCallables[0]?.callableId === callable.callableId
    ? [candidate]
    : [];
}

function omittedArrowEvidence(
  callable: CallableRecord,
  callables: readonly CallableRecord[],
  statements: readonly StatementHit[],
  source: string,
): readonly StatementHit[] {
  const owned = ownedStatementsForCallable(callable, callables, statements);
  if (owned.length > 0) return owned;
  const bodyOpening = sliceUtf8(source, callable.bodyRange.startByte, callable.bodyRange.startByte + 1);
  return bodyOpening === "{" ? [] : uniquelyContainingStatement(callable, callables, statements);
}

function ownedStatementsForFunction(
  callable: CallableRecord,
  callables: readonly CallableRecord[],
  statements: readonly StatementHit[],
  functionsByCallableId: ReadonlyMap<string, FunctionHit>,
  functionHit: FunctionHit,
  source: string,
): readonly StatementHit[] {
  if ((functionHit as InternalFunctionHit)[V8_OMITTED_FUNCTION] === true) {
    return omittedArrowEvidence(callable, callables, statements, source);
  }
  const descendantRanges = callables
    .filter(
      (candidate) =>
        candidate.callableId !== callable.callableId && contains(callable.bodyRange, candidate.sourceRange),
    )
    .map((candidate) => functionsByCallableId.get(candidate.callableId)?.range);
  return statements.filter(
    (statement) =>
      contains(functionHit.range, statement.range) &&
      !descendantRanges.some((range) => range !== undefined && contains(range, statement.range)),
  );
}

function syntheticFunctionId(callable: CallableRecord): string {
  return `v8-omitted:${callable.callableId}`;
}

function synthesizeOmittedArrow(
  callable: CallableRecord,
  ownedStatements: readonly StatementHit[],
  functions: readonly FunctionHit[],
): InternalFunctionHit {
  const id = syntheticFunctionId(callable);
  if (
    callable.syntaxKind !== "arrowFunction" ||
    ownedStatements.length === 0 ||
    functions.some((functionHit) => functionHit.id === id)
  ) {
    throw new CoverageFormatError(
      "functionMappingMismatch",
      `callable ${callable.callableId} must map to exactly one unique Istanbul function range`,
    );
  }
  return {
    id,
    name: callable.qualifiedName,
    declarationRange: {
      startByte: callable.sourceRange.startByte,
      endByte: callable.bodyRange.startByte,
    },
    range: callable.bodyRange,
    count: ownedStatements.some((statement) => statement.count > 0) ? 1 : 0,
    [V8_OMITTED_FUNCTION]: true,
  };
}

function requireCallableId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new CallableIdentityError("callableIdInvalid", "callable ID must be nonempty UTF-8 text");
  }
  try {
    assertUnicodeScalarSequence(value);
  } catch (error) {
    if (error instanceof UnicodeScalarError) {
      throw new CallableIdentityError("callableIdInvalid", "callable ID must be nonempty UTF-8 text");
    }
    throw error;
  }
}

function parseCanonicalUnsignedInteger(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new CallableIdentityError("crapFractionInvalid", "CRAP integers must use canonical unsigned decimals");
  }
  return BigInt(value);
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

function validateKnownCrap(metric: CallableMetric, crapMax: Threshold): void {
  if (metric.coverage === null || metric.unknownReason !== null || metric.crap === null) {
    throw new CallableIdentityError("crapRowStateInvalid", "known CRAP rows require coverage and no unknown reason");
  }
  const numerator = parseCanonicalUnsignedInteger(metric.crap.numerator);
  const denominator = parseCanonicalUnsignedInteger(metric.crap.denominator);
  if (denominator === 0n || greatestCommonDivisor(numerator, denominator) !== 1n) {
    throw new CallableIdentityError("crapFractionInvalid", "CRAP fractions must be reduced with a positive denominator");
  }
  if (
    metric.crap.decimal !== renderCanonicalDecimal(numerator, denominator) ||
    metric.crap.pass !== crapPasses(numerator, denominator, crapMax)
  ) {
    throw new CallableIdentityError("crapFractionInvalid", "CRAP decimal and gate must match the exact fraction");
  }
}

function validateUnknownCrap(metric: CallableMetric): void {
  const reason = metric.unknownReason;
  if (
    metric.coverage !== null ||
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.includes("\0")
  ) {
    throw new CallableIdentityError("crapRowStateInvalid", "unknown CRAP rows require one valid reason and no coverage");
  }
  try {
    assertUnicodeScalarSequence(reason);
  } catch (error) {
    if (error instanceof UnicodeScalarError) {
      throw new CallableIdentityError("crapRowStateInvalid", "unknown reason must be valid UTF-8 text");
    }
    throw error;
  }
}

function validateMetricForSort(metric: CallableMetric, crapMax: Threshold): void {
  requireCallableId(metric.callableId);
  normalizeModulePath(metric.modulePath);
  if (!Number.isSafeInteger(metric.sourceRange.startByte) || metric.sourceRange.startByte < 0) {
    throw new CallableIdentityError(
      "sourceStartByteInvalid",
      `source start byte must be a nonnegative safe integer: ${metric.sourceRange.startByte}`,
    );
  }
  if (metric.crap === null) validateUnknownCrap(metric);
  else validateKnownCrap(metric, crapMax);
}

function compareKnownCrap(left: CrapValue, right: CrapValue): number {
  const leftScaled = BigInt(left.numerator) * BigInt(right.denominator);
  const rightScaled = BigInt(right.numerator) * BigInt(left.denominator);
  return leftScaled > rightScaled ? -1 : (leftScaled < rightScaled ? 1 : 0);
}

function compareMetrics(left: CallableMetric, right: CallableMetric): number {
  const leftUnknown = left.crap === null;
  const rightUnknown = right.crap === null;
  if (leftUnknown !== rightUnknown) return leftUnknown ? -1 : 1;
  if (left.crap !== null && right.crap !== null) {
    const riskOrder = compareKnownCrap(left.crap, right.crap);
    if (riskOrder !== 0) return riskOrder;
  }
  return (
    compareUtf8(left.modulePath, right.modulePath) ||
    left.sourceRange.startByte - right.sourceRange.startByte ||
    compareUtf8(left.callableId, right.callableId)
  );
}

export function sortCallableMetrics(
  metrics: readonly CallableMetric[],
  crapMax: Threshold = DEFAULT_GATE.crapMax,
): readonly CallableMetric[] {
  for (const metric of metrics) validateMetricForSort(metric, crapMax);
  const sorted = [...metrics].sort(compareMetrics);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && compareMetrics(previous, current) === 0) {
      throw new CallableIdentityError(
        "identityAmbiguous",
        `duplicate final CRAP order key: ${current.callableId}`,
      );
    }
  }
  return sorted;
}

export function attachCoverage(
  callables: readonly CallableRecord[],
  coverageFile: CoverageFileRecord | null,
  crapMax: Threshold = DEFAULT_GATE.crapMax,
): readonly CallableMetric[] {
  if (coverageFile === null) {
    return sortCallableMetrics(callables.map((callable) => ({
      ...callable,
      coverage: null,
      crap: null,
      unknownReason: "coverageFileMissing" as const,
    })));
  }

  validateCoverageIdentity(callables, coverageFile);
  const functionsByCallableId = mapFunctions(
    callables,
    coverageFile.functions,
    coverageFile.statements,
    coverageFile.source,
  );
  const metrics = callables.map((callable): CallableMetric => {
    const functionHit = functionsByCallableId.get(callable.callableId);
    if (functionHit === undefined) {
      throw new CoverageFormatError("functionMappingMismatch", `missing function mapping for ${callable.callableId}`);
    }
    const ownedStatements = ownedStatementsForFunction(
      callable,
      callables,
      coverageFile.statements,
      functionsByCallableId,
      functionHit,
      coverageFile.source,
    );
    if (functionHit.count === 0 && ownedStatements.some((statement) => statement.count > 0)) {
      throw new CoverageFormatError(
        "functionCountMismatch",
        `uncovered function ${functionHit.id} contains a covered statement`,
      );
    }
    if (ownedStatements.length === 0) {
      const covered = functionHit.count > 0 ? 1 : 0;
      return {
        ...callable,
        coverage: { covered, total: 1 },
        crap: computeCrap(callable.complexity, covered, 1, crapMax),
        unknownReason: null,
      };
    }
    const covered = ownedStatements.filter((statement) => statement.count > 0).length;
    const total = ownedStatements.length;
    return {
      ...callable,
      coverage: { covered, total },
      crap: computeCrap(callable.complexity, covered, total, crapMax),
      unknownReason: null,
    };
  });
  return sortCallableMetrics(metrics, crapMax);
}
