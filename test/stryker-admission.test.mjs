import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const eventPrefix = "SENTINEL_STRYKER_EVENT_V1:";

test("the locked Stryker executable emits an exact plan and final-result join", () => {
  const run = spawnSync(
    join(repositoryRoot, "scripts", "node.sh"),
    [
      "--tool",
      "stryker",
      "--",
      "run",
      "test/fixtures/stryker-admission/stryker.config.json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const eventLine = run.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(eventPrefix));
  assert.ok(eventLine, `missing sentinel reporter event:\n${run.stdout}`);
  const record = JSON.parse(
    Buffer.from(eventLine.slice(eventPrefix.length), "base64url").toString("utf8"),
  );
  assert.deepEqual(record.productionFiles, ["test/fixtures/stryker-admission/value.js"]);
  assert.ok(record.candidates.length > 0);
  assert.deepEqual(
    record.candidates.map((candidate) => candidate.id),
    record.outcomes.map((outcome) => outcome.id),
  );
  assert.ok(record.candidates.every((candidate) => candidate.modulePath === "test/fixtures/stryker-admission/value.js"));
  assert.ok(record.outcomes.every((outcome) => outcome.rawStatus === "Killed"));
  assert.equal(JSON.stringify(record).includes("replacement"), false);
  assert.equal(JSON.stringify(record).includes("source"), false);
  const tree = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      join(repositoryRoot, "scripts", "toolchain_lock.py"),
      join(repositoryRoot, "toolchain.lock.json"),
      "node",
      "--require-locked",
      "--verify-dependency-tree",
      repositoryRoot,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(tree.status, 0, tree.stderr);
});
