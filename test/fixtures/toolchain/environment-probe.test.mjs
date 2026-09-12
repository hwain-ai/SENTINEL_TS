import assert from "node:assert/strict";
import test from "node:test";

test("receives no ambient Node, proxy, or npm configuration", () => {
  assert.deepEqual(
    {
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      nodePath: process.env.NODE_PATH ?? null,
      proxy: process.env.HTTPS_PROXY ?? null,
      registry: process.env.NPM_CONFIG_REGISTRY ?? null,
    },
    {
      nodeOptions: null,
      nodePath: null,
      proxy: null,
      registry: null,
    },
  );
});
