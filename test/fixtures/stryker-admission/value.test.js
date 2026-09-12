import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { isEven } from "./value.js";

describe("isEven", () => {
  it("distinguishes even and odd integers", () => {
    assert.equal(isEven(2), true);
    assert.equal(isEven(3), false);
  });
});
