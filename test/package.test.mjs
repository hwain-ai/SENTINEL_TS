import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const analyzerSource = await readFile(new URL("../src/crap.ts", import.meta.url), "utf8");

test("builds before packing and imports the exact runtime AST alias directly", () => {
  assert.equal(
    packageJson.scripts.prepack,
    "./scripts/node.sh --tool tsc -- -p tsconfig.json",
  );
  assert.equal(
    packageJson.scripts.build,
    "./scripts/node.sh --tool tsc -- -p tsconfig.json",
  );
  assert.equal(packageJson.scripts.test, "./scripts/node.sh --test test/*.test.mjs");
  assert.equal(packageJson.engines.node, "22.23.1");
  assert.equal(packageJson.dependencies["@typescript/old"], "npm:typescript@6.0.3");
  assert.equal(packageJson.dependencies.typescript, undefined);
  assert.equal(packageJson.exports["./mutation"], "./dist/mutation/index.js");
  assert.equal(packageJson.exports["./history"], "./dist/history.js");
  assert.equal(packageJson.exports["./evidence"], "./dist/evidence/contract.js");
  assert.match(analyzerSource, /from "@typescript\/old";/u);
  assert.doesNotMatch(analyzerSource, /from "typescript";/u);
});

async function runWithTamperedAst(tamper) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sentinel-ts-override-test-"));
  try {
    const packageRoot = join(
      temporaryRoot,
      "node_modules",
      "@hwain-hwang",
      "sentinel-ts",
    );
    const astRoot = join(packageRoot, "node_modules", "@typescript", "old");
    await mkdir(packageRoot, { recursive: true });
    await cp(new URL("../dist", import.meta.url), join(packageRoot, "dist"), {
      recursive: true,
    });
    await cp(new URL("../package.json", import.meta.url), join(packageRoot, "package.json"));
    await cp(new URL("../node_modules/@typescript/old", import.meta.url), astRoot, {
      recursive: true,
    });
    const astPackagePath = join(astRoot, "package.json");
    const astPackage = JSON.parse(await readFile(astPackagePath, "utf8"));
    const astImplementationPath = join(astRoot, "lib", "typescript.js");
    const astImplementation = await readFile(astImplementationPath, "utf8");
    assert.match(astImplementation, /var version = "6\.0\.3";/u);
    if (tamper === "version") {
      astPackage.version = "6.0.2";
      await writeFile(astPackagePath, `${JSON.stringify(astPackage, null, 2)}\n`, "utf8");
    }
    const changedImplementation = tamper === "version"
      ? astImplementation.replace('var version = "6.0.3";', 'var version = "6.0.2";')
      : `${astImplementation}\n`;
    await writeFile(
      astImplementationPath,
      changedImplementation,
      "utf8",
    );
    const entrypoint = join(temporaryRoot, "consumer.mjs");
    await writeFile(
      entrypoint,
      [
        'import { analyzeTypeScript } from "@hwain-hwang/sentinel-ts/crap";',
        "try {",
        '  analyzeTypeScript("function valid() {}", "src/valid.ts");',
        "} catch (error) {",
        "  console.error(error?.code ?? error);",
        "  process.exit(23);",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, [entrypoint], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("fails closed before parsing when a consumer replaces the runtime AST", async () => {
  for (const tamper of ["implementation digest", "version"]) {
    const result = await runWithTamperedAst(tamper);
    assert.equal(result.status, 23, `${tamper}: ${result.stderr}`);
    assert.match(result.stderr, /typescriptAstIdentityMismatch/u, tamper);
  }
});
