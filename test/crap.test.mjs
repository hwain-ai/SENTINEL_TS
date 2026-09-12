import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as typescriptAst from "@typescript/old";

import {
  CallableIdentityError,
  SourceAnalysisError,
  analyzeTypeScript,
  computeCrap,
  renderCanonicalDecimal,
} from "../dist/crap.js";

const fixtureUrl = new URL("./fixtures/callables.tsx", import.meta.url);
const fixture = await readFile(fixtureUrl, "utf8");

test("uses the lock-file-pinned TypeScript 6 AST implementation", () => {
  assert.equal(typescriptAst.version, "6.0.3");
});

test("discovers TypeScript and TSX callable kinds independently", () => {
  const rows = analyzeTypeScript(fixture, "src/callables.tsx");
  const byName = new Map(rows.map((row) => [row.qualifiedName, row]));

  assert.equal(rows.length, 11);
  assert.equal(byName.get("plain").kind, "function");
  assert.equal(byName.get("plain").syntaxKind, "function");
  assert.equal(byName.get("load").kind, "asyncFunction");
  assert.equal(byName.get("Counter.constructor").kind, "constructor");
  assert.equal(byName.get("Counter.value#get").kind, "getter");
  assert.equal(byName.get("Counter.value#set").kind, "setter");
  assert.equal(byName.get("Counter.method").kind, "method");
  assert.equal(byName.get("Counter.method.<locals>.nested").kind, "function");
  assert.equal(byName.get("Counter.method.<function:expression>").kind, "functionExpression");
  assert.equal(byName.get("Counter.method.<arrow:arrow>").kind, "arrowFunction");
  assert.equal(byName.get("Component.<callback:onClick>").kind, "tsxCallback");
  assert.equal(byName.get("Component.<callback:onClick>").syntaxKind, "arrowFunction");
});

test("keeps arrow and function-expression syntax for TSX callback roles", () => {
  const callbackSource = `
    function View() {
      return <Widget render={function renderValue() { return 1; }}>{() => 2}</Widget>;
    }
  `;
  const rows = analyzeTypeScript(callbackSource, "src/callbacks.tsx");
  const callbacks = rows.filter((row) => row.kind === "tsxCallback");

  assert.equal(callbacks.length, 2);
  assert.deepEqual(
    callbacks.map((row) => row.syntaxKind).sort(),
    ["arrowFunction", "functionExpression"],
  );
});

test("does not add nested callable decisions to the parent", () => {
  const rows = analyzeTypeScript(fixture, "src/callables.tsx");
  const complexity = Object.fromEntries(rows.map((row) => [row.qualifiedName, row.complexity]));

  assert.equal(complexity.plain, 3);
  assert.equal(complexity.load, 3);
  assert.equal(complexity["Counter.constructor"], 1);
  assert.equal(complexity["Counter.method"], 1);
  assert.equal(complexity["Counter.method.<locals>.nested"], 2);
  assert.equal(complexity["Counter.method.<function:expression>"], 2);
  assert.equal(complexity["Counter.method.<arrow:arrow>"], 2);
  assert.equal(complexity.Component, 1);
  assert.equal(complexity["Component.<callback:onClick>"], 2);
});

test("uses UTF-8 byte ranges and stable descriptor IDs", () => {
  const rows = analyzeTypeScript(fixture, "src/callables.tsx");
  const plain = rows.find((row) => row.qualifiedName === "plain");

  assert.ok(plain.sourceRange.startByte > fixture.indexOf("export function plain"));
  assert.match(plain.callableId, /^ts-v3:[0-9a-f]{64}$/);
  assert.match(plain.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(analyzeTypeScript(fixture, "src/callables.tsx")[0].callableId, rows[0].callableId);
});

test("keeps semantic IDs stable across whitespace and line insertion", () => {
  const compact = "function stable(value:string){ return value; }";
  const spaced = "\n\nfunction stable ( value : string )\n{\n  return value ;\n}";

  assert.equal(
    analyzeTypeScript(compact, "src/stable.ts")[0].callableId,
    analyzeTypeScript(spaced, "src/stable.ts")[0].callableId,
  );
});

test("includes semantic namespace, object, class binding, and receiver owners", () => {
  const ownerSource = `
    namespace Alpha { export function run() { return 1; } }
    namespace Beta { export function run() { return 2; } }
    const first = { method() { return 1; } };
    const second = { method() { return 2; } };
    const First = class { method() { return 1; } };
    const Second = class { method() { return 2; } };
    class Dual { static method() { return 1; } method() { return 2; } }
    const left = (((() => 1) as () => number));
    const right = (((() => 2) as () => number));
  `;
  const rows = analyzeTypeScript(ownerSource, "src/owners.ts");

  assert.equal(rows.length, 10);
  assert.equal(new Set(rows.map((row) => row.callableId)).size, rows.length);
  assert.ok(rows.some((row) => row.qualifiedName === "Alpha.run"));
  assert.ok(rows.some((row) => row.qualifiedName === "Beta.run"));
});

test("distinguishes named function expressions by their stable bindings", () => {
  const forward = `
    const first = function worker() { return 1; };
    const second = function worker() { return 2; };
  `;
  const reordered = `
    const second = function worker() { return 20; };
    const inserted = 0;
    const first = function worker() { return 10; };
  `;

  const forwardIds = analyzeTypeScript(forward, "src/named-expressions.ts")
    .map((row) => row.callableId)
    .sort();
  const reorderedIds = analyzeTypeScript(reordered, "src/named-expressions.ts")
    .map((row) => row.callableId)
    .sort();

  assert.equal(new Set(forwardIds).size, 2);
  assert.deepEqual(reorderedIds, forwardIds);
});

test("distinguishes class property receivers and carries parent receiver identity to children", () => {
  const forward = `
    class Example {
      static handler = () => 1;
      handler = () => 2;
      static method() { return () => 3; }
      method() { return () => 4; }
    }
  `;
  const reordered = `
    class Example {
      method() { return () => 40; }
      static method() { return () => 30; }
      handler = () => 20;
      static handler = () => 10;
    }
  `;

  const forwardIds = analyzeTypeScript(forward, "src/class-receivers.ts")
    .map((row) => row.callableId)
    .sort();
  const reorderedIds = analyzeTypeScript(reordered, "src/class-receivers.ts")
    .map((row) => row.callableId)
    .sort();

  assert.equal(forwardIds.length, 6);
  assert.equal(new Set(forwardIds).size, 6);
  assert.deepEqual(reorderedIds, forwardIds);
});

test("distinguishes bound callbacks without using source order", () => {
  const forward = `
    declare function consume(callback: () => number): number;
    const first = consume(() => 1);
    const second = consume(() => 2);
  `;
  const reordered = `
    declare function consume(callback: () => number): number;
    const second = consume(() => 20);
    const first = consume(() => 10);
  `;

  const forwardIds = analyzeTypeScript(forward, "src/bound-callbacks.ts")
    .map((row) => row.callableId)
    .sort();
  const reorderedIds = analyzeTypeScript(reordered, "src/bound-callbacks.ts")
    .map((row) => row.callableId)
    .sort();

  assert.equal(new Set(forwardIds).size, 2);
  assert.deepEqual(reorderedIds, forwardIds);
});

test("distinguishes TSX child callbacks by stable element roles", () => {
  const forward = "function View(){ return <><a>{() => 1}</a><b>{() => 2}</b></>; }";
  const reordered = "function View(){ return <><b>{() => 20}</b><a>{() => 10}</a></>; }";

  const forwardCallbacks = analyzeTypeScript(forward, "src/tsx-children.tsx")
    .filter((row) => row.kind === "tsxCallback")
    .map((row) => row.callableId)
    .sort();
  const reorderedCallbacks = analyzeTypeScript(reordered, "src/tsx-children.tsx")
    .filter((row) => row.kind === "tsxCallback")
    .map((row) => row.callableId)
    .sort();

  assert.equal(new Set(forwardCallbacks).size, 2);
  assert.deepEqual(reorderedCallbacks, forwardCallbacks);
});

test("distinguishes same-tag TSX children by stable outer bindings", () => {
  const forward = `
    function View() {
      const first = <a>{() => 1}</a>;
      const second = <a>{() => 2}</a>;
      return <>{first}{second}</>;
    }
  `;
  const reordered = `
    function View() {
      const second = <a>{() => 20}</a>;
      const first = <a>{() => 10}</a>;
      return <>{first}{second}</>;
    }
  `;

  const callbackIds = (source) => analyzeTypeScript(source, "src/same-tag-children.tsx")
    .filter((row) => row.kind === "tsxCallback")
    .map((row) => row.callableId)
    .sort();
  const forwardIds = callbackIds(forward);
  const reorderedIds = callbackIds(reordered);

  assert.equal(new Set(forwardIds).size, 2);
  assert.deepEqual(reorderedIds, forwardIds);
});

test("distinguishes same-tag TSX children by stable element ancestry", () => {
  const forward = `
    function View() {
      return <><section><a>{() => 1}</a></section><aside><a>{() => 2}</a></aside></>;
    }
  `;
  const reordered = `
    function View() {
      return <><aside><a>{() => 20}</a></aside><section><a>{() => 10}</a></section></>;
    }
  `;

  const callbackIds = (source) => analyzeTypeScript(source, "src/nested-children.tsx")
    .filter((row) => row.kind === "tsxCallback")
    .map((row) => row.callableId)
    .sort();
  const forwardIds = callbackIds(forward);
  const reorderedIds = callbackIds(reordered);

  assert.equal(new Set(forwardIds).size, 2);
  assert.deepEqual(reorderedIds, forwardIds);
});

test("distinguishes conditional arms without source positions", () => {
  const compact = "const choose = flag ? (() => 1) : (() => 2);";
  const spaced = "\nconst choose = flag\n  ? (() => 10)\n  : (() => 20);";

  const ids = (value) => analyzeTypeScript(value, "src/conditional-arrows.ts")
    .map((row) => row.callableId)
    .sort();
  const compactIds = ids(compact);

  assert.equal(compactIds.length, 2);
  assert.equal(new Set(compactIds).size, 2);
  assert.deepEqual(ids(spaced), compactIds);
});

test("distinguishes keyed sibling TSX callback attributes", () => {
  const forward = `
    function View() {
      return <><Item key="first" render={() => 1}/><Item key="second" render={() => 2}/></>;
    }
  `;
  const reordered = `
    function View() {
      return <><Item key="second" render={() => 20}/><Item key="first" render={() => 10}/></>;
    }
  `;

  const ids = (value) => analyzeTypeScript(value, "src/keyed-callbacks.tsx")
    .filter((row) => row.kind === "tsxCallback")
    .map((row) => row.callableId)
    .sort();
  const forwardIds = ids(forward);

  assert.equal(forwardIds.length, 2);
  assert.equal(new Set(forwardIds).size, 2);
  assert.deepEqual(ids(reordered), forwardIds);
});

test("handles every stable and absent TSX key initializer form", () => {
  const sources = [
    'function View(){ return <Item key render={() => 1}/>; }',
    'function View(){ return <Item key={"fixed"} render={() => 1}/>; }',
    'function View(){ return <Item key={1} render={() => 1}/>; }',
    'function View(){ return <Item key={`fixed`} render={() => 1}/>; }',
    'function View(value: string){ return <Item key={value} render={() => 1}/>; }',
    'function View(){ return <Item key={} render={() => 1}/>; }',
    'function View(){ return <Item key=<Nested /> render={() => 1}/>; }',
  ];

  for (const value of sources) {
    assert.equal(analyzeTypeScript(value, "src/key-forms.tsx").length, 2);
  }
});

test("does not include an earlier callback body in a later chained callback ID", () => {
  const ids = (constant) => analyzeTypeScript(
    `const result = values.map((value) => value + ${constant}).filter((value) => value > 0);`,
    "src/chained-callbacks.ts",
  );

  assert.equal(ids(1)[0].callableId, ids(2)[0].callableId);
  assert.equal(ids(1)[1].callableId, ids(2)[1].callableId);
});

test("does not include a condition callback body in conditional-arm IDs", () => {
  const armIds = (constant) => analyzeTypeScript(
    `const choose = select((value) => value + ${constant}) ? (() => 1) : (() => 2);`,
    "src/condition-callback.ts",
  )
    .filter((row) => row.qualifiedName.includes("conditional:"))
    .map((row) => row.callableId)
    .sort();

  assert.deepEqual(armIds(1), armIds(2));
});

test("does not include a default callback body in its owner signature", () => {
  const ownerId = (constant) => analyzeTypeScript(
    `function use(callback = () => ${constant}) { return callback(); }`,
    "src/default-callback.ts",
  ).find((row) => row.qualifiedName === "use").callableId;

  assert.equal(ownerId(1), ownerId(2));
});

test("distinguishes callbacks returned from different control-flow roles", () => {
  const compact = "function choose(flag:boolean){ if(flag) return () => 1; return () => 2; }";
  const spaced = `
    function choose(flag: boolean) {
      if (flag) return () => 10;
      return () => 20;
    }
  `;
  const ids = (value) => analyzeTypeScript(value, "src/returned-callbacks.ts")
    .filter((row) => row.kind === "arrowFunction")
    .map((row) => row.callableId)
    .sort();
  const compactIds = ids(compact);

  assert.equal(compactIds.length, 2);
  assert.equal(new Set(compactIds).size, 2);
  assert.deepEqual(ids(spaced), compactIds);
});

test("inventories an anonymous default-export function", () => {
  const [row] = analyzeTypeScript(
    "export default function () { return 1; }",
    "src/default-function.ts",
  );

  assert.equal(row.kind, "function");
  assert.match(row.callableId, /^ts-v3:[0-9a-f]{64}$/);
});

test("keeps exact duplicate anonymous sites ambiguous", () => {
  const duplicate = `
    declare function consume(callback: () => number): void;
    function outer() {
      consume(() => 1);
      consume(() => 2);
    }
  `;

  assert.throws(
    () => analyzeTypeScript(duplicate, "src/duplicate-callbacks.ts"),
    (error) => error instanceof CallableIdentityError && error.code === "identityAmbiguous",
  );
});

test("uses named control-flow roles for repeated callback call sites", () => {
  const repeatedCallbacks = `
    function walk(node: unknown) {
      if (node === null) consume(node, () => 1);
      if (node !== null) consume(node, () => 2);
      consume(node, () => 3);
    }
  `;
  const rows = analyzeTypeScript(repeatedCallbacks, "src/repeated-callbacks.ts");

  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.callableId)).size, rows.length);
});

test("inventories only the executable overload implementation", () => {
  const overloadSource = `
    function convert(value: string): string;
    function convert(value: number): number;
    function convert(value: string | number): string | number { return value; }
  `;

  assert.equal(analyzeTypeScript(overloadSource, "src/overload.ts").length, 1);
});

test("counts class static-block decisions on the enclosing callable only", () => {
  const staticBlockSource = `
    function outer(flag: boolean) {
      class Inner {
        static { if (flag) console.log(flag); }
        method() { if (flag) return 1; return 0; }
      }
      return Inner;
    }
  `;
  const rows = analyzeTypeScript(staticBlockSource, "src/static-block.ts");
  const byName = new Map(rows.map((row) => [row.qualifiedName, row]));

  assert.equal(byName.get("outer").complexity, 2);
  assert.equal(byName.get("outer.<class>.Inner.method").complexity, 2);
});

test("counts a static class-field initializer on the enclosing callable", () => {
  const [outer] = analyzeTypeScript(
    "function outer(flag: boolean) { class Inner { static value = flag ? 1 : 2; } return Inner; }",
    "src/static-field.ts",
  );

  assert.equal(outer.qualifiedName, "outer");
  assert.equal(outer.complexity, 2);
});

test("counts logical assignment operators as short-circuit decisions", () => {
  const [row] = analyzeTypeScript(
    "function update(left: boolean, right: boolean) { left &&= right; left ||= right; left ??= right; }",
    "src/logical-assignment.ts",
  );

  assert.equal(row.complexity, 4);
});

test("owns nested class heritage and computed-name decisions exactly once", () => {
  const source = `
    class BaseA {}
    class BaseB {}
    function outer(flag: boolean) {
      class Inner extends (flag ? BaseA : BaseB) {
        [flag ? "yes" : "no"]() { return 1; }
      }
      return Inner;
    }
  `;
  const rows = analyzeTypeScript(source, "src/class-runtime.ts");
  const byName = new Map(rows.map((row) => [row.qualifiedName, row]));

  assert.equal(byName.get("outer").complexity, 3);
  assert.equal(byName.get('outer.<class>.Inner.[flag?"yes":"no"]').complexity, 1);
});

test("counts class decorator decisions on the enclosing callable", () => {
  const [outer] = analyzeTypeScript(
    `
      declare const yes: unknown;
      declare const no: unknown;
      declare function choose(value: unknown): ClassDecorator;
      function outer(flag: boolean) {
        @choose(flag ? yes : no)
        class Inner {}
        return Inner;
      }
    `,
    "src/decorator-runtime.ts",
  );

  assert.equal(outer.qualifiedName, "outer");
  assert.equal(outer.complexity, 2);
});

test("counts member and parameter decorator decisions on the enclosing callable", () => {
  const rows = analyzeTypeScript(
    `
      declare const yes: unknown;
      declare const no: unknown;
      declare function choose(value: unknown): MethodDecorator & ParameterDecorator;
      function outer(flag: boolean) {
        class Inner {
          @choose(flag ? yes : no)
          method(@choose(flag ? yes : no) value: unknown) { return value; }
        }
        return Inner;
      }
    `,
    "src/member-decorator-runtime.ts",
  );
  const byName = new Map(rows.map((row) => [row.qualifiedName, row]));

  assert.equal(byName.get("outer").complexity, 3);
  assert.equal(byName.get("outer.<class>.Inner.method").complexity, 1);
});

test("counts instance field decisions on the explicit constructor", () => {
  const rows = analyzeTypeScript(
    "class Example { value = this.flag ? 1 : 2; constructor(private flag: boolean) {} }",
    "src/instance-field.ts",
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].qualifiedName, "Example.constructor");
  assert.equal(rows[0].complexity, 2);
});

test("fails closed for a decision-bearing instance field without an explicit constructor", () => {
  assert.throws(
    () => analyzeTypeScript(
      "class Example { value = this.flag ? 1 : 2; private flag = true; }",
      "src/implicit-constructor.ts",
    ),
    (error) => error instanceof SourceAnalysisError && error.code === "runtimeDecisionOwnerMissing",
  );
});

test("counts default-parameter decisions on the invoked callable", () => {
  const [row] = analyzeTypeScript(
    "function choose(flag: boolean, value = flag ? 1 : 2) { return value; }",
    "src/default-parameter.ts",
  );

  assert.equal(row.complexity, 2);
});

test("counts the complete TypeScript decision matrix without nested duplication", () => {
  const decisionSource = `
    function decisions(value: number, values: number[]) {
      if (value > 0) value++;
      for (let index = 0; index < value; index++) value++;
      for (const key in values) value++;
      for (const item of values) value++;
      while (value > 0) value--;
      do value++; while (value < 0);
      try { value++; } catch { value--; }
      const selected = value > 0 ? 1 : 0;
      switch (value) { case 1: break; case 2: break; default: break; }
      const nested = () => value && selected || (value ?? selected);
      return nested();
    }
  `;
  const rows = analyzeTypeScript(decisionSource, "src/decisions.ts");
  const byName = new Map(rows.map((row) => [row.qualifiedName, row]));

  assert.equal(byName.get("decisions").complexity, 11);
  assert.equal(byName.get("decisions.<arrow:nested>").complexity, 4);
});

test("uses BOM, CRLF, BMP, and astral code points in exact UTF-8 byte ranges", () => {
  const unicodeSource = "\uFEFFfunction 이름(){\r\n  return \"😀\";\r\n}\r\n";
  const [row] = analyzeTypeScript(unicodeSource, "src/unicode.ts");

  assert.equal(row.sourceRange.startByte, 3);
  assert.equal(row.sourceRange.endByte, Buffer.byteLength(unicodeSource.slice(0, -2), "utf8"));
});

test("rejects source strings that are not valid Unicode scalar sequences", () => {
  assert.throws(
    () => analyzeTypeScript("function invalid(){ return '\ud800'; }", "src/invalid.ts"),
    (error) => error instanceof SourceAnalysisError && error.code === "invalidUnicodeScalar",
  );
});

test("rejects NUL and invalid Unicode scalar module paths", () => {
  for (const modulePath of ["src/invalid\u0000.ts", "src/invalid\ud800.ts"]) {
    assert.throws(
      () => analyzeTypeScript("function valid() {}", modulePath),
      (error) => error instanceof SourceAnalysisError && error.code === "invalidModulePath",
    );
  }
});

test("rejects duplicate identity descriptors instead of adding line suffixes", () => {
  const duplicate = "function same() { return 1; }\nfunction same() { return 2; }\n";
  assert.throws(
    () => analyzeTypeScript(duplicate, "src/duplicate.ts"),
    (error) => error instanceof CallableIdentityError && error.code === "identityAmbiguous",
  );
});

test("computes exact CRAP fractions and the raw threshold", () => {
  assert.deepEqual(computeCrap(4, 3, 4), {
    numerator: "17",
    denominator: "4",
    decimal: "4.25",
    pass: true,
  });
  assert.equal(computeCrap(8, 1, 1).pass, true);
  assert.equal(computeCrap(4, 1, 3).pass, false);
  assert.equal(computeCrap(2, 1, 2).decimal, "2.5");
});

test("consumes the vendored SENTINEL_SPEC CRAP golden", async () => {
  const goldenBytes = await readFile(new URL("./fixtures/spec/formula-v1.json", import.meta.url));
  assert.equal(
    createHash("sha256").update(goldenBytes).digest("hex"),
    "c49493dc25c841af08efd6b1984fdeae47b54a5345e71dea137de96c45fe8884",
  );
  const golden = JSON.parse(goldenBytes.toString("utf8"));

  for (const vector of golden.formulaCases) {
    const { cyclomaticComplexity, coveredUnits, totalUnits } = vector.input;
    assert.deepEqual(
      computeCrap(cyclomaticComplexity, coveredUnits, totalUnits),
      vector.expected,
      vector.id,
    );
  }
  for (const vector of golden.decimalCases) {
    assert.equal(
      renderCanonicalDecimal(BigInt(vector.numerator), BigInt(vector.denominator)),
      vector.expected,
      vector.id,
    );
  }
  for (const vector of golden.invalidCases) {
    const { cyclomaticComplexity, coveredUnits, totalUnits } = vector.input;
    assert.throws(
      () => computeCrap(cyclomaticComplexity, coveredUnits, totalUnits),
      (error) => error?.code === vector.error,
      vector.id,
    );
  }
});

test("renders nonnegative fractions with half-even rounding", () => {
  assert.equal(renderCanonicalDecimal(1n, 3n), "0.333333333333");
  assert.equal(renderCanonicalDecimal(1n, 2_000_000_000_000n), "0");
  assert.equal(renderCanonicalDecimal(3n, 2_000_000_000_000n), "0.000000000002");
  assert.equal(renderCanonicalDecimal(1_999_999_999_999n, 1_000_000_000_000n), "1.999999999999");
});

test("rejects invalid CRAP inputs including booleans represented at runtime", () => {
  assert.throws(() => computeCrap(0, 0, 1), /complexity/);
  assert.throws(() => computeCrap(1, 2, 1), /covered/);
  assert.throws(() => computeCrap(true, 0, 1), /integer/);
});
