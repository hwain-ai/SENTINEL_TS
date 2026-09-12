import * as ts from "@typescript/old";

import { MutationProtocolError } from "./mutation/protocol.js";

function duplicateObjectKey(node: ts.ObjectLiteralExpression): string | null {
  const keys = new Set<string>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.name)) {
      throw new MutationProtocolError("projectConfigInvalid", "project config contains invalid JSON syntax");
    }
    const key = property.name.text;
    if (keys.has(key)) return key;
    keys.add(key);
    const nested = duplicateJsonKey(property.initializer);
    if (nested !== null) return nested;
  }
  return null;
}

function duplicateArrayKey(node: ts.ArrayLiteralExpression): string | null {
  for (const element of node.elements) {
    const nested = duplicateJsonKey(element);
    if (nested !== null) return nested;
  }
  return null;
}

function duplicateJsonKey(node: ts.Node): string | null {
  if (ts.isObjectLiteralExpression(node)) return duplicateObjectKey(node);
  if (ts.isArrayLiteralExpression(node)) return duplicateArrayKey(node);
  return null;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new MutationProtocolError("projectConfigInvalid", `project config cannot be parsed: ${String(error)}`);
  }
}

export function parseProjectConfigJson(text: string): unknown {
  const document = parseJsonText(text);
  const sourceFile = ts.parseJsonText("sentinel.config.json", text);
  const statement = sourceFile.statements[0];
  if (
    sourceFile.statements.length !== 1 ||
    statement === undefined ||
    !ts.isExpressionStatement(statement)
  ) {
    throw new MutationProtocolError("projectConfigInvalid", "project config contains invalid JSON syntax");
  }
  const duplicate = duplicateJsonKey(statement.expression);
  if (duplicate !== null) {
    throw new MutationProtocolError("projectConfigDuplicateKey", `project config contains duplicate key: ${duplicate}`);
  }
  return document;
}
