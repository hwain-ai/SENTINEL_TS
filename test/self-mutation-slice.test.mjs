import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateMutationGate } from "../dist/mutation/gate.js";
import { normalizeMutationOutcome } from "../dist/mutation/normalizer.js";
import { collectProjectMutation } from "../dist/mutation/project-runner.js";
import { loadMutationProject } from "../dist/project.js";

const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function configDocument() {
  return {
    specVersion: "1.0.0",
    modules: [{
      id: "normalizer-self-slice",
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
    }],
  };
}

function mutationTestSource() {
  return [
    'import { describe, expect, it } from "vitest";',
    'import { normalizeMutationOutcome } from "../src/normalizer.js";',
    "",
    "const proof = {",
    '  mutantId: "m1",',
    '  assertionType: "AssertionError",',
    '  testId: "normalizer rejects the mutant",',
    '  executionNonce: "nonce-1",',
    "  controlPassed: true,",
    "  assertionFailed: true,",
    "  replayMatched: true,",
    "  cacheObserved: false,",
    "  retryObserved: false,",
    "};",
    "",
    'describe("normalizer self mutation slice", () => {',
    '  it("maps every raw state exactly", () => {',
    "    const states = [",
    '      ["Survived", "survived"],',
    '      ["NoCoverage", "uncovered"],',
    '      ["Timeout", "timedOut"],',
    '      ["CompileError", "compileError"],',
    '      ["RuntimeError", "runtimeError"],',
    '      ["Pending", "pending"],',
    '      ["Ignored", "ignored"],',
    '      ["FutureState", "toolError"],',
    "    ];",
    "    for (const [rawStatus, status] of states) {",
    '      expect(normalizeMutationOutcome({ id: "m1", rawStatus }, proof)).toEqual({ id: "m1", status });',
    "    }",
    "  });",
    "",
    '  it("accepts only a replayed assertion proof", () => {',
    '    expect(normalizeMutationOutcome({ id: "m1", rawStatus: "Killed" }, proof)).toEqual({',
    '      id: "m1",',
    '      status: "killed",',
    "    });",
    '    expect(normalizeMutationOutcome({ id: "m1", rawStatus: "Killed" })).toEqual({',
    '      id: "m1",',
    '      status: "runtimeError",',
    "    });",
    "    const invalidProofs = [",
    '      { ...proof, mutantId: "other" },',
    '      { ...proof, assertionType: "TypeError" },',
    '      { ...proof, testId: "" },',
    "      { ...proof, testId: undefined },",
    '      { ...proof, testId: "bad\\0id" },',
    '      { ...proof, testId: "bad\\nid" },',
    '      { ...proof, testId: "bad\\rid" },',
    '      { ...proof, executionNonce: "" },',
    '      { ...proof, executionNonce: "bad\\0nonce" },',
    '      { ...proof, executionNonce: "bad\\nnonce" },',
    '      { ...proof, executionNonce: "bad\\rnonce" },',
    "      { ...proof, controlPassed: false },",
    "      { ...proof, assertionFailed: false },",
    "      { ...proof, replayMatched: false },",
    "      { ...proof, cacheObserved: true },",
    "      { ...proof, retryObserved: true },",
    "    ];",
    "    for (const invalid of invalidProofs) {",
    '      expect(normalizeMutationOutcome({ id: "m1", rawStatus: "Killed" }, invalid)).toEqual({',
    '        id: "m1",',
    '        status: "runtimeError",',
    "      });",
    "    }",
    "  });",
    "});",
    "",
  ].join("\n");
}

async function selfSliceProject() {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-self-mutation-"));
  await mkdir(join(project, "src"));
  await mkdir(join(project, "test"));
  const normalizer = await readFile(join(repositoryRoot, "src", "mutation", "normalizer.ts"));
  await writeFile(join(project, "src", "normalizer.ts"), normalizer);
  await writeFile(
    join(project, "src", "protocol.js"),
    await readFile(join(repositoryRoot, "dist", "mutation", "protocol.js")),
  );
  await writeFile(join(project, "test", "normalizer.test.ts"), mutationTestSource(), "utf8");
  await writeFile(
    join(project, "vitest.config.mjs"),
    'export default { test: { include: ["test/**/*.test.ts"], retry: 0 } };\n',
    "utf8",
  );
  await writeFile(join(project, "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(
    join(project, "sentinel.config.json"),
    `${JSON.stringify(configDocument())}\n`,
    "utf8",
  );
  return { normalizer, project };
}

test("kills every mutant in an exact-byte copy of the native normalizer", async (context) => {
  const { normalizer, project } = await selfSliceProject();
  const loaded = await loadMutationProject(project);
  const collected = await collectProjectMutation(loaded);
  const proofs = new Map(collected.proofs.map((proof) => [proof.mutantId, proof]));
  const normalized = collected.run.outcomes.map((outcome) =>
    normalizeMutationOutcome(outcome, proofs.get(outcome.id)));
  const gate = evaluateMutationGate(collected.run.candidates, normalized, 0);
  const statusById = new Map(normalized.map((outcome) => [outcome.id, outcome.status]));
  const details = collected.run.candidates.map((candidate) => ({
    ...candidate,
    status: statusById.get(candidate.id),
  }));

  assert.equal(gate.pass, true, JSON.stringify(details.filter((candidate) => candidate.status !== "killed")));
  assert.ok(gate.inScope > 0);
  assert.equal(gate.counts.killed, gate.inScope);
  assert.deepEqual(await readFile(join(project, "src", "normalizer.ts")), normalizer);
  context.diagnostic(`self mutation slice: ${gate.counts.killed}/${gate.inScope} killed`);
});
