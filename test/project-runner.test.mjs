import assert from "node:assert/strict";
import test from "node:test";

import * as projectRunner from "../dist/mutation/project-runner.js";

test("exposes the production-inventory join used at the backend boundary", () => {
  assert.equal(typeof projectRunner.requireExactProductionInventory, "function");
});

function rejectsWithCode(expected, reported, code) {
  assert.throws(
    () => projectRunner.requireExactProductionInventory(expected, reported),
    (error) => error?.code === code,
  );
}

test("accepts only the exact backend-reported production inventory", () => {
  assert.deepEqual(
    projectRunner.requireExactProductionInventory(
      ["src/a.ts", "src/z.ts"],
      ["src/z.ts", "src/a.ts"],
    ),
    ["src/a.ts", "src/z.ts"],
  );

  rejectsWithCode(
    ["src/a.ts", "src/z.ts"],
    ["src/a.ts"],
    "reportedProductionInventoryMismatch",
  );
  rejectsWithCode(
    ["src/a.ts"],
    ["src/a.ts", "src/z.ts"],
    "reportedProductionInventoryMismatch",
  );
});

test("rejects duplicate and noncanonical backend production paths", () => {
  rejectsWithCode(
    ["src/a.ts"],
    [42],
    "reportedProductionInventoryInvalid",
  );
  rejectsWithCode(
    ["src/a.ts"],
    ["src/a.ts", "src/a.ts"],
    "reportedProductionInventoryInvalid",
  );
  rejectsWithCode(
    ["src/a.ts"],
    ["src/../src/a.ts"],
    "reportedProductionInventoryInvalid",
  );
});
