import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as ts from "@typescript/old";

import {
  UnicodeScalarError,
  PathTextError,
  assertCanonicalModulePath,
  assertUnicodeScalarSequence,
  digestSource,
  utf8ByteOffset,
} from "./source-text.js";

export type CallableSyntaxKind =
  | "function"
  | "asyncFunction"
  | "method"
  | "getter"
  | "setter"
  | "constructor"
  | "functionExpression"
  | "arrowFunction";

export type CallableKind = CallableSyntaxKind | "tsxCallback";

export interface SourceRange {
  readonly startByte: number;
  readonly endByte: number;
}

export interface CallableRecord {
  readonly callableId: string;
  readonly kind: CallableKind;
  readonly syntaxKind: CallableSyntaxKind;
  readonly modulePath: string;
  readonly sourceDigest: string;
  readonly qualifiedName: string;
  readonly signature: string;
  readonly sourceRange: SourceRange;
  readonly bodyRange: SourceRange;
  readonly complexity: number;
}

export interface CrapValue {
  readonly numerator: string;
  readonly denominator: string;
  readonly decimal: string;
  readonly pass: boolean;
}

type SupportedCallable =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

type ContainerKind = "class" | "object" | null;

interface WalkContext {
  readonly semanticOwners: readonly string[];
  readonly displayOwners: readonly string[];
  readonly enclosingCallableName: string | null;
  readonly containerKind: ContainerKind;
}

interface CallableIdentity {
  readonly kind: CallableKind;
  readonly syntaxKind: CallableSyntaxKind;
  readonly qualifiedName: string;
  readonly signature: string;
  readonly descriptor: string;
  readonly semanticOwner: string;
}

export class SourceAnalysisError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SourceAnalysisError";
    this.code = code;
  }
}

export class CallableIdentityError extends SourceAnalysisError {
  public constructor(code: string, message: string) {
    super(code, message);
    this.name = "CallableIdentityError";
  }
}

export class CrapInputError extends TypeError {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "CrapInputError";
    this.code = code;
  }
}

const EXPECTED_TYPESCRIPT_AST_VERSION = "6.0.3";
const EXPECTED_TYPESCRIPT_AST_SHA256 = "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39";
let typeScriptAstIdentityVerified = false;

function loadedTypeScriptAstDigest(): string {
  try {
    const implementationPath = createRequire(import.meta.url).resolve("@typescript/old");
    return createHash("sha256").update(readFileSync(implementationPath)).digest("hex");
  } catch {
    throw new SourceAnalysisError(
      "typescriptAstIdentityMismatch",
      "the installed TypeScript AST implementation cannot be authenticated",
    );
  }
}

function assertTypeScriptAstIdentity(): void {
  if (typeScriptAstIdentityVerified) return;
  if (
    ts.version !== EXPECTED_TYPESCRIPT_AST_VERSION ||
    loadedTypeScriptAstDigest() !== EXPECTED_TYPESCRIPT_AST_SHA256
  ) {
    // RISK(breaking): a consumer override now fails instead of silently changing callable identities.
    throw new SourceAnalysisError(
      "typescriptAstIdentityMismatch",
      "the installed TypeScript AST implementation does not match the pinned artifact",
    );
  }
  typeScriptAstIdentityVerified = true;
}

function isSupportedCallable(node: ts.Node): node is SupportedCallable {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isClassNode(node: ts.Node): node is ts.ClassDeclaration | ts.ClassExpression {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

function normalizeModulePath(modulePath: string): string {
  try {
    assertCanonicalModulePath(modulePath);
  } catch (error) {
    if (error instanceof UnicodeScalarError || error instanceof PathTextError) {
      throw new SourceAnalysisError("invalidModulePath", `invalid module path ${JSON.stringify(modulePath)}: ${error.message}`);
    }
    throw error;
  }
  return modulePath;
}

function validateSource(source: string): void {
  try {
    assertUnicodeScalarSequence(source);
  } catch (error) {
    if (error instanceof UnicodeScalarError) {
      throw new SourceAnalysisError("invalidUnicodeScalar", error.message);
    }
    throw error;
  }
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile, source: string): SourceRange {
  const start = node.getStart(sourceFile, false);
  const end = node.getEnd();
  if (start < 0 || end < start || end > source.length) {
    throw new SourceAnalysisError("invalidSourceRange", `invalid TypeScript node range: ${start}..${end}`);
  }
  return { startByte: utf8ByteOffset(source, start), endByte: utf8ByteOffset(source, end) };
}

function bodyOf(node: SupportedCallable): ts.ConciseBody | ts.Block | null {
  return node.body ?? null;
}

function modifiersOf(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(node).some((modifier) => modifier.kind === kind);
}

interface CharacterSpan {
  readonly start: number;
  readonly end: number;
}

function callableBodySpans(node: ts.Node, sourceFile: ts.SourceFile): readonly CharacterSpan[] {
  const spans: CharacterSpan[] = [];
  const visit = (current: ts.Node): void => {
    if (isSupportedCallable(current)) {
      const body = bodyOf(current);
      if (body !== null) spans.push({ start: body.getStart(sourceFile, false), end: body.getEnd() });
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return spans.sort((left, right) => left.start - right.start);
}

function bodyIndependentText(node: ts.Node, sourceFile: ts.SourceFile): string {
  const start = node.getStart(sourceFile, false);
  const end = node.getEnd();
  const pieces: string[] = [];
  let cursor = start;
  for (const span of callableBodySpans(node, sourceFile)) {
    pieces.push(sourceFile.text.slice(cursor, span.start), "__SENTINEL_CALLABLE_BODY__");
    cursor = span.end;
  }
  pieces.push(sourceFile.text.slice(cursor, end));
  return pieces.join("");
}

function canonicalTokens(node: ts.Node | undefined, sourceFile: ts.SourceFile): string {
  if (node === undefined) return "";
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    bodyIndependentText(node, sourceFile),
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(`${token}:${scanner.getTokenText()}`);
  }
  return tokens.join("|");
}

function canonicalDisplay(node: ts.Node | undefined, sourceFile: ts.SourceFile): string {
  if (node === undefined) return "";
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    node.getText(sourceFile),
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  return tokens.join("");
}

function signatureOf(node: SupportedCallable, sourceFile: ts.SourceFile): string {
  const parameters = node.parameters.map((parameter) => canonicalTokens(parameter, sourceFile)).join(",");
  const typeParameters = node.typeParameters?.map((parameter) => canonicalTokens(parameter, sourceFile)).join(",") ?? "";
  const returnType = "type" in node ? canonicalTokens(node.type, sourceFile) : "";
  const asyncMarker = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? "async" : "sync";
  const generatorMarker = "asteriskToken" in node && node.asteriskToken !== undefined ? "generator" : "plain";
  return `${asyncMarker}|${generatorMarker}|<${typeParameters}>|(${parameters})|${returnType}`;
}

function isTransparentExpressionWrapper(parent: ts.Node, child: ts.Node): boolean {
  return (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isPartiallyEmittedExpression(parent)) &&
    parent.expression === child
  );
}

interface ExpressionSite {
  readonly display: string;
  readonly semantic: string;
}

function nodeSite(node: ts.Node, sourceFile: ts.SourceFile): ExpressionSite {
  return { display: canonicalDisplay(node, sourceFile), semantic: canonicalTokens(node, sourceFile) };
}

function ifControlRole(current: ts.Node, child: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (!ts.isIfStatement(current)) return null;
  let branch = "condition";
  if (child === current.thenStatement) branch = "then";
  if (child === current.elseStatement) branch = "else";
  return `if:${branch}:${canonicalTokens(current.expression, sourceFile)}`;
}

function caseControlRole(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isCaseClause(current)) return `case:${canonicalTokens(current.expression, sourceFile)}`;
  if (ts.isDefaultClause(current)) return "case:default";
  return null;
}

function forControlRole(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isForStatement(current)) {
    return `for:${canonicalTokens(current.initializer, sourceFile)}:${canonicalTokens(current.condition, sourceFile)}:${canonicalTokens(current.incrementor, sourceFile)}`;
  }
  if (ts.isForInStatement(current)) {
    return `for-in:${canonicalTokens(current.initializer, sourceFile)}:${canonicalTokens(current.expression, sourceFile)}`;
  }
  if (ts.isForOfStatement(current)) {
    return `for-of:${canonicalTokens(current.initializer, sourceFile)}:${canonicalTokens(current.expression, sourceFile)}`;
  }
  return null;
}

function whileControlRole(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isWhileStatement(current)) return `while:${canonicalTokens(current.expression, sourceFile)}`;
  if (ts.isDoStatement(current)) return `do:${canonicalTokens(current.expression, sourceFile)}`;
  return null;
}

function controlRoleAt(current: ts.Node, child: ts.Node, sourceFile: ts.SourceFile): string | null {
  return (
    ifControlRole(current, child, sourceFile) ??
    caseControlRole(current, sourceFile) ??
    forControlRole(current, sourceFile) ??
    whileControlRole(current, sourceFile)
  );
}

function enclosingControlRole(node: ts.Node, sourceFile: ts.SourceFile): string {
  let child = node;
  for (let current = node.parent; current !== undefined; child = current, current = current.parent) {
    if (isSupportedCallable(current)) return "unscoped";
    const role = controlRoleAt(current, child, sourceFile);
    if (role !== null) return role;
  }
  return "unscoped";
}

function unwrapExpression(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined && isTransparentExpressionWrapper(current.parent, current)) {
    current = current.parent;
  }
  return current;
}

function declarationExpressionSite(parent: ts.Node, sourceFile: ts.SourceFile): ExpressionSite | null {
  if (ts.isVariableDeclaration(parent)) {
    return nodeSite(parent.name, sourceFile);
  }
  if (ts.isPropertyDeclaration(parent)) {
    const receiver = hasModifier(parent, ts.SyntaxKind.StaticKeyword) ? "static" : "instance";
    const site = nodeSite(parent.name, sourceFile);
    return { display: site.display, semantic: `${receiver}:${site.semantic}` };
  }
  if (ts.isPropertyAssignment(parent)) return nodeSite(parent.name, sourceFile);
  return null;
}

function isStableJsxKeyExpression(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function jsxKeyInitializerSite(
  initializer: ts.JsxAttributeValue | undefined,
  sourceFile: ts.SourceFile,
): ExpressionSite | null {
  if (initializer === undefined) return null;
  if (ts.isStringLiteral(initializer)) return nodeSite(initializer, sourceFile);
  if (!ts.isJsxExpression(initializer)) return null;
  const expression = initializer.expression;
  if (expression === undefined) return null;
  return isStableJsxKeyExpression(expression) ? nodeSite(expression, sourceFile) : null;
}

function stableJsxKeySite(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): ExpressionSite | null {
  for (const property of node.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    if (canonicalDisplay(property.name, sourceFile) !== "key") continue;
    return jsxKeyInitializerSite(property.initializer, sourceFile);
  }
  return null;
}

function jsxOpeningSite(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): ExpressionSite {
  const tag = nodeSite(node.tagName, sourceFile);
  const key = stableJsxKeySite(node, sourceFile);
  if (key === null) return tag;
  return {
    display: `${tag.display}#key:${key.display}`,
    semantic: `${tag.semantic}:key:${key.semantic}`,
  };
}

function jsxContainerSite(current: ts.Node, child: ts.Node, sourceFile: ts.SourceFile): ExpressionSite | null {
  if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) {
    return jsxOpeningSite(current, sourceFile);
  }
  if (ts.isJsxElement(current) && current.openingElement !== child) {
    return jsxOpeningSite(current.openingElement, sourceFile);
  }
  if (ts.isJsxFragment(current)) return { display: "fragment", semantic: "fragment" };
  return null;
}

function jsxElementPath(node: ts.Node, sourceFile: ts.SourceFile): ExpressionSite {
  const sites: ExpressionSite[] = [];
  let child = node;
  for (let current = node.parent; current !== undefined; child = current, current = current.parent) {
    if (isSupportedCallable(current)) break;
    const site = jsxContainerSite(current, child, sourceFile);
    if (site !== null) sites.push(site);
  }
  const display = sites[0]?.display ?? "unknown";
  const semantic = sites.reverse().map((site) => site.semantic).join("/");
  return { display, semantic: semantic.length === 0 ? "unknown" : semantic };
}

function jsxOuterBindingSite(node: ts.Node, sourceFile: ts.SourceFile): ExpressionSite | null {
  let child = node;
  for (let current = node.parent; current !== undefined; child = current, current = current.parent) {
    if (isSupportedCallable(current)) return null;
    const declaration = declarationOuterSite(child, current, sourceFile);
    if (declaration !== null) return declaration;
    const assignment = assignmentOuterSite(child, current, sourceFile);
    if (assignment !== null) return assignment;
  }
  return null;
}

function jsxExpressionSite(parent: ts.Node, sourceFile: ts.SourceFile): ExpressionSite | null {
  if (!ts.isJsxExpression(parent)) return null;
  const element = jsxElementPath(parent, sourceFile);
  const outer = jsxOuterBindingSite(parent, sourceFile);
  const outerDisplay = outer === null ? "" : `@${outer.display}`;
  const outerSemantic = outer?.semantic ?? "none";
  if (parent.parent !== undefined && ts.isJsxAttribute(parent.parent)) {
    const attribute = nodeSite(parent.parent.name, sourceFile);
    return {
      display: `${attribute.display}${outerDisplay}`,
      semantic: `outer:${outerSemantic}:element:${element.semantic}:attribute:${attribute.semantic}`,
    };
  }
  return {
    display: `children${outerDisplay}`,
    semantic: `outer:${outerSemantic}:element:${element.semantic}:children`,
  };
}

function declarationOuterSite(
  current: ts.Node,
  parent: ts.Node,
  sourceFile: ts.SourceFile,
): ExpressionSite | null {
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    parent.initializer === current
  ) {
    return declarationExpressionSite(parent, sourceFile);
  }
  return null;
}

function assignmentOuterSite(
  current: ts.Node,
  parent: ts.Node,
  sourceFile: ts.SourceFile,
): ExpressionSite | null {
  if (ts.isBinaryExpression(parent) && parent.right === current) return nodeSite(parent.left, sourceFile);
  if (ts.isExportAssignment(parent) && parent.expression === current) {
    return { display: "default", semantic: "default" };
  }
  return null;
}

function assignedOuterSite(current: ts.Node, parent: ts.Node, sourceFile: ts.SourceFile): ExpressionSite | null {
  const declaration = declarationOuterSite(current, parent, sourceFile);
  if (declaration !== null) return declaration;
  const assignment = assignmentOuterSite(current, parent, sourceFile);
  if (assignment !== null) return assignment;
  return jsxExpressionSite(parent, sourceFile);
}

function outerExpressionSite(node: ts.Node, sourceFile: ts.SourceFile): ExpressionSite | null {
  let child = node;
  for (let current = node.parent; current !== undefined; child = current, current = current.parent) {
    if (isSupportedCallable(current)) return null;
    const site = assignedOuterSite(child, current, sourceFile);
    if (site !== null) return site;
  }
  return null;
}

function callExpressionSite(
  current: ts.Node,
  parent: ts.Node,
  sourceFile: ts.SourceFile,
): ExpressionSite | null {
  if (!ts.isCallExpression(parent)) return null;
  const argumentIndex = parent.arguments.indexOf(current as ts.Expression);
  const controlRole = enclosingControlRole(parent, sourceFile);
  const outerSite = outerExpressionSite(parent, sourceFile);
  const outerDisplay = outerSite === null ? "" : `@${outerSite.display}`;
  const outerSemantic = outerSite?.semantic ?? "none";
  return {
    display: `${canonicalDisplay(parent.expression, sourceFile)}#arg${argumentIndex}${outerDisplay}`,
    semantic: `${calleeSemantic(parent.expression, sourceFile)}#arg${argumentIndex}#within:${controlRole}#outer:${outerSemantic}`,
  };
}

function calleeSemantic(node: ts.Expression, sourceFile: ts.SourceFile): string {
  return canonicalTokens(node, sourceFile);
}

function conditionalExpressionSite(
  current: ts.Node,
  parent: ts.Node,
  sourceFile: ts.SourceFile,
): ExpressionSite | null {
  if (!ts.isConditionalExpression(parent)) return null;
  const arm = current === parent.whenTrue ? "true" : (current === parent.whenFalse ? "false" : null);
  if (arm === null) return null;
  const outer = outerExpressionSite(parent, sourceFile);
  const suffix = outer === null ? "" : `@${outer.display}`;
  return {
    display: `conditional:${arm}${suffix}`,
    semantic: `conditional:${arm}:condition:${canonicalTokens(parent.condition, sourceFile)}:outer:${outer?.semantic ?? "none"}`,
  };
}

function returnExpressionSite(
  current: ts.Node,
  parent: ts.Node,
  sourceFile: ts.SourceFile,
): ExpressionSite | null {
  if (!ts.isReturnStatement(parent) || parent.expression !== current) return null;
  const role = enclosingControlRole(parent, sourceFile);
  return { display: `return:${role}`, semantic: `return:${role}` };
}

function assignmentExpressionSite(current: ts.Node, parent: ts.Node, sourceFile: ts.SourceFile): ExpressionSite | null {
  if (ts.isBinaryExpression(parent) && parent.right === current) return nodeSite(parent.left, sourceFile);
  if (ts.isExportAssignment(parent)) return { display: "default", semantic: "default" };
  return null;
}

function expressionSite(node: ts.Node, sourceFile: ts.SourceFile): ExpressionSite {
  const current = unwrapExpression(node);
  const parent = current.parent;
  if (parent === undefined) return { display: "anonymous", semantic: "anonymous" };
  const sites = [
    declarationExpressionSite(parent, sourceFile),
    jsxExpressionSite(parent, sourceFile),
    conditionalExpressionSite(current, parent, sourceFile),
    callExpressionSite(current, parent, sourceFile),
    assignmentExpressionSite(current, parent, sourceFile),
    returnExpressionSite(current, parent, sourceFile),
  ];
  return sites.find((site) => site !== null) ?? { display: "anonymous", semantic: "anonymous" };
}

function isTsxCallback(node: ts.FunctionExpression | ts.ArrowFunction): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isJsxExpression(current)) return true;
    if (isSupportedCallable(current)) return false;
  }
  return false;
}

function displayPrefix(context: WalkContext): string {
  if (context.enclosingCallableName !== null) return context.enclosingCallableName;
  return context.displayOwners.join(".");
}

interface IdentityParts {
  readonly kind: CallableKind;
  readonly syntaxKind: CallableSyntaxKind;
  readonly localName: string;
  readonly semanticName: string;
  readonly receiver: string;
}

function functionIdentityParts(node: ts.FunctionDeclaration, context: WalkContext): IdentityParts {
  if (node.name === undefined) {
    if (!hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
      throw new CallableIdentityError("anonymousDeclaration", "function declaration has no stable semantic name");
    }
    const syntaxKind = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? "asyncFunction" : "function";
    return {
      kind: syntaxKind,
      syntaxKind,
      localName: "<default-function>",
      semanticName: "default-export",
      receiver: "none",
    };
  }
  const syntaxKind = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? "asyncFunction" : "function";
  const semanticName = node.name.text;
  const localName = context.enclosingCallableName === null ? semanticName : `<locals>.${semanticName}`;
  return { kind: syntaxKind, syntaxKind, localName, semanticName, receiver: "none" };
}

function memberReceiver(node: ts.Node, context: WalkContext): string {
  if (context.containerKind === "class") {
    if (hasModifier(node, ts.SyntaxKind.StaticKeyword)) return "static";
    return "instance";
  }
  if (context.containerKind === "object") return "object";
  return "none";
}

function memberIdentityParts(
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  syntaxKind: "method" | "getter" | "setter",
  suffix: string,
  sourceFile: ts.SourceFile,
  context: WalkContext,
): IdentityParts {
  const receiver = memberReceiver(node, context);
  const semanticName = canonicalTokens(node.name, sourceFile);
  const staticPrefix = receiver === "static" ? "<static>." : "";
  const localName = `${staticPrefix}${canonicalDisplay(node.name, sourceFile)}${suffix}`;
  return { kind: syntaxKind, syntaxKind, localName, semanticName, receiver };
}

function constructorIdentityParts(): IdentityParts {
  return {
    kind: "constructor",
    syntaxKind: "constructor",
    localName: "constructor",
    semanticName: "constructor",
    receiver: "instance",
  };
}

function anonymousSyntaxKind(node: ts.FunctionExpression | ts.ArrowFunction): CallableSyntaxKind {
  return ts.isFunctionExpression(node) ? "functionExpression" : "arrowFunction";
}

function anonymousKind(node: ts.FunctionExpression | ts.ArrowFunction, callback: boolean): CallableKind {
  if (callback) return "tsxCallback";
  return anonymousSyntaxKind(node);
}

function anonymousSemanticName(
  node: ts.FunctionExpression | ts.ArrowFunction,
  site: ExpressionSite,
  sourceFile: ts.SourceFile,
): string {
  if (!ts.isFunctionExpression(node) || node.name === undefined) return site.semantic;
  return `name:${canonicalTokens(node.name, sourceFile)}:site:${site.semantic}`;
}

function anonymousDisplayName(
  node: ts.FunctionExpression | ts.ArrowFunction,
  site: ExpressionSite,
): string {
  if (!ts.isFunctionExpression(node) || node.name === undefined) return site.display;
  if (site.display === "anonymous") return node.name.text;
  return `${site.display}/${node.name.text}`;
}

function anonymousLabel(node: ts.FunctionExpression | ts.ArrowFunction, callback: boolean): string {
  if (callback) return "callback";
  return ts.isFunctionExpression(node) ? "function" : "arrow";
}

function anonymousReceiver(
  node: ts.FunctionExpression | ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  context: WalkContext,
): string {
  if (context.containerKind === "object") return "object";
  if (context.containerKind !== "class") return "none";
  const property = outerExpressionSite(node, sourceFile);
  if (property?.semantic.startsWith("static:") === true) return "static";
  return property === null ? "none" : "instance";
}

function receiverDisplayPrefix(receiver: string): string {
  return receiver === "static" ? "<static>." : "";
}

function anonymousIdentityParts(
  node: ts.FunctionExpression | ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  context: WalkContext,
): IdentityParts {
  const syntaxKind = anonymousSyntaxKind(node);
  const site = expressionSite(node, sourceFile);
  const callback = isTsxCallback(node);
  const kind = anonymousKind(node, callback);
  const semanticName = anonymousSemanticName(node, site, sourceFile);
  const displayName = anonymousDisplayName(node, site);
  const label = anonymousLabel(node, callback);
  const receiver = anonymousReceiver(node, sourceFile, context);
  const prefix = receiverDisplayPrefix(receiver);
  return { kind, syntaxKind, localName: `${prefix}<${label}:${displayName}>`, semanticName, receiver };
}

function finishCallableIdentity(
  parts: IdentityParts,
  node: SupportedCallable,
  sourceFile: ts.SourceFile,
  context: WalkContext,
): CallableIdentity {
  const prefix = displayPrefix(context);
  const qualifiedName = prefix.length === 0 ? parts.localName : `${prefix}.${parts.localName}`;
  const signature = signatureOf(node, sourceFile);
  const descriptor = JSON.stringify({
    // RISK(breaking): v3 records the body-independent semantic-site rules introduced here.
    version: "typescript-callable-v3",
    owners: context.semanticOwners,
    receiver: parts.receiver,
    kind: parts.kind,
    syntaxKind: parts.syntaxKind,
    semanticName: parts.semanticName,
    signature,
  });
  return {
    kind: parts.kind,
    syntaxKind: parts.syntaxKind,
    qualifiedName,
    signature,
    descriptor,
    semanticOwner: `callable:${createHash("sha256").update(descriptor, "utf8").digest("hex")}`,
  };
}

function callableIdentity(
  node: SupportedCallable,
  sourceFile: ts.SourceFile,
  context: WalkContext,
): CallableIdentity {
  if (ts.isFunctionDeclaration(node)) {
    return finishCallableIdentity(functionIdentityParts(node, context), node, sourceFile, context);
  }
  if (ts.isMethodDeclaration(node)) {
    return finishCallableIdentity(memberIdentityParts(node, "method", "", sourceFile, context), node, sourceFile, context);
  }
  if (ts.isGetAccessorDeclaration(node)) {
    return finishCallableIdentity(memberIdentityParts(node, "getter", "#get", sourceFile, context), node, sourceFile, context);
  }
  if (ts.isSetAccessorDeclaration(node)) {
    return finishCallableIdentity(memberIdentityParts(node, "setter", "#set", sourceFile, context), node, sourceFile, context);
  }
  if (ts.isConstructorDeclaration(node)) {
    return finishCallableIdentity(constructorIdentityParts(), node, sourceFile, context);
  }
  return finishCallableIdentity(anonymousIdentityParts(node, sourceFile, context), node, sourceFile, context);
}

const decisionNodeKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
]);

const logicalDecisionKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function isDecisionNode(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) return logicalDecisionKinds.has(node.operatorToken.kind);
  return decisionNodeKinds.has(node.kind);
}

function visitClassHeritageRuntime(
  node: ts.ClassDeclaration | ts.ClassExpression,
  visit: (node: ts.Node) => void,
): void {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) visit(type.expression);
  }
}

function visitDecoratorsRuntime(node: ts.Node, visit: (node: ts.Node) => void): void {
  for (const decorator of decoratorsOf(node)) visit(decorator.expression);
}

function visitParameterDecoratorsRuntime(node: ts.ClassElement, visit: (node: ts.Node) => void): void {
  if (!isSupportedCallable(node)) return;
  for (const parameter of node.parameters) visitDecoratorsRuntime(parameter, visit);
}

function visitClassMemberRuntime(node: ts.ClassElement, visit: (node: ts.Node) => void): void {
  visitDecoratorsRuntime(node, visit);
  visitParameterDecoratorsRuntime(node, visit);
  if ("name" in node && node.name !== undefined && ts.isComputedPropertyName(node.name)) {
    visit(node.name.expression);
  }
  if (ts.isClassStaticBlockDeclaration(node)) {
    visit(node);
  } else if (
    ts.isPropertyDeclaration(node) &&
    hasModifier(node, ts.SyntaxKind.StaticKeyword) &&
    node.initializer !== undefined
  ) {
    visit(node.initializer);
  }
}

function visitClassRuntime(node: ts.ClassDeclaration | ts.ClassExpression, visit: (node: ts.Node) => void): void {
  visitDecoratorsRuntime(node, visit);
  visitClassHeritageRuntime(node, visit);
  for (const member of node.members) {
    visitClassMemberRuntime(member, visit);
  }
}

function countRuntimeDecisions(roots: readonly ts.Node[]): number {
  let count = 0;

  const visit = (node: ts.Node): void => {
    if (isSupportedCallable(node)) return;
    if (isClassNode(node)) {
      visitClassRuntime(node, visit);
      return;
    }
    if (isDecisionNode(node)) count += 1;
    ts.forEachChild(node, visit);
  };

  for (const root of roots) visit(root);
  return count;
}

function instanceFieldInitializers(node: ts.ClassDeclaration | ts.ClassExpression): readonly ts.Expression[] {
  return node.members.flatMap((member) => (
    ts.isPropertyDeclaration(member) &&
    !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
    member.initializer !== undefined
      ? [member.initializer]
      : []
  ));
}

function parameterInitializers(root: SupportedCallable): readonly ts.Expression[] {
  return root.parameters.flatMap((parameter) => parameter.initializer === undefined ? [] : [parameter.initializer]);
}

function constructorFieldInitializers(root: SupportedCallable): readonly ts.Expression[] {
  if (!ts.isConstructorDeclaration(root) || !isClassNode(root.parent)) return [];
  return instanceFieldInitializers(root.parent);
}

function decisionCount(root: SupportedCallable): number {
  const body = bodyOf(root);
  if (body === null) return 0;
  return countRuntimeDecisions([
    ...parameterInitializers(root),
    ...constructorFieldInitializers(root),
    body,
  ]);
}

function assertClassRuntimeDecisionOwner(node: ts.ClassDeclaration | ts.ClassExpression): void {
  const hasConstructor = node.members.some(
    (member) => ts.isConstructorDeclaration(member) && member.body !== undefined,
  );
  if (hasConstructor || countRuntimeDecisions(instanceFieldInitializers(node)) === 0) return;
  throw new SourceAnalysisError(
    "runtimeDecisionOwnerMissing",
    "a decision-bearing instance field requires an explicit constructor",
  );
}

function classContext(
  node: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile,
  context: WalkContext,
): WalkContext {
  const site = expressionSite(node, sourceFile);
  const declaredName = node.name?.text ?? "";
  const className = declaredName.length > 0
    ? declaredName
    : (site.display === "anonymous" ? "<anonymous-class>" : site.display);
  const displayOwners = context.enclosingCallableName === null
    ? [...context.displayOwners, className]
    : [context.enclosingCallableName, "<class>", className];
  return {
    semanticOwners: [...context.semanticOwners, `class:${className}:binding:${site.semantic}`],
    displayOwners,
    enclosingCallableName: null,
    containerKind: "class",
  };
}

function objectContext(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile, context: WalkContext): WalkContext {
  const site = expressionSite(node, sourceFile);
  const displayOwners = context.enclosingCallableName === null
    ? [...context.displayOwners, site.display]
    : [context.enclosingCallableName, "<object>", site.display];
  return {
    semanticOwners: [...context.semanticOwners, `object:${site.semantic}`],
    displayOwners,
    enclosingCallableName: null,
    containerKind: "object",
  };
}

function namespaceContext(node: ts.ModuleDeclaration, sourceFile: ts.SourceFile, context: WalkContext): WalkContext {
  const name = canonicalDisplay(node.name, sourceFile);
  return {
    semanticOwners: [...context.semanticOwners, `namespace:${canonicalTokens(node.name, sourceFile)}`],
    displayOwners: [...context.displayOwners, name],
    enclosingCallableName: context.enclosingCallableName,
    containerKind: null,
  };
}

export function analyzeTypeScript(source: string, rawModulePath: string): readonly CallableRecord[] {
  assertTypeScriptAstIdentity();
  validateSource(source);
  const modulePath = normalizeModulePath(rawModulePath);
  const sourceDigest = digestSource(source);
  const scriptKind = modulePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(parseDiagnostics[0]?.messageText ?? "parse error", " ");
    throw new SourceAnalysisError("syntaxError", message);
  }

  const rows: CallableRecord[] = [];
  const descriptors = new Set<string>();

  const visit = (node: ts.Node, context: WalkContext): void => {
    if (ts.isModuleDeclaration(node)) {
      const nextContext = namespaceContext(node, sourceFile, context);
      if (node.body !== undefined) visit(node.body, nextContext);
      return;
    }
    if (isClassNode(node)) {
      assertClassRuntimeDecisionOwner(node);
      const nextContext = classContext(node, sourceFile, context);
      ts.forEachChild(node, (child) => visit(child, nextContext));
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const nextContext = objectContext(node, sourceFile, context);
      ts.forEachChild(node, (child) => visit(child, nextContext));
      return;
    }
    if (isSupportedCallable(node)) {
      const body = bodyOf(node);
      if (body === null) return;
      const identity = callableIdentity(node, sourceFile, context);
      const fullDescriptor = JSON.stringify({ modulePath, semanticSite: JSON.parse(identity.descriptor) as unknown });
      if (descriptors.has(fullDescriptor)) {
        throw new CallableIdentityError(
          "identityAmbiguous",
          `duplicate callable descriptor: ${identity.qualifiedName}`,
        );
      }
      descriptors.add(fullDescriptor);
      rows.push({
        callableId: `ts-v3:${createHash("sha256").update(fullDescriptor, "utf8").digest("hex")}`,
        kind: identity.kind,
        syntaxKind: identity.syntaxKind,
        modulePath,
        sourceDigest,
        qualifiedName: identity.qualifiedName,
        signature: identity.signature,
        sourceRange: rangeOf(node, sourceFile, source),
        bodyRange: rangeOf(body, sourceFile, source),
        complexity: 1 + decisionCount(node),
      });
      const nestedContext: WalkContext = {
        semanticOwners: [...context.semanticOwners, identity.semanticOwner],
        displayOwners: context.displayOwners,
        enclosingCallableName: identity.qualifiedName,
        containerKind: null,
      };
      ts.forEachChild(node, (child) => visit(child, nestedContext));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, context));
  };

  visit(sourceFile, {
    semanticOwners: [],
    displayOwners: [],
    enclosingCallableName: null,
    containerKind: null,
  });
  return rows.sort((left, right) => left.sourceRange.startByte - right.sourceRange.startByte);
}

function requireSafeInteger(
  fieldName: string,
  label: string,
  value: unknown,
  minimum: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new CrapInputError(`${fieldName}NotInteger`, `${label} must be an integer`);
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new CrapInputError(
      `${fieldName}OutOfRange`,
      `${label} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function renderCanonicalDecimal(numerator: bigint, denominator: bigint): string {
  if (numerator < 0n || denominator <= 0n) {
    throw new TypeError("canonical decimal requires a nonnegative numerator and positive denominator");
  }
  const scale = 1_000_000_000_000n;
  const scaled = numerator * scale;
  let [rounded, remainder] = [scaled / denominator, scaled % denominator];
  const doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && rounded % 2n === 1n)) {
    rounded += 1n;
  }
  const whole = rounded / scale;
  const fractional = (rounded % scale).toString().padStart(12, "0").replace(/0+$/u, "");
  return fractional.length === 0 ? whole.toString() : `${whole}.${fractional}`;
}

export function computeCrap(complexity: unknown, covered: unknown, total: unknown): CrapValue {
  requireSafeInteger("cyclomaticComplexity", "complexity", complexity, 1);
  requireSafeInteger("coveredUnits", "covered units", covered, 0);
  requireSafeInteger("totalUnits", "total units", total, 1);
  if (covered > total) {
    throw new CrapInputError(
      "coveredUnitsExceedTotalUnits",
      "covered units must not exceed total units",
    );
  }

  const cc = BigInt(complexity);
  const coveredUnits = BigInt(covered);
  const totalUnits = BigInt(total);
  const denominator = totalUnits ** 3n;
  const uncoveredUnits = totalUnits - coveredUnits;
  const numerator = cc ** 2n * uncoveredUnits ** 3n + cc * denominator;
  const divisor = greatestCommonDivisor(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;

  return {
    numerator: reducedNumerator.toString(),
    denominator: reducedDenominator.toString(),
    decimal: renderCanonicalDecimal(reducedNumerator, reducedDenominator),
    pass: numerator <= 8n * denominator,
  };
}
