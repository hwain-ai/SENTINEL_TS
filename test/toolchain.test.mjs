import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoots = [];

after(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { force: true, recursive: true });
  }
});

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function run(executable, commandArguments = [], options = {}) {
  return spawnSync(executable, commandArguments, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
}

async function copyLauncherRepository() {
  const fixtureRoot = await temporaryRoot("sentinel-ts-toolchain-test-");
  const scripts = join(fixtureRoot, "scripts");
  await mkdir(scripts);
  await cp(join(repositoryRoot, "toolchain.lock.json"), join(fixtureRoot, "toolchain.lock.json"));
  for (const name of ["bootstrap-node.sh", "node.sh", "npm.sh", "toolchain_lock.py"]) {
    await cp(join(repositoryRoot, "scripts", name), join(scripts, name));
  }
  return fixtureRoot;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeIsolatedLockAddFixture() {
  const fixture = await copyLauncherRepository();
  const nodeHome = join(fixture, ".toolchain", "node-v22.23.1-linux-x64");
  const nodeBinary = join(nodeHome, "bin", "node");
  const npmCli = join(nodeHome, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const tscEntry = join(fixture, "node_modules", "@typescript", "native", "lib", "tsc.js");
  const tscBinary = join(
    fixture,
    "node_modules",
    "@typescript",
    "typescript-linux-x64",
    "lib",
    "tsc",
  );
  const packageLock = join(fixture, "package-lock.json");
  await mkdir(dirname(nodeBinary), { recursive: true });
  await mkdir(dirname(npmCli), { recursive: true });
  await mkdir(dirname(tscEntry), { recursive: true });
  await mkdir(dirname(tscBinary), { recursive: true });
  await writeFile(
    nodeBinary,
    [
      "#!/bin/bash",
      "set -eu",
      "/usr/bin/printf '%s\\n' '{\"name\":\"fixture\",\"devDependencies\":{\"demo\":\"1.2.3\"}}' > package.json",
      "/usr/bin/printf '%s\\n' '{\"name\":\"fixture\",\"lockfileVersion\":3,\"packages\":{\"\":{\"devDependencies\":{\"demo\":\"1.2.3\"}},\"node_modules/demo\":{\"version\":\"1.2.3\"}}}' > package-lock.json",
      "/usr/bin/mkdir -p node_modules",
      "/usr/bin/touch node_modules/npm-ran-here",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(nodeBinary, 0o755);
  await writeFile(npmCli, "// fixture npm CLI\n", "utf8");
  await writeFile(tscEntry, "// fixture tsc entry\n", "utf8");
  await writeFile(tscBinary, "fixture tsc binary\n", "utf8");
  await chmod(tscBinary, 0o755);
  await writeFile(
    join(fixture, "package.json"),
    '{"name":"fixture","devDependencies":{}}\n',
    "utf8",
  );
  await writeFile(
    packageLock,
    '{"name":"fixture","lockfileVersion":3,"packages":{"":{"devDependencies":{}}}}\n',
    "utf8",
  );
  await writeFile(join(fixture, "node_modules", ".package-lock.json"), "{}\n", "utf8");

  for (const directory of [
    join(fixture, ".toolchain", "home"),
    join(fixture, ".toolchain", "xdg-cache"),
    join(fixture, ".toolchain", "npm-cache"),
    join(fixture, ".toolchain", "npm-config"),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  for (const name of ["user.npmrc", "global.npmrc"]) {
    const path = join(fixture, ".toolchain", "npm-config", name);
    await writeFile(path, "", { mode: 0o600 });
    await chmod(path, 0o600);
  }

  const zero = "0".repeat(64);
  const toolchain = {
    status: "locked",
    version: "22.23.1",
    npmVersion: "10.9.8",
    archiveUrl:
      "https://nodejs.org/download/release/v22.23.1/node-v22.23.1-linux-x64.tar.xz",
    archiveSize: 1,
    archiveSha256: zero,
    archiveRoot: "node-v22.23.1-linux-x64",
    installDirectory: "node-v22.23.1-linux-x64",
    binarySha256: await sha256(nodeBinary),
    npmCliSha256: await sha256(npmCli),
    versionOutput: "v22.23.1",
    npmVersionOutput: "10.9.8",
    installedTreeSha256: zero,
    dependencyTreeSha256: zero,
    packageLockSha256: await sha256(packageLock),
    tscEntrySha256: await sha256(tscEntry),
    tscBinarySha256: await sha256(tscBinary),
    emptyConfigSha256: zero.replace(/^0+$/u, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    packageTools: {
      stryker: {
        status: "locked",
        package: "@stryker-mutator/core",
        version: "10.0.0",
        integrity:
          "sha512-ZvMsRyaXQQ5e6Thcid9pkuODv6Fn9E3nrBQJUap+hcJuGJ4unm26afo3m6YKSjn8kinyxJ/3TXf0cTWRDaTxVw==",
        runnerPackage: "@stryker-mutator/vitest-runner",
        runnerVersion: "10.0.0",
        runnerIntegrity:
          "sha512-SHK2/vfvRUpiz7jXPnQMBnr6zLdm69DK03Mo5mPhaZWcRSygrKUqYsPqWsXsK+5ySHzlMTfCyFK5NQ/X9sJFFw==",
        entry: "node_modules/@stryker-mutator/core/bin/stryker.js",
        entrySha256: zero,
      },
    },
    firstPartyTools: {
      "sentinel-ts": {
        status: "locked",
        entry: "dist/cli.js",
        entrySha256: zero,
        tree: "dist",
        treeSha256: zero,
      },
    },
  };
  const lock = { repository: "SENTINEL_TS", status: "locked", toolchains: { node: toolchain } };
  const lockPath = join(fixture, "toolchain.lock.json");
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

  const printTreeDigest = (tree) => {
    const result = run("/usr/bin/python3", [
      "-I",
      join(fixture, "scripts", "toolchain_lock.py"),
      lockPath,
      "node",
      "--print-tree-digest",
      tree,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  toolchain.installedTreeSha256 = printTreeDigest(nodeHome);
  toolchain.dependencyTreeSha256 = printTreeDigest(join(fixture, "node_modules"));
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return fixture;
}

test("pins the approved Node and bundled npm release", async () => {
  const lock = JSON.parse(await readFile(join(repositoryRoot, "toolchain.lock.json"), "utf8"));
  const nodeVersion = (await readFile(join(repositoryRoot, ".node-version"), "utf8")).trim();

  assert.equal(lock.repository, "SENTINEL_TS");
  assert.equal(lock.status, "locked");
  assert.equal(nodeVersion, "22.23.1");
  assert.equal(lock.toolchains.node.version, "22.23.1");
  assert.equal(lock.toolchains.node.npmVersion, "10.9.8");
  const packageDocument = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageDocument.engines.node, "22.23.1");
  assert.equal(
    lock.toolchains.node.archiveSha256,
    "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578",
  );
  for (const key of [
    "archiveSize",
    "binarySha256",
    "npmCliSha256",
    "installedTreeSha256",
    "dependencyTreeSha256",
    "packageLockSha256",
    "tscEntrySha256",
  ]) {
    assert.ok(lock.toolchains.node[key], `missing locked field: ${key}`);
  }
});

test("runs only the repository Node, bundled npm, and pinned TypeScript entry", () => {
  const node = run(join(repositoryRoot, "scripts", "node.sh"), ["--version"]);
  const npm = run(join(repositoryRoot, "scripts", "npm.sh"), ["--version"]);
  const tsc = run(join(repositoryRoot, "scripts", "node.sh"), [
    "--tool",
    "tsc",
    "--",
    "--version",
  ]);

  assert.equal(node.status, 0, node.stderr);
  assert.equal(node.stdout.trim(), "v22.23.1");
  assert.equal(npm.status, 0, npm.stderr);
  assert.equal(npm.stdout.trim(), "10.9.8");
  assert.equal(tsc.status, 0, tsc.stderr);
  assert.equal(tsc.stdout.trim(), "Version 7.0.2");
});

test("runs only the exact locked StrykerJS package and entry", async () => {
  const lock = JSON.parse(await readFile(join(repositoryRoot, "toolchain.lock.json"), "utf8"));
  const strykerLock = lock.toolchains.node.packageTools.stryker;
  assert.deepEqual(
    {
      package: strykerLock.package,
      version: strykerLock.version,
      integrity: strykerLock.integrity,
      runnerPackage: strykerLock.runnerPackage,
      runnerVersion: strykerLock.runnerVersion,
      runnerIntegrity: strykerLock.runnerIntegrity,
      entry: strykerLock.entry,
      entrySha256: strykerLock.entrySha256,
    },
    {
      package: "@stryker-mutator/core",
      version: "10.0.0",
      integrity:
        "sha512-ZvMsRyaXQQ5e6Thcid9pkuODv6Fn9E3nrBQJUap+hcJuGJ4unm26afo3m6YKSjn8kinyxJ/3TXf0cTWRDaTxVw==",
      runnerPackage: "@stryker-mutator/vitest-runner",
      runnerVersion: "10.0.0",
      runnerIntegrity:
        "sha512-SHK2/vfvRUpiz7jXPnQMBnr6zLdm69DK03Mo5mPhaZWcRSygrKUqYsPqWsXsK+5ySHzlMTfCyFK5NQ/X9sJFFw==",
      entry: "node_modules/@stryker-mutator/core/bin/stryker.js",
      entrySha256: "68ff1362368a0cf3d26c4b76955667dff7bf08baffc68d2ffd9bdd0cf6dbbd89",
    },
  );

  const version = run(join(repositoryRoot, "scripts", "node.sh"), [
    "--tool",
    "stryker",
    "--",
    "--version",
  ]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "10.0.0");
  const scratchMode = run("/usr/bin/stat", [
    "-c",
    "%F:%a",
    join(repositoryRoot, "node_modules", ".vite-temp"),
  ]);
  assert.equal(scratchMode.status, 0, scratchMode.stderr);
  assert.equal(scratchMode.stdout.trim(), "directory:700");
});

test("pins the approved Koffi package and Linux x64 native dispatch", async () => {
  const packageDocument = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  assert.equal(packageDocument.dependencies.koffi, "3.1.6");
  assert.deepEqual(
    {
      integrity: packageLock.packages["node_modules/koffi"].integrity,
      version: packageLock.packages["node_modules/koffi"].version,
    },
    {
      integrity: "sha512-ln60chEb3o7Du1ayjwl6BFiNN1wZK+3cTM2wWGiHLEzCY/FdTIN1ER5VWDwHq7J/j4tSnnrHaH5ABS1EO6+6ag==",
      version: "3.1.6",
    },
  );
  assert.deepEqual(
    {
      integrity: packageLock.packages["node_modules/@koromix/koffi-linux-x64"].integrity,
      version: packageLock.packages["node_modules/@koromix/koffi-linux-x64"].version,
    },
    {
      integrity: "sha512-Xx5mpr9VcaMCXfvbqIiLIWIL9Iuu6F4r3iMXg7+zZCqYUFZPFwJgiDQBLxctHv2OYgIfAoaaHMW0GC1cJkHfbA==",
      version: "3.1.6",
    },
  );
  assert.equal(
    await sha256(join(
      repositoryRoot,
      "node_modules",
      "@koromix",
      "koffi-linux-x64",
      "linux_x64",
      "koffi.node",
    )),
    "71a9865da872e6750e4b386611a325756b2947936df58ee8b54ef9a11b92abf0",
  );
});

test("runs the first-party CLI only from the exact locked dist tree", async () => {
  const lock = JSON.parse(await readFile(join(repositoryRoot, "toolchain.lock.json"), "utf8"));
  assert.deepEqual(lock.toolchains.node.firstPartyTools["sentinel-ts"], {
    status: "locked",
    entry: "dist/cli.js",
    entrySha256: "4d7b51cc09786d500a4e61282509c928b0b513c506f41e31df64d678d725ae85",
    tree: "dist",
    treeSha256: "c662a560a1c940cdc01e8499c18a974f6ba46e5ef2206f96964b50c28bd7ae0b",
  });

  const help = run(join(repositoryRoot, "scripts", "node.sh"), [
    "--entry",
    "sentinel-ts",
    "--",
    "--help",
  ]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /crap.*mutation.*check.*doctor.*history/su);
});

test("removes hostile runtime, loader, proxy, and npm configuration variables", async () => {
  const hostileRoot = await temporaryRoot("sentinel-ts-hostile-path-");
  const canary = join(hostileRoot, "executed");
  const fakeNode = join(hostileRoot, "node");
  const bashEnvironment = join(hostileRoot, "bash-environment.sh");
  await writeFile(fakeNode, `#!/bin/sh\ntouch '${canary}'\nexit 97\n`, "utf8");
  await writeFile(bashEnvironment, `touch '${canary}'\n`, "utf8");
  await chmod(fakeNode, 0o755);

  const probe = run(
    join(repositoryRoot, "scripts", "node.sh"),
    [
      "--test",
      "test/fixtures/toolchain/environment-probe.test.mjs",
    ],
    {
      env: {
        ...process.env,
        PATH: hostileRoot,
        BASH_ENV: bashEnvironment,
        NODE_OPTIONS: `--require=${join(hostileRoot, "missing.cjs")}`,
        NODE_PATH: hostileRoot,
        HTTPS_PROXY: "http://127.0.0.1:1",
        NPM_CONFIG_REGISTRY: "https://example.invalid/",
      },
    },
  );

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(run("/usr/bin/test", ["!", "-e", canary]).status, 0);
});

test("rejects arbitrary Node evaluation before Node starts", async () => {
  const temporary = await temporaryRoot("sentinel-ts-node-eval-");
  const canary = join(temporary, "evaluated");
  const result = run(join(repositoryRoot, "scripts", "node.sh"), [
    "-e",
    `require('node:fs').writeFileSync('${canary}', '')`,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported Node mode/u);
  assert.equal(run("/usr/bin/test", ["!", "-e", canary]).status, 0);
});

test("rejects a pending lock before any selected Node process starts", async () => {
  const fixture = await copyLauncherRepository();
  const lockPath = join(fixture, "toolchain.lock.json");
  const lock = (await readFile(lockPath, "utf8")).replace(
    '"status": "locked"',
    '"status": "bootstrap-pending"',
  );
  await writeFile(lockPath, lock, "utf8");

  const nodeDirectory = join(fixture, ".toolchain", "node-v22.23.1", "bin");
  const canary = join(fixture, "node-started");
  await mkdir(nodeDirectory, { recursive: true });
  await writeFile(join(nodeDirectory, "node"), `#!/bin/sh\ntouch '${canary}'\n`, "utf8");
  await chmod(join(nodeDirectory, "node"), 0o755);

  const result = run(join(fixture, "scripts", "node.sh"), ["--version"], { cwd: fixture });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /toolchain is pending/u);
  assert.equal(run("/usr/bin/test", ["!", "-e", canary]).status, 0);
});

test("rejects duplicate lock keys and installed-tree symlink escapes", async () => {
  const fixture = await copyLauncherRepository();
  const lockPath = join(fixture, "toolchain.lock.json");
  const duplicateLock = (await readFile(lockPath, "utf8")).replace(
    '"repository": "SENTINEL_TS",',
    '"repository": "SENTINEL_TS",\n  "repository": "SENTINEL_TS",',
  );
  await writeFile(lockPath, duplicateLock, "utf8");
  const duplicate = run("/usr/bin/python3", [
    "-I",
    join(fixture, "scripts", "toolchain_lock.py"),
    lockPath,
    "node",
    "--require-locked",
  ]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /duplicate/u);

  const tree = join(fixture, "tree");
  await mkdir(tree);
  await symlink("../outside", join(tree, "escape"));
  const escaped = run("/usr/bin/python3", [
    "-I",
    join(fixture, "scripts", "toolchain_lock.py"),
    join(repositoryRoot, "toolchain.lock.json"),
    "node",
    "--print-tree-digest",
    tree,
  ]);
  assert.equal(escaped.status, 2);
  assert.match(escaped.stderr, /escapes its root/u);
});

test("rejects version text that disagrees with the selected releases", async () => {
  for (const [field, approved, changed] of [
    ["versionOutput", "v22.23.1", "v22.23.0"],
    ["npmVersionOutput", "10.9.8", "10.9.7"],
  ]) {
    const fixture = await copyLauncherRepository();
    const lockPath = join(fixture, "toolchain.lock.json");
    const lock = (await readFile(lockPath, "utf8")).replace(
      `"${field}": "${approved}"`,
      `"${field}": "${changed}"`,
    );
    await writeFile(lockPath, lock, "utf8");

    const result = run("/usr/bin/python3", [
      "-I",
      join(fixture, "scripts", "toolchain_lock.py"),
      lockPath,
      "node",
      "--require-locked",
    ]);
    assert.equal(result.status, 2, field);
    assert.match(result.stderr, /version output does not match/u, field);
  }
});

test("rejects a malformed archive URL without a Python traceback", async () => {
  for (const malformedHost of ["nodejs.org:not-a-port", "[nodejs.org"]) {
    const fixture = await copyLauncherRepository();
    const lockPath = join(fixture, "toolchain.lock.json");
    const lock = (await readFile(lockPath, "utf8")).replace(
      "https://nodejs.org/download/",
      `https://${malformedHost}/download/`,
    );
    await writeFile(lockPath, lock, "utf8");

    const result = run("/usr/bin/python3", [
      "-I",
      join(fixture, "scripts", "toolchain_lock.py"),
      lockPath,
      "node",
      "--require-locked",
    ]);

    assert.equal(result.status, 2, malformedHost);
    assert.match(result.stderr, /archive URL/u, malformedHost);
    assert.doesNotMatch(result.stderr, /Traceback/u, malformedHost);
  }
});

test("rejects project npm configuration and unsupported npm commands before npm starts", async () => {
  const fixture = await copyLauncherRepository();
  await writeFile(join(fixture, ".npmrc"), "registry=https://example.invalid/\n", "utf8");

  const configured = run(join(fixture, "scripts", "npm.sh"), ["--version"], {
    cwd: fixture,
  });
  assert.equal(configured.status, 2);
  assert.match(configured.stderr, /repository npm configuration is not allowed/u);

  const cleanFixture = await copyLauncherRepository();
  const unsupported = run(join(cleanFixture, "scripts", "npm.sh"), ["run", "build"], {
    cwd: cleanFixture,
  });
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /unsupported npm command/u);
});

test("accepts only exact and single-role dependency lock additions", async () => {
  const fixture = await copyLauncherRepository();
  const npm = join(fixture, "scripts", "npm.sh");
  const roleless = run(npm, ["lock-add-exact", "@stryker-mutator/core@10.0.0"], {
    cwd: fixture,
  });
  const ranged = run(npm, ["lock-add-exact", "--dev", "@stryker-mutator/core@^10.0.0"], {
    cwd: fixture,
  });
  const mixed = run(npm, [
    "lock-add-exact",
    "--dev",
    "@stryker-mutator/core@10.0.0",
    "--prod",
    "vitest@4.1.11",
  ], { cwd: fixture });

  assert.equal(roleless.status, 2);
  assert.match(roleless.stderr, /requires --prod or --dev/u);
  assert.equal(ranged.status, 2);
  assert.match(ranged.stderr, /exact package version/u);
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /single dependency role/u);

  await writeFile(join(fixture, ".npmrc"), "registry=https://example.invalid/\n", "utf8");
  const validGrammar = run(npm, [
    "lock-add-exact",
    "--dev",
    "@stryker-mutator/core@10.0.0",
    "@stryker-mutator/vitest-runner@10.0.0",
  ], { cwd: fixture });
  assert.equal(validGrammar.status, 2);
  assert.match(validGrammar.stderr, /repository npm configuration is not allowed/u);
});

test("creates dependency lock updates outside the installed dependency tree", async () => {
  const fixture = await writeIsolatedLockAddFixture();
  const result = run(join(fixture, "scripts", "npm.sh"), [
    "lock-add-exact",
    "--dev",
    "demo@1.2.3",
  ], { cwd: fixture });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(run("/usr/bin/test", ["!", "-e", join(fixture, "node_modules", "npm-ran-here")]).status, 0);
  const packageDocument = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
  const lockDocument = JSON.parse(await readFile(join(fixture, "package-lock.json"), "utf8"));
  assert.equal(packageDocument.devDependencies.demo, "1.2.3");
  assert.equal(lockDocument.packages["node_modules/demo"].version, "1.2.3");
});

test("rejects a changed package lock before npm starts", async () => {
  const fixture = await copyLauncherRepository();
  const packageLock = await readFile(join(repositoryRoot, "package-lock.json"), "utf8");
  await writeFile(join(fixture, "package-lock.json"), `${packageLock}\n`, "utf8");
  const nodeDirectory = join(fixture, ".toolchain", "node-v22.23.1-linux-x64", "bin");
  const canary = join(fixture, "npm-started");
  await mkdir(nodeDirectory, { recursive: true });
  await writeFile(join(nodeDirectory, "node"), `#!/bin/sh\ntouch '${canary}'\n`, "utf8");
  await chmod(join(nodeDirectory, "node"), 0o755);

  const result = run(join(fixture, "scripts", "npm.sh"), ["ci", "--offline"], {
    cwd: fixture,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /package-lock\.json checksum mismatch/u);
  assert.equal(run("/usr/bin/test", ["!", "-e", canary]).status, 0);
});

test("requires an explicit separator and known name for package tools", async () => {
  const fixture = await copyLauncherRepository();
  const missingSeparator = run(join(fixture, "scripts", "node.sh"), [
    "--tool",
    "tsc",
    "--version",
  ]);
  const unknownTool = run(join(fixture, "scripts", "node.sh"), [
    "--tool",
    "unknown",
    "--",
    "--version",
  ]);
  const emptyArguments = run(join(fixture, "scripts", "node.sh"), [
    "--tool",
    "tsc",
    "--",
  ]);

  assert.equal(missingSeparator.status, 2);
  assert.match(missingSeparator.stderr, /requires -- separator/u);
  assert.equal(unknownTool.status, 2);
  assert.match(unknownTool.stderr, /unknown package tool/u);
  assert.equal(emptyArguments.status, 2);
  assert.match(emptyArguments.stderr, /requires at least one argument/u);
});

test("bootstrap is idempotent once the verified archive is installed", () => {
  const first = run(join(repositoryRoot, "scripts", "bootstrap-node.sh"));
  const second = run(join(repositoryRoot, "scripts", "bootstrap-node.sh"));

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
});

test("fails closed when another bootstrap owns the installation lock", async () => {
  const lockDirectory = join(repositoryRoot, ".toolchain", "bootstrap-node.lock");
  await mkdir(lockDirectory);
  try {
    const result = run(join(repositoryRoot, "scripts", "bootstrap-node.sh"));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /another Node bootstrap is active/u);
  } finally {
    await rmdir(lockDirectory);
  }
});
