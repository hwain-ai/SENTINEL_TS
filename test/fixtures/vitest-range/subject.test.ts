import { expect, test } from "vitest";

import { choose, first } from "./subject.js";

test("runs a subset of the subject", () => {
  expect(choose(true)).toBe(1);
  expect(first()).toBe(1);
});
