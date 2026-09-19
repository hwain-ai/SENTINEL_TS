import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("installed CLI version rejects missing Stryker without creating project files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sentinel-version-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../dist", import.meta.url), join(root, "dist"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(root, "package.json"));
  await cp(new URL("../toolchain.lock.json", import.meta.url), join(root, "toolchain.lock.json"));
  await mkdir(join(root, "node_modules/@typescript"), { recursive: true });
  for (const dependency of ["@typescript/old", "koffi"]) {
    await symlink(fileURLToPath(new URL(`../node_modules/${dependency}`, import.meta.url)),
      join(root, "node_modules", dependency), "dir");
  }
  const before = await readdir(root, { recursive: true });
  const result = spawnSync(process.execPath, [join(root, "dist/cli.js"), "version"], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "unavailable");
  assert.equal(report.stryker, null);
  assert.ok(report.diagnostics.some((item) => item.code === "dependencyMissing"));
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});
