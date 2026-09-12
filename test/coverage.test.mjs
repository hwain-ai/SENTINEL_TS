import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as typescriptAst from "@typescript/old";

import {
  CallableIdentityError,
  analyzeTypeScript,
  renderCanonicalDecimal,
} from "../dist/crap.js";
import {
  CoverageFormatError,
  attachCoverage,
  parseIstanbulStatements,
  sortCallableMetrics,
} from "../dist/coverage.js";

const fixtureUrl = new URL("./fixtures/callables.tsx", import.meta.url);
const source = await readFile(fixtureUrl, "utf8");

function statement(line, count) {
  const text = source.split("\n")[line - 1];
  return {
    location: {
      start: { line, column: 0 },
      end: { line, column: text.length },
    },
    count,
  };
}

function lineOf(fragment) {
  const index = source.split("\n").findIndex((line) => line.includes(fragment));
  assert.notEqual(index, -1, `fixture line not found: ${fragment}`);
  return index + 1;
}

function pointAtByte(text, byteOffset) {
  const bytes = Buffer.from(text, "utf8");
  const prefix = bytes.subarray(0, byteOffset).toString("utf8");
  assert.equal(Buffer.byteLength(prefix, "utf8"), byteOffset);
  const pieces = prefix.split("\n");
  return { line: pieces.length, column: pieces.at(-1).length };
}

function locationOfRange(text, range) {
  return {
    start: pointAtByte(text, range.startByte),
    end: pointAtByte(text, range.endByte),
  };
}

function coverageDocument(entries, callables, key = "/project/src/callables.tsx", recordPath = key) {
  const statementMap = {};
  const counts = {};
  entries.forEach((entry, index) => {
    statementMap[String(index)] = entry.location;
    counts[String(index)] = entry.count;
  });
  const fnMap = {};
  const functionCounts = {};
  callables.forEach((callable, index) => {
    const declaration = locationOfRange(source, {
      startByte: callable.sourceRange.startByte,
      endByte: callable.bodyRange.startByte,
    });
    const location = locationOfRange(source, callable.bodyRange);
    fnMap[String(index)] = {
      name: callable.qualifiedName,
      decl: declaration,
      loc: location,
      line: location.start.line,
    };
    functionCounts[String(index)] = 1;
  });
  return {
    [key]: {
      path: recordPath,
      statementMap,
      fnMap,
      branchMap: {},
      s: counts,
      f: functionCounts,
      b: {},
    },
  };
}

test("reads an Istanbul coverage-final top-level map and excludes nested statements", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const document = coverageDocument(
    [
      statement(lineOf("const normalized"), 1),
      statement(lineOf("return normalized"), 0),
      statement(lineOf("const arrow"), 1),
      statement(lineOf("return nested"), 1),
    ],
    callables,
  );
  const coverageFile = parseIstanbulStatements(
    document,
    "src/callables.tsx",
    "/project",
    source,
  );
  const metrics = attachCoverage(callables, coverageFile);
  const byName = new Map(metrics.map((row) => [row.qualifiedName, row]));

  assert.equal(coverageFile.modulePath, "src/callables.tsx");
  assert.match(coverageFile.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(coverageFile.functions.length, callables.length);
  assert.deepEqual(byName.get("Counter.method.<locals>.nested").coverage, {
    covered: 1,
    total: 2,
  });
  assert.deepEqual(byName.get("Counter.method").coverage, { covered: 2, total: 2 });
  assert.equal(byName.get("Counter.method").crap.decimal, "1");
});

test("parses a Vitest 4.1.11 coverage-v8 report with end-of-line columns", async () => {
  const actualSource = await readFile(
    new URL("./fixtures/vitest-range/subject.ts", import.meta.url),
    "utf8",
  );
  const actualDocument = JSON.parse(
    await readFile(new URL("./fixtures/vitest-range/coverage-final.json", import.meta.url), "utf8"),
  );
  const callables = analyzeTypeScript(actualSource, "test/fixtures/vitest-range/subject.ts");
  const coverageFile = parseIstanbulStatements(
    actualDocument,
    "test/fixtures/vitest-range/subject.ts",
    "/project",
    actualSource,
  );
  const metrics = attachCoverage(callables, coverageFile);
  const byName = new Map(metrics.map((row) => [row.qualifiedName, row]));

  assert.equal(coverageFile.functions.length, 3);
  assert.deepEqual(byName.get("<arrow:first>").coverage, { covered: 1, total: 1 });
  assert.deepEqual(byName.get("<arrow:second>").coverage, { covered: 0, total: 1 });
});

test("supplements a V8-omitted callback only from its analyzer-owned statements", async () => {
  const missingSource = await readFile(
    new URL("./fixtures/vitest-missing-fn/subject.ts", import.meta.url),
    "utf8",
  );
  const missingDocument = JSON.parse(
    await readFile(new URL("./fixtures/vitest-missing-fn/coverage-final.json", import.meta.url), "utf8"),
  );
  const modulePath = "test/fixtures/vitest-missing-fn/subject.ts";
  const callables = analyzeTypeScript(missingSource, modulePath);
  const coverageFile = parseIstanbulStatements(missingDocument, modulePath, "/project", missingSource);
  const metrics = attachCoverage(callables, coverageFile);
  const byName = new Map(metrics.map((row) => [row.qualifiedName, row]));

  assert.deepEqual(byName.get("isSourceFile.<arrow:extensions.some#arg0>").coverage, {
    covered: 1,
    total: 1,
  });
});

test("does not invent a missing fnMap entry without an analyzer-owned statement", async () => {
  const missingSource = await readFile(
    new URL("./fixtures/vitest-missing-fn/subject.ts", import.meta.url),
    "utf8",
  );
  const missingDocument = JSON.parse(
    await readFile(new URL("./fixtures/vitest-missing-fn/coverage-final.json", import.meta.url), "utf8"),
  );
  const entry = missingDocument["/project/test/fixtures/vitest-missing-fn/subject.ts"];
  delete entry.statementMap["1"];
  delete entry.s["1"];
  const modulePath = "test/fixtures/vitest-missing-fn/subject.ts";
  const callables = analyzeTypeScript(missingSource, modulePath);
  const coverageFile = parseIstanbulStatements(missingDocument, modulePath, "/project", missingSource);

  assert.throws(
    () => attachCoverage(callables, coverageFile),
    (error) => error?.code === "functionMappingMismatch",
  );
});

test("uses an invoked empty callable as its one exact coverage unit", () => {
  const emptySource = "class Empty { constructor(private value: number) {} }";
  const [callable] = analyzeTypeScript(emptySource, "src/empty.ts");
  const declaration = locationOfRange(emptySource, {
    startByte: callable.sourceRange.startByte,
    endByte: callable.bodyRange.startByte,
  });
  const location = locationOfRange(emptySource, callable.bodyRange);
  const coverageFile = parseIstanbulStatements({
    "/project/src/empty.ts": {
      path: "/project/src/empty.ts",
      statementMap: {},
      fnMap: { 0: { name: "constructor", decl: declaration, loc: location, line: 1 } },
      branchMap: {},
      s: {},
      f: { 0: 1 },
      b: {},
    },
  }, "src/empty.ts", "/project", emptySource);

  const [metric] = attachCoverage([callable], coverageFile);
  assert.deepEqual(metric.coverage, { covered: 1, total: 1 });
  assert.equal(metric.crap.decimal, "1");
});

test("keeps same-line arrows independent through exact fnMap ranges", () => {
  const sameLineSource = "const first = () => 1; const second = () => 2;";
  const callables = analyzeTypeScript(sameLineSource, "src/same-line.ts");
  const fnMap = {};
  const f = {};
  const statementMap = {};
  const s = {};
  callables.forEach((callable, index) => {
    const location = locationOfRange(sameLineSource, {
      startByte: callable.sourceRange.startByte,
      endByte: callable.bodyRange.startByte,
    });
    const bodyLocation = locationOfRange(sameLineSource, callable.bodyRange);
    fnMap[String(index)] = { name: callable.qualifiedName, decl: location, loc: bodyLocation, line: 1 };
    f[String(index)] = 1;
    statementMap[String(index)] = bodyLocation;
    s[String(index)] = index;
  });
  const document = {
    "/project/src/same-line.ts": {
      path: "/project/src/same-line.ts",
      statementMap,
      fnMap,
      branchMap: {},
      s,
      f,
      b: {},
    },
  };

  const coverageFile = parseIstanbulStatements(document, "src/same-line.ts", "/project", sameLineSource);
  const metrics = attachCoverage(callables, coverageFile);
  const byName = new Map(metrics.map((row) => [row.qualifiedName, row]));

  assert.deepEqual(byName.get("<arrow:first>").coverage, { covered: 0, total: 1 });
  assert.deepEqual(byName.get("<arrow:second>").coverage, { covered: 1, total: 1 });
});

test("accepts Vitest typed-arrow ranges whose declaration ends inside the header", () => {
  const typedSource = "const write = (text: string) => text.length;";
  const [callable] = analyzeTypeScript(typedSource, "src/typed-arrow.ts");
  const body = locationOfRange(typedSource, {
    startByte: callable.bodyRange.startByte,
    endByte: callable.sourceRange.endByte + 1,
  });
  const declaration = locationOfRange(typedSource, {
    startByte: callable.sourceRange.startByte,
    endByte: Buffer.byteLength(typedSource.slice(0, typedSource.indexOf(":")), "utf8"),
  });
  const document = {
    "/project/src/typed-arrow.ts": {
      path: "/project/src/typed-arrow.ts",
      statementMap: { "0": locationOfRange(typedSource, callable.bodyRange) },
      fnMap: { "0": { name: "(anonymous_0)", decl: declaration, loc: body, line: 1 } },
      branchMap: {},
      s: { "0": 1 },
      f: { "0": 1 },
      b: {},
    },
  };

  const coverage = parseIstanbulStatements(document, "src/typed-arrow.ts", "/project", typedSource);
  const [metric] = attachCoverage([callable], coverage);

  assert.deepEqual(metric.coverage, { covered: 1, total: 1 });
});

test("accepts Vitest parenthesized-object arrow ranges at the inner expression", () => {
  const objectSource = "const make = () => ({ value: 1 });";
  const [callable] = analyzeTypeScript(objectSource, "src/object-arrow.ts");
  const innerStart = callable.bodyRange.startByte + 1;
  const document = {
    "/project/src/object-arrow.ts": {
      path: "/project/src/object-arrow.ts",
      statementMap: {
        "0": locationOfRange(objectSource, {
          startByte: innerStart,
          endByte: callable.sourceRange.endByte,
        }),
      },
      fnMap: {
        "0": {
          name: "(anonymous_0)",
          decl: locationOfRange(objectSource, {
            startByte: callable.sourceRange.startByte,
            endByte: callable.bodyRange.startByte,
          }),
          loc: locationOfRange(objectSource, {
            startByte: innerStart,
            endByte: callable.sourceRange.endByte,
          }),
          line: 1,
        },
      },
      branchMap: {},
      s: { "0": 1 },
      f: { "0": 1 },
      b: {},
    },
  };

  const coverage = parseIstanbulStatements(document, "src/object-arrow.ts", "/project", objectSource);
  const [metric] = attachCoverage([callable], coverage);

  assert.deepEqual(metric.coverage, { covered: 1, total: 1 });
});

test("uses an exact callback body when Vitest reports the call-site as its declaration", () => {
  const callbackSource = "const any = [1].some((value) => value > 0);";
  const [callable] = analyzeTypeScript(callbackSource, "src/callback.ts");
  const body = locationOfRange(callbackSource, callable.bodyRange);
  const vitestBody = locationOfRange(callbackSource, {
    startByte: callable.bodyRange.startByte,
    endByte: callable.sourceRange.endByte + 1,
  });
  const callSiteStart = Buffer.byteLength(callbackSource.slice(0, callbackSource.indexOf("some")), "utf8");
  const document = {
    "/project/src/callback.ts": {
      path: "/project/src/callback.ts",
      statementMap: { "0": body },
      fnMap: {
        "0": {
          name: "(anonymous_0)",
          decl: locationOfRange(callbackSource, {
            startByte: callSiteStart,
            endByte: callSiteStart + Buffer.byteLength("some", "utf8"),
          }),
          loc: vitestBody,
          line: 1,
        },
      },
      branchMap: {},
      s: { "0": 1 },
      f: { "0": 1 },
      b: {},
    },
  };

  const coverage = parseIstanbulStatements(document, "src/callback.ts", "/project", callbackSource);
  const [metric] = attachCoverage([callable], coverage);

  assert.deepEqual(metric.coverage, { covered: 1, total: 1 });
});

test("accepts a Vitest callback range that trims only its opening parenthesis", () => {
  const callbackSource = "const all = [1].every((value) => (value ?? 0) > 0);";
  const [callable] = analyzeTypeScript(callbackSource, "src/trimmed-callback.ts");
  const coverageRange = {
    startByte: callable.sourceRange.startByte + 1,
    endByte: callable.sourceRange.endByte,
  };
  const document = {
    "/project/src/trimmed-callback.ts": {
      path: "/project/src/trimmed-callback.ts",
      statementMap: { "0": locationOfRange(callbackSource, callable.bodyRange) },
      fnMap: {
        "0": {
          name: "(anonymous_0)",
          decl: locationOfRange(callbackSource, coverageRange),
          loc: locationOfRange(callbackSource, coverageRange),
          line: 1,
        },
      },
      branchMap: {},
      s: { "0": 1 },
      f: { "0": 1 },
      b: {},
    },
  };

  const coverage = parseIstanbulStatements(
    document,
    "src/trimmed-callback.ts",
    "/project",
    callbackSource,
  );
  const [metric] = attachCoverage([callable], coverage);

  assert.deepEqual(metric.coverage, { covered: 1, total: 1 });
});

test("returns coverage unknown when the exact module entry is absent", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const coverageFile = parseIstanbulStatements(
    coverageDocument([], [], "/project/src/other.ts"),
    "src/callables.tsx",
    "/project",
    source,
  );
  const metrics = attachCoverage(callables, coverageFile);

  assert.equal(coverageFile, null);
  assert.ok(metrics.every((row) => row.coverage === null && row.unknownReason === "coverageFileMissing"));
});

test("rejects record-path disagreement and duplicate normalized coverage paths", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const mismatchedPath = coverageDocument([], callables, "/project/src/callables.tsx", "/project/src/other.ts");
  assert.throws(
    () => parseIstanbulStatements(mismatchedPath, "src/callables.tsx", "/project", source),
    (error) => error instanceof CoverageFormatError && error.code === "coveragePathMismatch",
  );

  const duplicate = coverageDocument([], callables);
  duplicate["src/callables.tsx"] = duplicate["/project/src/callables.tsx"];
  assert.throws(
    () => parseIstanbulStatements(duplicate, "src/callables.tsx", "/project", source),
    (error) => error instanceof CoverageFormatError && error.code === "coveragePathAmbiguous",
  );
});

test("validates exact statement and function ID sets", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const statementMismatch = coverageDocument([statement(lineOf("return normalized"), 1)], callables);
  delete statementMismatch["/project/src/callables.tsx"].s["0"];
  assert.throws(
    () => parseIstanbulStatements(statementMismatch, "src/callables.tsx", "/project", source),
    (error) => error instanceof CoverageFormatError && error.code === "statementSetMismatch",
  );

  const functionMismatch = coverageDocument([], callables);
  delete functionMismatch["/project/src/callables.tsx"].f["0"];
  assert.throws(
    () => parseIstanbulStatements(functionMismatch, "src/callables.tsx", "/project", source),
    (error) => error instanceof CoverageFormatError && error.code === "functionSetMismatch",
  );
});

test("fails closed when fnMap cannot map one-to-one to callable ranges", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const document = coverageDocument([], callables);
  document["/project/src/callables.tsx"].fnMap["0"].loc = {
    start: { line: 1, column: 0 },
    end: { line: 1, column: 1 },
  };
  document["/project/src/callables.tsx"].fnMap["0"].decl = document["/project/src/callables.tsx"].fnMap["0"].loc;
  const coverageFile = parseIstanbulStatements(document, "src/callables.tsx", "/project", source);

  assert.throws(
    () => attachCoverage(callables, coverageFile),
    (error) => error instanceof CoverageFormatError && error.code === "functionMappingMismatch",
  );
});

test("rejects a forged function body even when decl equals the callable source", () => {
  const forgedSource = "function sample() { return 1; }";
  const [callable] = analyzeTypeScript(forgedSource, "src/forged.ts");
  const forgedRange = {
    startByte: callable.bodyRange.startByte + 2,
    endByte: callable.bodyRange.endByte - 2,
  };
  const document = {
    "/project/src/forged.ts": {
      path: "/project/src/forged.ts",
      statementMap: { "0": locationOfRange(forgedSource, forgedRange) },
      fnMap: {
        "0": {
          name: "sample",
          decl: locationOfRange(forgedSource, callable.sourceRange),
          loc: locationOfRange(forgedSource, forgedRange),
          line: 1,
        },
      },
      branchMap: {},
      s: { "0": 1 },
      f: { "0": 1 },
      b: {},
    },
  };
  const coverageFile = parseIstanbulStatements(
    document,
    "src/forged.ts",
    "/project",
    forgedSource,
  );

  assert.throws(
    () => attachCoverage([callable], coverageFile),
    (error) => error instanceof CoverageFormatError && error.code === "functionMappingMismatch",
  );
});

test("rejects a covered statement when the owning function count is zero", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const document = coverageDocument(
    [statement(lineOf("return normalized"), 1)],
    callables,
  );
  const nestedIndex = callables.findIndex(
    (callable) => callable.qualifiedName === "Counter.method.<locals>.nested",
  );
  assert.notEqual(nestedIndex, -1);
  document["/project/src/callables.tsx"].f[String(nestedIndex)] = 0;
  const coverageFile = parseIstanbulStatements(
    document,
    "src/callables.tsx",
    "/project",
    source,
  );

  assert.throws(
    () => attachCoverage(callables, coverageFile),
    (error) => error instanceof CoverageFormatError && error.code === "functionCountMismatch",
  );
});

test("rejects cross-file and stale-source coverage attachment", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const coverageFile = parseIstanbulStatements(
    coverageDocument([], callables),
    "src/callables.tsx",
    "/project",
    source,
  );
  const otherModule = analyzeTypeScript(source, "src/other.tsx");
  const changedSource = analyzeTypeScript(`${source}\n`, "src/callables.tsx");

  for (const invalidCallables of [otherModule, changedSource]) {
    assert.throws(
      () => attachCoverage(invalidCallables, coverageFile),
      (error) => error instanceof CoverageFormatError && error.code === "coverageIdentityMismatch",
    );
  }
});

test("rejects invalid locations, split surrogates, and invalid source scalars", () => {
  const callables = analyzeTypeScript(source, "src/callables.tsx");
  const invalidLocation = coverageDocument([statement(lineOf("return normalized"), 1)], callables);
  invalidLocation["/project/src/callables.tsx"].statementMap["0"].start.line = 0;
  assert.throws(
    () => parseIstanbulStatements(invalidLocation, "src/callables.tsx", "/project", source),
    /line/,
  );
  for (const invalidColumn of [null, "0", 1.5]) {
    const invalidColumnDocument = coverageDocument(
      [statement(lineOf("return normalized"), 1)],
      callables,
    );
    invalidColumnDocument["/project/src/callables.tsx"].statementMap["0"].start.column = invalidColumn;
    assert.throws(
      () => parseIstanbulStatements(invalidColumnDocument, "src/callables.tsx", "/project", source),
      (error) => error instanceof CoverageFormatError && error.code === "invalidStatementLocation",
    );
  }
  assert.throws(
    () => parseIstanbulStatements(
      coverageDocument([statement(lineOf("return normalized"), -1)], callables),
      "src/callables.tsx",
      "/project",
      source,
    ),
    /count/,
  );

  const astralSource = "function emoji() { return \"😀\"; }";
  const astralCallable = analyzeTypeScript(astralSource, "src/emoji.ts");
  const splitColumn = astralSource.indexOf("😀") + 1;
  const splitDocument = {
    "/project/src/emoji.ts": {
      path: "/project/src/emoji.ts",
      statementMap: {
        "0": {
          start: { line: 1, column: splitColumn },
          end: { line: 1, column: splitColumn + 1 },
        },
      },
      fnMap: {
        "0": {
          name: "emoji",
          decl: locationOfRange(astralSource, astralCallable[0].sourceRange),
          loc: locationOfRange(astralSource, astralCallable[0].bodyRange),
          line: 1,
        },
      },
      branchMap: {},
      s: { "0": 1 },
      f: { "0": 1 },
      b: {},
    },
  };
  assert.throws(
    () => parseIstanbulStatements(splitDocument, "src/emoji.ts", "/project", astralSource),
    (error) => error instanceof CoverageFormatError && error.code === "invalidStatementLocation",
  );

  assert.throws(
    () => parseIstanbulStatements({}, "src/invalid.ts", "/project", "const invalid = '\udc00';"),
    (error) => error instanceof CoverageFormatError && error.code === "invalidUnicodeScalar",
  );
});

test("maps actual-style CRLF function end-of-line markers before the CR byte", () => {
  const crlfSource = "\uFEFFfunction 이름() {\r\n  return \"😀\";\r\n}\r\n";
  const [callable] = analyzeTypeScript(crlfSource, "src/crlf.ts");
  const functionNameStart = Buffer.byteLength("\uFEFFfunction ", "utf8");
  const functionNameEnd = functionNameStart + Buffer.byteLength("이름", "utf8");
  const declaration = locationOfRange(crlfSource, {
    startByte: functionNameStart,
    endByte: functionNameEnd,
  });
  const body = locationOfRange(crlfSource, callable.bodyRange);
  body.end.column = null;
  const document = {
    "/project/src/crlf.ts": {
      path: "/project/src/crlf.ts",
      statementMap: {
        "0": {
          start: { line: 2, column: 2 },
          end: { line: 2, column: null },
        },
      },
      fnMap: {
        "0": { name: "이름", decl: declaration, loc: body, line: 1 },
      },
      branchMap: {},
      s: { "0": 1 },
      f: { "0": 1 },
      b: {},
    },
  };

  const coverageFile = parseIstanbulStatements(document, "src/crlf.ts", "/project", crlfSource);
  const [metric] = attachCoverage([callable], coverageFile);
  assert.deepEqual(metric.coverage, { covered: 1, total: 1 });
});

function compilerLocationOfRange(text, range, modulePath) {
  const sourceFile = typescriptAst.createSourceFile(
    modulePath,
    text,
    typescriptAst.ScriptTarget.Latest,
    true,
    typescriptAst.ScriptKind.TS,
  );
  const pointAt = (byteOffset) => {
    const prefix = Buffer.from(text, "utf8").subarray(0, byteOffset).toString("utf8");
    assert.equal(Buffer.byteLength(prefix, "utf8"), byteOffset);
    const point = sourceFile.getLineAndCharacterOfPosition(prefix.length);
    return { line: point.line + 1, column: point.character };
  };
  return { start: pointAt(range.startByte), end: pointAt(range.endByte) };
}

test("uses TypeScript line semantics for lone CR and Unicode separators", () => {
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    const modulePath = "src/line-separators.ts";
    const separatedSource = `function first() { return 1; }${separator}function second() { return 2; }`;
    const callables = analyzeTypeScript(separatedSource, modulePath);
    const fnMap = {};
    const f = {};
    callables.forEach((callable, index) => {
      fnMap[String(index)] = {
        name: callable.qualifiedName,
        decl: compilerLocationOfRange(separatedSource, callable.sourceRange, modulePath),
        loc: compilerLocationOfRange(separatedSource, callable.bodyRange, modulePath),
        line: index + 1,
      };
      f[String(index)] = 1;
    });
    const document = {
      "/project/src/line-separators.ts": {
        path: "/project/src/line-separators.ts",
        statementMap: {},
        fnMap,
        branchMap: {},
        s: {},
        f,
        b: {},
      },
    };

    const coverageFile = parseIstanbulStatements(
      document,
      modulePath,
      "/project",
      separatedSource,
    );
    assert.equal(coverageFile.functions.length, 2);
  }
});

function metric({
  id,
  modulePath = "src/value.ts",
  startByte = 0,
  numerator = "1",
  denominator = "1",
  unknown = false,
}) {
  const decimal = unknown ? null : renderCanonicalDecimal(BigInt(numerator), BigInt(denominator));
  const pass = unknown ? null : BigInt(numerator) <= 8n * BigInt(denominator);
  return {
    callableId: id,
    kind: "function",
    syntaxKind: "function",
    modulePath,
    sourceDigest: `sha256:${"0".repeat(64)}`,
    qualifiedName: id,
    signature: "sync|plain|<>|()|",
    sourceRange: { startByte, endByte: startByte + 1 },
    bodyRange: { startByte, endByte: startByte + 1 },
    complexity: 1,
    coverage: unknown ? null : { covered: 1, total: 1 },
    crap: unknown
      ? null
      : { numerator, denominator, decimal, pass },
    unknownReason: unknown ? "coverageUnitsMissing" : null,
  };
}

test("sorts risk by unknown, exact fraction, UTF-8 path, start, and callable ID", () => {
  const values = [
    metric({ id: "near-low", numerator: "1", denominator: "3" }),
    metric({ id: "astral-path", modulePath: "src/𐀀.ts", numerator: "1", denominator: "4" }),
    metric({ id: "unknown", unknown: true }),
    metric({ id: "near-high", numerator: "1666666666667", denominator: "5000000000000" }),
    metric({ id: "pua-path", modulePath: "src/.ts", numerator: "1", denominator: "4" }),
    metric({ id: "id-z", modulePath: "src/tie.ts", startByte: 9, numerator: "1", denominator: "4" }),
    metric({ id: "id-a", modulePath: "src/tie.ts", startByte: 9, numerator: "1", denominator: "4" }),
  ];

  const expected = ["unknown", "near-high", "near-low", "id-a", "id-z", "pua-path", "astral-path"];
  assert.deepEqual(sortCallableMetrics(values).map((row) => row.callableId), expected);
  assert.deepEqual(sortCallableMetrics(values).map((row) => row.callableId), expected);
});

test("consumes the vendored SENTINEL_SPEC stable row-order golden", async () => {
  const golden = JSON.parse(
    await readFile(new URL("./fixtures/spec/stable-sort-v1.json", import.meta.url), "utf8"),
  );

  for (const vector of golden.cases) {
    const actual = sortCallableMetrics(vector.rows.map((row) => metric({
      id: row.callableId,
      modulePath: row.moduleRelativePath,
      startByte: row.sourceStartByte,
      numerator: row.numerator,
      denominator: row.denominator,
      unknown: row.unknownReason !== undefined,
    })));
    assert.deepEqual(actual.map((row) => row.callableId), vector.expectedCallableIds, vector.id);
  }

  for (const vector of golden.invalidCases) {
    assert.throws(
      () => sortCallableMetrics(vector.rows.map((row) => metric({
        id: row.callableId,
        modulePath: row.moduleRelativePath,
        startByte: row.sourceStartByte,
        numerator: row.numerator,
        denominator: row.denominator,
        unknown: row.unknownReason !== undefined,
      }))),
      (error) => error instanceof CallableIdentityError && error.code === vector.expectedError,
      vector.id,
    );
  }
});

test("rejects a duplicate final risk-order key", () => {
  const duplicate = metric({ id: "same", modulePath: "src/same.ts", startByte: 1 });
  assert.throws(
    () => sortCallableMetrics([duplicate, { ...duplicate }]),
    (error) => error instanceof CallableIdentityError && error.code === "identityAmbiguous",
  );
});

test("rejects malformed exact CRAP rows before sorting", () => {
  const invalidRows = [
    ["callableIdInvalid", metric({ id: "" })],
    ["callableIdInvalid", metric({ id: "invalid\ud800" })],
    ["crapFractionInvalid", { ...metric({ id: "leading-zero" }), crap: {
      numerator: "01",
      denominator: "1",
      decimal: "1",
      pass: true,
    } }],
    ["crapFractionInvalid", { ...metric({ id: "zero-denominator" }), crap: {
      numerator: "1",
      denominator: "0",
      decimal: "0",
      pass: true,
    } }],
    ["crapFractionInvalid", { ...metric({ id: "unreduced" }), crap: {
      numerator: "2",
      denominator: "2",
      decimal: "1",
      pass: true,
    } }],
    ["crapRowStateInvalid", {
      ...metric({ id: "known-with-unknown-reason" }),
      unknownReason: "coverageFileMissing",
    }],
    ["crapFractionInvalid", {
      ...metric({ id: "wrong-decimal" }),
      crap: { numerator: "1", denominator: "1", decimal: "2", pass: true },
    }],
    ["crapRowStateInvalid", {
      ...metric({ id: "unknown-with-coverage", unknown: true }),
      coverage: { covered: 0, total: 1 },
    }],
    ["crapRowStateInvalid", {
      ...metric({ id: "unknown-invalid-unicode", unknown: true }),
      unknownReason: "invalid\ud800",
    }],
  ];

  for (const [expectedCode, row] of invalidRows) {
    assert.throws(
      () => sortCallableMetrics([row]),
      (error) => error instanceof CallableIdentityError && error.code === expectedCode,
    );
  }
});

test("rejects noncanonical path text before UTF-8 risk sorting", () => {
  for (const modulePath of ["src/invalid\u0000.ts", "src/invalid\udc00.ts"]) {
    assert.throws(
      () => sortCallableMetrics([metric({ id: "invalid", modulePath })]),
      (error) => error instanceof CoverageFormatError && error.code === "invalidModulePath",
    );
  }
});
