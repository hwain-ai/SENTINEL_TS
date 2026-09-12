import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  posixFcntlAbi,
  withPosixCommitLock,
} from "../dist/evidence/fcntl-lock.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workerPath = join(repositoryRoot, "test", "fixtures", "evidence-lock-worker.mjs");
const temporaryRoots = [];

after(async () => {
  for (const root of temporaryRoots) await rm(root, { force: true, recursive: true });
});

async function privateStateRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function lockWorker(stateRoot, mode, holdMilliseconds, timeoutMilliseconds) {
  const child = spawn(process.execPath, [
    workerPath,
    stateRoot,
    mode,
    String(holdMilliseconds),
    String(timeoutMilliseconds),
  ], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ signal, status, stderr, stdout }));
  });
  return { child, completion, output: () => stdout };
}

async function waitForOutput(worker, expected) {
  const deadline = Date.now() + 2_000;
  while (!worker.output().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`worker did not write ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("uses the approved Linux x64 struct flock ABI", () => {
  assert.deepEqual(posixFcntlAbi(), {
    alignment: 8,
    offsets: {
      l_len: 16,
      l_pid: 24,
      l_start: 8,
      l_type: 0,
      l_whence: 2,
    },
    size: 32,
  });
});

test("fails closed for a missing or non-private commit lock", async () => {
  const stateRoot = await privateStateRoot("sentinel-ts-fcntl-unsafe-");
  await assert.rejects(
    () => withPosixCommitLock(stateRoot, "shared", () => undefined),
    (error) => error?.code === "commitLockMissing",
  );
  await writeFile(join(stateRoot, "commit.lock"), "", { mode: 0o644 });
  await chmod(join(stateRoot, "commit.lock"), 0o644);
  await assert.rejects(
    () => withPosixCommitLock(stateRoot, "exclusive", () => undefined, { create: true }),
    (error) => error?.code === "unsafeCommitLock",
  );
});

test("rejects an invalid monotonic timeout before creating a lock file", async () => {
  const stateRoot = await privateStateRoot("sentinel-ts-fcntl-timeout-");
  await assert.rejects(
    () => withPosixCommitLock(stateRoot, "exclusive", () => undefined, {
      create: true,
      timeoutMilliseconds: -1,
    }),
    (error) => error?.code === "commitLockTimeoutInvalid",
  );
  await assert.rejects(() => stat(join(stateRoot, "commit.lock")), { code: "ENOENT" });
});

test("serializes exclusive commit locks across Node processes", async () => {
  const stateRoot = await privateStateRoot("sentinel-ts-fcntl-exclusive-");
  const owner = lockWorker(stateRoot, "exclusive", 500, 1_000);
  await waitForOutput(owner, "locked\n");

  await assert.rejects(
    () => withPosixCommitLock(stateRoot, "exclusive", () => undefined, {
      timeoutMilliseconds: 80,
    }),
    (error) => error?.code === "commitLockTimeout",
  );
  assert.deepEqual(await owner.completion, {
    signal: null,
    status: 0,
    stderr: "",
    stdout: "locked\nreleased\n",
  });

  await assert.doesNotReject(() => withPosixCommitLock(
    stateRoot,
    "exclusive",
    () => undefined,
    { timeoutMilliseconds: 200 },
  ));
  const lockMetadata = await stat(join(stateRoot, "commit.lock"));
  assert.equal(lockMetadata.mode & 0o777, 0o600);
  assert.equal(lockMetadata.size, 0);
});

test("allows concurrent shared history locks", async () => {
  const stateRoot = await privateStateRoot("sentinel-ts-fcntl-shared-");
  const owner = lockWorker(stateRoot, "shared", 500, 1_000);
  await waitForOutput(owner, "locked\n");

  await assert.doesNotReject(() => withPosixCommitLock(
    stateRoot,
    "shared",
    () => undefined,
    { timeoutMilliseconds: 80 },
  ));
  assert.equal((await owner.completion).status, 0);
});

test("uses the same POSIX record-lock namespace as Python", async () => {
  const stateRoot = await privateStateRoot("sentinel-ts-fcntl-python-");
  await withPosixCommitLock(stateRoot, "exclusive", () => {
    const contender = spawnSync("/usr/bin/python3", [
      "-I",
      "-c",
      [
        "import fcntl, os, sys",
        "fd = os.open(sys.argv[1], os.O_RDWR)",
        "try:",
        "    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, 0, os.SEEK_SET)",
        "except BlockingIOError:",
        "    raise SystemExit(0)",
        "raise SystemExit(31)",
      ].join("\n"),
      join(stateRoot, "commit.lock"),
    ], { encoding: "utf8" });
    assert.equal(contender.status, 0, contender.stderr);
  }, { create: true });
});

test("releases a commit lock when its owner process is killed", async () => {
  const stateRoot = await privateStateRoot("sentinel-ts-fcntl-crash-");
  const owner = lockWorker(stateRoot, "exclusive", 10_000, 1_000);
  await waitForOutput(owner, "locked\n");
  owner.child.kill("SIGKILL");
  const killed = await owner.completion;
  assert.equal(killed.signal, "SIGKILL");

  await assert.doesNotReject(() => withPosixCommitLock(
    stateRoot,
    "exclusive",
    () => undefined,
    { timeoutMilliseconds: 500 },
  ));
});
