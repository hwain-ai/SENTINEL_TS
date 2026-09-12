import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { inspectStrykerRuntime, requireStrykerRuntime } from "../dist/mutation/runtime.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sentinel-runtime-inspection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(new URL("../toolchain.lock.json", import.meta.url), "utf8"));
  const node = original.toolchains.node;
  const backend = node.packageTools.stryker;
  const entry = "throw new Error('doctor must never execute backend code');\n";
  backend.entrySha256 = createHash("sha256").update(entry).digest("hex");
  const files = {
    "toolchain.lock.json": original,
    "node_modules/@stryker-mutator/core/package.json": { name: backend.package, version: backend.version },
    "node_modules/@stryker-mutator/vitest-runner/package.json": { name: backend.runnerPackage, version: backend.runnerVersion },
    "runtime/lib/node_modules/npm/package.json": { name: "npm", version: node.npmVersion },
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), JSON.stringify(content));
  }
  await mkdir(dirname(join(root, backend.entry)), { recursive: true });
  await writeFile(join(root, backend.entry), entry);
  return { root, runtime: { version: node.version, executable: join(root, "runtime/bin/node") } };
}

test("doctor reads installed versions without executing packages or writing project state", async (t) => {
  const { root, runtime } = await fixture(t);
  const before = await readdir(root, { recursive: true });
  const result = await inspectStrykerRuntime(root, runtime);
  assert.equal(result.status, "ready");
  assert.equal(result.node, runtime.version);
  assert.deepEqual(result.diagnostics, []);
  await requireStrykerRuntime(root, runtime);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});

test("missing Stryker is unavailable and cannot enter mutation execution", async (t) => {
  const { root, runtime } = await fixture(t);
  await rm(join(root, "node_modules/@stryker-mutator/core/package.json"));
  const result = await inspectStrykerRuntime(root, runtime);
  assert.equal(result.status, "unavailable");
  assert.equal(result.stryker, null);
  assert.ok(result.diagnostics.some((item) => item.component === "stryker" && item.code === "dependencyMissing"));
  await assert.rejects(requireStrykerRuntime(root, runtime), (error) => error.code === "strykerRuntimeUnavailable");
});

test("an installed runner version different from the lock is reported, not replaced with the expected version", async (t) => {
  const { root, runtime } = await fixture(t);
  await writeFile(join(root, "node_modules/@stryker-mutator/vitest-runner/package.json"), JSON.stringify({
    name: "@stryker-mutator/vitest-runner", version: "9.0.0",
  }));
  const result = await inspectStrykerRuntime(root, runtime);
  assert.equal(result.status, "unavailable");
  assert.equal(result.vitestRunner, "9.0.0");
  assert.ok(result.diagnostics.some((item) => item.code === "dependencyVersionMismatch"));
});

test("matching version text does not hide changed backend entry bytes", async (t) => {
  const { root, runtime } = await fixture(t);
  await writeFile(join(root, "node_modules/@stryker-mutator/core/bin/stryker.js"), "changed\n");
  const result = await inspectStrykerRuntime(root, runtime);
  assert.equal(result.status, "unavailable");
  assert.ok(result.diagnostics.some((item) => item.code === "dependencyArtifactMismatch"));
});

test("doctor reports the actual unsupported Node version", async (t) => {
  const { root, runtime } = await fixture(t);
  const result = await inspectStrykerRuntime(root, { ...runtime, version: "20.0.0" });
  assert.equal(result.node, "20.0.0");
  assert.equal(result.status, "unavailable");
  assert.ok(result.diagnostics.some((item) => item.component === "node"));
});

test("malformed dependency metadata and missing lock fail explicitly", async (t) => {
  const { root, runtime } = await fixture(t);
  await writeFile(join(root, "node_modules/@stryker-mutator/core/package.json"), "{");
  const malformed = await inspectStrykerRuntime(root, runtime);
  assert.equal(malformed.status, "unavailable");
  assert.ok(malformed.diagnostics.some((item) => item.code === "dependencyManifestInvalid"));
  await rm(join(root, "toolchain.lock.json"));
  const missing = await inspectStrykerRuntime(root, runtime);
  assert.equal(missing.status, "unavailable");
  assert.ok(missing.diagnostics.some((item) => item.code === "runtimeLockInvalid"));
});

test("an unapproved Node toolchain cannot be reported as ready", async (t) => {
  const { root, runtime } = await fixture(t);
  const lockPath = join(root, "toolchain.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.toolchains.node.status = "pending";
  await writeFile(lockPath, JSON.stringify(lock));
  const result = await inspectStrykerRuntime(root, runtime);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.diagnostics, [{ component: "lock", code: "runtimeLockInvalid" }]);
});

test("unsupported backend identities and invalid exact versions fail closed", async (t) => {
  const { root, runtime } = await fixture(t);
  const lockPath = join(root, "toolchain.lock.json");
  const original = await readFile(lockPath, "utf8");
  const changes = [
    (lock) => { lock.repository = "other"; },
    (lock) => { lock.toolchains = []; },
    (lock) => { lock.toolchains.node.packageTools.stryker.package = "other"; },
    (lock) => { lock.toolchains.node.packageTools.stryker.runnerVersion = "9.0.0"; },
    (lock) => { lock.toolchains.node.packageTools.stryker.entrySha256 = "invalid"; },
    (lock) => { lock.toolchains.node.version = "latest"; },
  ];
  for (const change of changes) {
    const lock = JSON.parse(original);
    change(lock);
    await writeFile(lockPath, JSON.stringify(lock));
    assert.equal((await inspectStrykerRuntime(root, runtime)).status, "unavailable");
  }
});

test("a different package identity and a directory in place of its entry are rejected", async (t) => {
  const { root, runtime } = await fixture(t);
  await writeFile(join(root, "node_modules/@stryker-mutator/core/package.json"), JSON.stringify({
    name: "other", version: "10.0.0",
  }));
  const entry = join(root, "node_modules/@stryker-mutator/core/bin/stryker.js");
  await rm(entry);
  await mkdir(entry);
  const result = await inspectStrykerRuntime(root, runtime);
  assert.equal(result.status, "unavailable");
  assert.ok(result.diagnostics.some((item) => item.code === "dependencyIdentityMismatch"));
  assert.ok(result.diagnostics.some((item) => item.component === "strykerEntry" && item.code === "dependencyManifestInvalid"));
});
