import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";
import { loadMutationProject, restrictProject } from "../dist/project.js";

async function writeProject() {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-changed-"));
  await mkdir(join(project, "src"));
  await mkdir(join(project, "test"));
  await writeFile(join(project, "src", "first.ts"), "export const first = 1;\n", "utf8");
  await writeFile(join(project, "src", "second.ts"), "export const second = 2;\n", "utf8");
  await writeFile(join(project, "test", "all.test.ts"), 'import { it } from "vitest";\nit("runs", () => {});\n', "utf8");
  await writeFile(join(project, "vitest.config.mjs"), "export default { test: { include: [\"test/**/*.test.ts\"] } };\n", "utf8");
  await writeFile(join(project, "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(join(project, "sentinel.config.json"), JSON.stringify({
    specVersion: "1.0.0",
    modules: [{
      id: "web", language: "typescript", root: ".", production: ["src/**/*.ts"],
      testCommand: ["vitest", "--run"],
      coverage: { command: ["vitest", "--run", "--coverage"], format: "istanbul-json", report: "coverage/coverage-final.json" },
      testRoots: ["test"], testPatterns: ["*.test.ts"],
    }],
  }), "utf8");
  return project;
}

function dependencies(cwd) {
  const output = [];
  const errors = [];
  return {
    value: { cwd, now: () => "2026-09-13T00:00:00.000Z", newRunId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", writeOut: (t) => output.push(t), writeError: (t) => errors.push(t) },
    output,
    errors,
  };
}

test("restrictProject keeps only changed production files and returns null for none", async () => {
  const project = await loadMutationProject(await writeProject());
  assert.deepEqual(project.productionFiles, ["src/first.ts", "src/second.ts"]);
  const restricted = restrictProject(project, ["src/second.ts", "test/all.test.ts", "README.md"]);
  assert.deepEqual(restricted.productionFiles, ["src/second.ts"]);
  assert.deepEqual(restricted.protectedFiles, project.protectedFiles);
  assert.equal(restrictProject(project, ["test/all.test.ts"]), null);
  assert.throws(() => restrictProject(project, ["/etc/passwd"]), (error) => error?.code === "projectConfigShapeInvalid");
  assert.throws(() => restrictProject(project, ["src/../src/first.ts"]), (error) => error?.code === "projectConfigShapeInvalid");
});

test("check with --changed-file that touches no production file passes without a run or evidence", async () => {
  const project = await writeProject();
  const io = dependencies(project);
  const exitCode = await runCli(["check", "--project", project, "--changed-file", "test/all.test.ts"], io.value);
  assert.equal(exitCode, 0, io.errors.join(""));
  assert.deepEqual(JSON.parse(io.output.join("")), { changedScope: "empty", command: "check", pass: true });
  await assert.rejects(() => readdir(join(project, ".sentinel")), /ENOENT/u);
});

test("--changed-file is rejected together with --input", async () => {
  const project = await writeProject();
  await writeFile(join(project, "crap.json"), '{"rows":[]}\n', "utf8");
  const io = dependencies(project);
  const exitCode = await runCli(["crap", "--input", join(project, "crap.json"), "--changed-file", "src/first.ts"], io.value);
  assert.equal(exitCode, 6);
  assert.equal(JSON.parse(io.errors.join("")).error.code, "invalidCliArguments");
});
