import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function writeProject() {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-real-project-"));
  await mkdir(join(project, "src"));
  await mkdir(join(project, "test"));
  await writeFile(
    join(project, "src", "value.ts"),
    [
      "export function isEven(value: number): boolean {",
      "  return value % 2 === 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(project, "test", "value.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import { describe, it } from "vitest";',
      'import { isEven } from "../src/value.js";',
      "",
      'describe("isEven", () => {',
      '  it("distinguishes even and odd integers", () => {',
      "    assert.equal(isEven(2), true);",
      "    assert.equal(isEven(3), false);",
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(project, "vitest.config.mjs"),
    [
      "export default {",
      '  test: { include: ["test/**/*.test.ts"], retry: 0 },',
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(project, "package.json"), '{"type":"module"}\n', "utf8");
  // A real project carries a tsconfig; Stryker must not try to rewrite it inside the sandbox.
  await writeFile(join(project, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n', "utf8");
  await writeFile(
    join(project, "sentinel.config.json"),
    `${JSON.stringify({
      specVersion: "1.0.0",
      modules: [
        {
          id: "web",
          language: "typescript",
          root: ".",
          production: ["src/**/*.ts"],
          testCommand: ["vitest", "--run"],
          coverage: {
            command: ["vitest", "--run", "--coverage"],
            format: "istanbul-json",
            report: "coverage/coverage-final.json",
          },
          testRoots: ["test"],
          testPatterns: ["*.test.ts"],
        },
      ],
    })}\n`,
    "utf8",
  );
  return project;
}

function dependencies(cwd) {
  const output = [];
  const errors = [];
  return {
    value: {
      cwd,
      now: () => "2026-09-03T13:00:00.000Z",
      newRunId: () => RUN_ID,
      writeOut: (text) => output.push(text),
      writeError: (text) => errors.push(text),
    },
    output,
    errors,
  };
}

test("mutation executes the pinned Stryker and typed Vitest proof in a disposable snapshot", async () => {
  const project = await writeProject();
  const sourcePath = join(project, "src", "value.ts");
  const before = await readFile(sourcePath);
  const beforeMetadata = await stat(sourcePath);
  const io = dependencies(project);

  const exitCode = await runCli(
    ["mutation", "--project", project],
    io.value,
  );

  assert.equal(exitCode, 0, io.errors.join(""));
  const document = JSON.parse(io.output.join(""));
  assert.equal(document.gate.pass, true);
  assert.ok(document.gate.inScope > 0);
  assert.equal(document.gate.counts.killed, document.gate.inScope);
  assert.ok(document.results.every((item) => item.status === "killed"));
  assert.deepEqual(await readFile(sourcePath), before);
  const afterMetadata = await stat(sourcePath);
  assert.equal(afterMetadata.ino, beforeMetadata.ino);
  assert.equal(afterMetadata.mode, beforeMetadata.mode);
  await assert.rejects(() => readdir(join(project, ".stryker-tmp")), /ENOENT/u);
  await assert.rejects(() => readdir(join(project, ".sentinel-runtime")), /ENOENT/u);

  const evidencePath = join(
    project,
    ".sentinel",
    "state-v1",
    "runs",
    RUN_ID,
    "evidence.json",
  );
  const evidence = await readFile(evidencePath, "utf8");
  assert.doesNotMatch(evidence, /value\.ts|isEven|distinguishes/u);
});

test("project mutation rejects a source ignore directive before starting Stryker", async () => {
  const project = await writeProject();
  const sourcePath = join(project, "src", "value.ts");
  await writeFile(
    sourcePath,
    "// Stryker disable all\nexport const value = true;\n",
    "utf8",
  );
  const io = dependencies(project);

  const exitCode = await runCli(["mutation", "--project", project], io.value);

  assert.equal(exitCode, 6);
  assert.equal(JSON.parse(io.errors.join("")).error.code, "unauthorizedMutationDirective");
  assert.equal((await readdir(project)).includes(".sentinel"), false);
});

test("check joins native CRAP input with the real project mutation run", async () => {
  const project = await writeProject();
  const crapPath = join(project, "crap.json");
  await writeFile(
    crapPath,
    `${JSON.stringify({ rows: [{ id: "src/value.ts:isEven", complexity: 1, covered: 1, total: 1 }] })}\n`,
    "utf8",
  );
  const io = dependencies(project);

  const exitCode = await runCli(
    ["check", "--input", crapPath, "--project", project],
    io.value,
  );

  assert.equal(exitCode, 0, io.errors.join(""));
  const document = JSON.parse(io.output.join(""));
  assert.equal(document.pass, true);
  assert.equal(document.crap.pass, true);
  assert.equal(document.mutation.gate.pass, true);
  assert.ok(document.mutation.gate.inScope > 0);
  const evidence = JSON.parse(
    await readFile(
      join(project, ".sentinel", "state-v1", "runs", RUN_ID, "evidence.json"),
      "utf8",
    ),
  );
  assert.equal(evidence.command, "check");
});

test("check without --input measures fresh coverage CRAP and the project mutation run", async () => {
  const project = await writeProject();
  const io = dependencies(project);

  const exitCode = await runCli(["check", "--project", project], io.value);

  assert.equal(exitCode, 0, io.errors.join(""));
  const document = JSON.parse(io.output.join(""));
  assert.equal(document.pass, true);
  assert.deepEqual(document.gate, { crapMax: "8", mutationMin: "90" });
  assert.equal(document.crap.rows.length, 1);
  assert.ok(document.crap.rows[0].id.startsWith("src/value.ts:"));
  assert.equal(document.crap.rows[0].pass, true);
  assert.deepEqual(document.crap.unknown, []);
  assert.equal(document.mutation.gate.pass, true);
  await assert.rejects(() => readdir(join(project, ".sentinel-runtime")), /ENOENT/u);
  await assert.rejects(() => readdir(join(project, "coverage")), /ENOENT/u);
  const evidence = JSON.parse(
    await readFile(join(project, ".sentinel", "state-v1", "runs", RUN_ID, "evidence.json"), "utf8"),
  );
  assert.equal(evidence.components.crap.callableCount, 1);
  assert.equal(evidence.components.crap.crapMax, "8");
  assert.equal(evidence.components.mutation.mutationMin, "90");

  const strictProject = await writeProject();
  const strictIo = dependencies(strictProject);
  const strictExit = await runCli(["check", "--project", strictProject, "--crap-max", "0.5"], strictIo.value);
  assert.equal(strictExit, 2, strictIo.errors.join(""));
  assert.equal(JSON.parse(strictIo.output.join("")).crap.pass, false);
});

test("does not count an actual mutant-triggered TypeError as killed", async () => {
  const project = await writeProject();
  await writeFile(
    join(project, "src", "value.ts"),
    "export function answer(): number { return 42; }\n",
    "utf8",
  );
  await writeFile(
    join(project, "test", "value.test.ts"),
    [
      'import { describe, it } from "vitest";',
      'import { answer } from "../src/value.js";',
      "",
      'describe("answer", () => {',
      '  it("crashes for a changed answer without asserting", () => {',
      "    if (answer() !== 42) (null).missing();",
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const io = dependencies(project);

  const exitCode = await runCli(["mutation", "--project", project], io.value);

  assert.equal(exitCode, 2, io.errors.join(""));
  const document = JSON.parse(io.output.join(""));
  assert.equal(document.gate.pass, false);
  assert.ok(document.gate.counts.runtimeError > 0);
});
