import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMutationProject } from "../dist/project.js";
import { withProjectSnapshot } from "../dist/workspace/snapshot.js";

async function baseProject(vitestConfigName = "vitest.config.mjs") {
  const project = await mkdtemp(join(tmpdir(), "sentinel-ts-project-boundary-"));
  await mkdir(join(project, "src"));
  await mkdir(join(project, "test"));
  await writeFile(join(project, "src", "value.ts"), "export const value = true;\n", "utf8");
  await writeFile(join(project, "test", "value.test.ts"), "export {};\n", "utf8");
  await writeFile(join(project, vitestConfigName), "export default {};\n", "utf8");
  return project;
}

function typescriptModule() {
  return {
    id: "web",
    language: "typescript",
    root: ".",
    production: ["src/**/*.ts"],
    testCommand: ["vitest", "--run"],
    coverage: {
      command: ["vitest", "--run", "--coverage"],
      format: "istanbul-json",
      report: "coverage/coverage-final.json",
    },
    testRoots: ["test"],
    testPatterns: ["*.test.ts"],
  };
}

async function writeConfig(project, modules) {
  await writeFile(
    join(project, "sentinel.config.json"),
    `${JSON.stringify({ specVersion: "1.0.0", modules })}\n`,
    "utf8",
  );
}

test("selects the sole TypeScript module from a polyglot project", async () => {
  const project = await baseProject();
  await writeConfig(project, [
    {
      id: "api",
      language: "python",
      root: "backend",
      production: ["app/**/*.py"],
      testRoots: ["tests"],
      testPatterns: ["test_*.py"],
    },
    typescriptModule(),
  ]);

  const loaded = await loadMutationProject(project);

  assert.equal(loaded.moduleId, "web");
});

test("does not misclassify the one approved TypeScript Vitest config as production", async () => {
  const project = await baseProject("vitest.config.ts");
  await writeConfig(project, [typescriptModule()]);

  const loaded = await loadMutationProject(project);

  assert.equal(loaded.vitestConfigFile, "vitest.config.ts");
  assert.deepEqual(loaded.productionFiles, ["src/value.ts"]);
});

test("rejects a production glob that leaves another TypeScript source unclassified", async () => {
  const project = await baseProject();
  await writeFile(join(project, "src", "omitted.ts"), "export const omitted = true;\n", "utf8");
  const module = typescriptModule();
  module.production = ["src/value.ts"];
  await writeConfig(project, [module]);

  await assert.rejects(
    () => loadMutationProject(project),
    (error) => error?.code === "unclassifiedSource",
  );
});

test("checks original protected identity even when snapshot execution throws", async () => {
  const projectRoot = await baseProject();
  await writeConfig(projectRoot, [typescriptModule()]);
  const project = await loadMutationProject(projectRoot);

  await assert.rejects(
    () => withProjectSnapshot(project, async () => {
      await writeFile(join(projectRoot, "src", "value.ts"), "export const value = false;\n", "utf8");
      throw new Error("backend failed");
    }),
    (error) => error?.code === "protectedSourceChanged",
  );
});

test("does not turn a thrown undefined backend failure into a successful snapshot", async () => {
  const projectRoot = await baseProject();
  await writeConfig(projectRoot, [typescriptModule()]);
  const project = await loadMutationProject(projectRoot);

  let resolved = false;
  try {
    await withProjectSnapshot(project, async () => {
      throw undefined;
    });
    resolved = true;
  } catch (error) {
    assert.equal(error, undefined);
  }
  assert.equal(resolved, false);
});

test("reports a missing requested module without calling it a language mismatch", async () => {
  const project = await baseProject();
  await writeConfig(project, [typescriptModule()]);

  await assert.rejects(
    () => loadMutationProject(project, undefined, "missing"),
    (error) => error?.code === "moduleNotFound",
  );
});

test("rejects a shell-like test command instead of accepting an unverified config", async () => {
  const project = await baseProject();
  const module = typescriptModule();
  module.testCommand = "vitest --run";
  await writeConfig(project, [module]);

  await assert.rejects(
    () => loadMutationProject(project),
    (error) => error?.code === "projectConfigShapeInvalid",
  );
});

test("rejects unknown coverage config fields", async () => {
  const project = await baseProject();
  const module = typescriptModule();
  module.coverage = { ...module.coverage, fallback: true };
  await writeConfig(project, [module]);

  await assert.rejects(
    () => loadMutationProject(project),
    (error) => error?.code === "projectConfigShapeInvalid",
  );
});

test("rejects a non-relative configured module root", async () => {
  const project = await baseProject();
  const module = typescriptModule();
  module.root = "../outside";
  await writeConfig(project, [module]);

  await assert.rejects(
    () => loadMutationProject(project),
    (error) => error?.code === "projectConfigShapeInvalid",
  );
});

test("rejects duplicate config keys before JSON can overwrite them", async () => {
  const moduleText = JSON.stringify(typescriptModule());
  const nestedDuplicate = moduleText.replace(
    '"production":["src/**/*.ts"]',
    '"production":["src/**/*.ts"],"production":["src/**/*.tsx"]',
  );
  const documents = [
    `{"specVersion":"1.0.0","modules":[${moduleText}],"modules":[${moduleText}]}`,
    `{"specVersion":"1.0.0","modules":[${nestedDuplicate}]}`,
    `{"specVersion":"1.0.0","modules":[${moduleText}],"mod\\u0075les":[${moduleText}]}`,
  ];

  for (const document of documents) {
    const project = await baseProject();
    await writeFile(join(project, "sentinel.config.json"), `${document}\n`, "utf8");
    await assert.rejects(
      () => loadMutationProject(project),
      (error) => error?.code === "projectConfigDuplicateKey",
    );
  }
});

test("snapshot skips generated directories and rejects late symlinks and hard links", async () => {
  const skippedRoot = await baseProject();
  await mkdir(join(skippedRoot, "coverage"));
  await writeFile(join(skippedRoot, "coverage", "ignored.txt"), "ignored", "utf8");
  await writeConfig(skippedRoot, [typescriptModule()]);
  const skippedProject = await loadMutationProject(skippedRoot);
  assert.equal(await withProjectSnapshot(skippedProject, async () => true), true);

  const symlinkRoot = await baseProject();
  await writeConfig(symlinkRoot, [typescriptModule()]);
  const symlinkProject = await loadMutationProject(symlinkRoot);
  await symlink("src/value.ts", join(symlinkRoot, "late-link.ts"));
  await assert.rejects(
    () => withProjectSnapshot(symlinkProject, async () => undefined),
    (error) => error?.code === "projectSymlinkUnsupported",
  );

  const hardlinkRoot = await baseProject();
  await writeConfig(hardlinkRoot, [typescriptModule()]);
  const hardlinkProject = await loadMutationProject(hardlinkRoot);
  await writeFile(join(hardlinkRoot, "late.txt"), "late", "utf8");
  await link(join(hardlinkRoot, "late.txt"), join(hardlinkRoot, "late-copy.txt"));
  await assert.rejects(
    () => withProjectSnapshot(hardlinkProject, async () => undefined),
    (error) => error?.code === "projectHardlinkUnsupported",
  );
});
