import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MutationProtocolError, compareUtf8 } from "../mutation/protocol.js";
import type { MutationProject } from "../project.js";

const OMITTED_DIRECTORIES = new Set([
  ".git",
  ".sentinel",
  ".sentinel-runtime",
  ".stryker-tmp",
  "coverage",
  "dist",
  "node_modules",
  "reports",
]);

interface ProtectedIdentity {
  readonly path: string;
  readonly digest: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modifiedNanos: bigint;
  readonly changedNanos: bigint;
}

export interface ProjectSnapshot {
  readonly selectedCallables?: readonly import("../crap.js").CallableRecord[];
  readonly root: string;
  readonly productionFiles: readonly string[];
  readonly testFiles: readonly string[];
  readonly vitestConfigFile: string | null;
  readonly snapshotFiles: readonly string[];
}

function requireProtectedFile(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.nlink !== 1n) {
    throw new MutationProtocolError("protectedSourceInvalid", "protected source must be a single-link regular file");
  }
}

function sameFileStat(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function protectedIdentity(root: string, relative: string): Promise<ProtectedIdentity> {
  const filePath = path.join(root, relative);
  const before = await stat(filePath, { bigint: true });
  requireProtectedFile(before);
  const bytes = await readFile(filePath);
  const after = await stat(filePath, { bigint: true });
  if (!sameFileStat(before, after)) {
    throw new MutationProtocolError("protectedSourceChanged", "protected source changed while it was read");
  }
  return {
    path: relative,
    digest: createHash("sha256").update(bytes).digest("hex"),
    device: before.dev,
    inode: before.ino,
    mode: before.mode,
    size: before.size,
    modifiedNanos: before.mtimeNs,
    changedNanos: before.ctimeNs,
  };
}

async function protectedInventory(project: MutationProject): Promise<readonly ProtectedIdentity[]> {
  const values = await Promise.all(
    project.protectedFiles.map((relative) => protectedIdentity(project.moduleRoot, relative)),
  );
  return values.sort((left, right) => compareUtf8(left.path, right.path));
}

function sameIdentity(left: ProtectedIdentity, right: ProtectedIdentity): boolean {
  return (
    left.path === right.path &&
    left.digest === right.digest &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedNanos === right.modifiedNanos &&
    left.changedNanos === right.changedNanos
  );
}

async function assertOriginalUnchanged(
  project: MutationProject,
  expected: readonly ProtectedIdentity[],
): Promise<void> {
  const actual = await protectedInventory(project);
  if (actual.length !== expected.length || actual.some((value, index) => !sameIdentity(value, expected[index] as ProtectedIdentity))) {
    throw new MutationProtocolError("protectedSourceChanged", "original protected inventory changed during mutation");
  }
}

function requireRegularSnapshotEntry(entry: Dirent): void {
  if (!entry.isFile()) {
    throw new MutationProtocolError("projectFileTypeUnsupported", "snapshot input must contain only regular files");
  }
}

function requireIndependentSnapshotFile(metadata: Stats): void {
  if (metadata.nlink !== 1) {
    throw new MutationProtocolError("projectHardlinkUnsupported", "snapshot input must not contain hard links");
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    if (entry.isDirectory() && OMITTED_DIRECTORIES.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new MutationProtocolError("projectSymlinkUnsupported", "snapshot input must not contain symlinks");
    }
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath);
      continue;
    }
    requireRegularSnapshotEntry(entry);
    const metadata = await lstat(sourcePath);
    requireIndependentSnapshotFile(metadata);
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    await chmod(destinationPath, metadata.mode & 0o777);
  }
}

async function assertSnapshotMatches(
  root: string,
  expected: readonly ProtectedIdentity[],
): Promise<void> {
  for (const identity of expected) {
    const bytes = await readFile(path.join(root, identity.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== identity.digest) {
      throw new MutationProtocolError("snapshotDigestMismatch", "snapshot bytes differ from the protected source");
    }
  }
}

export async function withProjectSnapshot<T>(
  project: MutationProject,
  action: (snapshot: ProjectSnapshot) => Promise<T>,
): Promise<T> {
  const original = await protectedInventory(project);
  // Vitest and Stryker report real paths; a snapshot under a symlinked temp root (macOS /var) must match them.
  const temporaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), "sentinel-ts-snapshot-")));
  await chmod(temporaryRoot, 0o700);
  const snapshotRoot = path.join(temporaryRoot, "project");
  try {
    await copyTree(project.moduleRoot, snapshotRoot);
    await assertSnapshotMatches(snapshotRoot, original);
    let result!: T;
    let completed = false;
    let failure: unknown;
    try {
      result = await action({
        root: snapshotRoot,
        productionFiles: project.productionFiles,
        ...(project.selectedCallables === undefined ? {} : { selectedCallables: project.selectedCallables }),
        testFiles: project.testFiles,
        vitestConfigFile: project.vitestConfigFile,
        snapshotFiles: project.snapshotFiles,
      });
      await assertSnapshotMatches(snapshotRoot, original);
      completed = true;
    } catch (error) {
      failure = error;
    }
    await assertOriginalUnchanged(project, original);
    if (!completed) throw failure;
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
