import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectProject, mutationOwners } from "../dist/selection.js";

test("explicit function and test selection leaves other project inputs intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "sentinel-selection-"));
  try {
    await writeFile(join(root, "a.ts"), "export function first(x: number) { return x + 1; }\nexport function second(x: number) { return x - 1; }\n");
    const project = { moduleRoot: root, productionFiles: ["a.ts", "b.ts"], testFiles: ["a.test.ts", "b.test.ts"], protectedFiles: ["a.ts", "b.ts"] };
    const selected = await selectProject(project, { files: ["a.ts"], functions: ["first"], tests: ["a.test.ts"] });
    assert.deepEqual(selected.productionFiles, ["a.ts"]);
    assert.deepEqual(selected.testFiles, ["a.test.ts"]);
    assert.deepEqual(selected.protectedFiles, project.protectedFiles);
    assert.equal(selected.selectedCallables[0].qualifiedName, "first");
    await assert.rejects(() => selectProject(project, { files: ["a.ts"], functions: ["missing"], tests: [] }), error => error.code === "functionSelectionInvalid");
    await assert.rejects(() => selectProject(project, { files: ["a.test.ts"], functions: [], tests: [] }), error => error.code === "invalidSelection");
    const owners = await mutationOwners(selected, [{ id: "one", modulePath: "a.ts", location: { start: { line: 1, column: 44 }, end: { line: 1, column: 45 } } }]);
    assert.equal(owners.get("one"), "first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
