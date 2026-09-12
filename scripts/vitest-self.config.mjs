import { defineConfig } from "vitest/config";

const selectedTests = new Set([
  "cli.test.mjs",
  "coverage.test.mjs",
  "crap.test.mjs",
  "evidence-contract.test.mjs",
  "evidence-lock.test.mjs",
  "evidence-store.test.mjs",
  "history-hardening.test.mjs",
  "mutation.test.mjs",
  "project-boundaries.test.mjs",
  "project-mutation.test.mjs",
  "project-runner.test.mjs",
  "runtime.test.mjs",
  "self-quality.test.mjs",
  "stryker-runtime.test.mjs",
]);

function sourceBridge() {
  return {
    name: "sentinel-self-source-bridge",
    enforce: "pre",
    transform(code, id) {
      const normalized = id.split("?")[0]?.replaceAll("\\", "/") ?? "";
      const name = normalized.slice(normalized.lastIndexOf("/") + 1);
      if (!normalized.includes("/test/") || !selectedTests.has(name)) return null;
      const sourceImports = code
        .replace('import test, { after } from "node:test";', 'import { afterAll as after, test } from "vitest";')
        .replace('import test from "node:test";', 'import { test } from "vitest";')
        .replaceAll("t.after(", "t.onTestFinished(")
        .replaceAll("../dist/", "../src/")
        .replace(/(from\s+["']\.\.\/src\/[^"']+)\.js(["'])/gu, "$1.ts$2");
      return { code: sourceImports, map: null };
    },
  };
}

export default defineConfig({
  cacheDir: ".sentinel-self-cache",
  plugins: [sourceBridge()],
  test: {
    coverage: {
      all: true,
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["json"],
      reportsDirectory: ".sentinel-self-coverage",
    },
    fileParallelism: false,
    include: [...selectedTests].map((name) => `test/${name}`),
    testTimeout: 30_000,
  },
});
