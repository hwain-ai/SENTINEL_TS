import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPair, runProcess } from "../dist/workspace/process.js";
import { linkDependencies } from "../dist/workspace/dependencies.js";

test("parallel starts both jobs and preserves result order", async () => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  assert.deepEqual(await runPair(async () => { await started; return "crap"; },
    async () => { release(); return "mutation"; }, "parallel"), ["crap", "mutation"]);
});

test("sequential completes the first job before starting the second", async () => {
  const order = [];
  await runPair(async () => { await Promise.resolve(); order.push(1); },
    async () => { assert.deepEqual(order, [1]); order.push(2); }, "sequential");
  assert.deepEqual(order, [1, 2]);
});

test("a failed measurement cancels and waits for the sibling process", async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let cleaned = false;
  await assert.rejects(runPair(async () => { await ready; throw new Error("failed measurement"); },
    async signal => {
      const child = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), process.env, signal);
      started();
      try { await child; } finally { cleaned = true; }
    }, "parallel"), /failed measurement/);
  assert.equal(cleaned, true);
});

test("project packages keep their versions and measurement packages stay pinned", async () => {
  const root = await mkdtemp(join(tmpdir(), "sentinel-dependencies-"));
  try {
    const tools = join(root, "tools"), project = join(root, "project"), target = join(root, "snapshot");
    for (const [folder, name, value] of [[project, "app-library", "project"], [tools, "app-library", "tool"],
      [project, "vitest", "project-runner"], [tools, "vitest", "pinned-runner"]]) {
      await mkdir(join(folder, name), { recursive: true });
      await writeFile(join(folder, name, "value"), value);
    }
    await linkDependencies(tools, target, project);
    assert.equal(await readFile(join(target, "app-library/value"), "utf8"), "project");
    assert.equal(await readFile(join(target, "vitest/value"), "utf8"), "pinned-runner");
    await mkdir(join(target, ".vite"));
    await assert.rejects(readFile(join(project, ".vite")), /ENOENT/);
    await assert.rejects(readFile(join(tools, ".vite")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
