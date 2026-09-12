import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import koffi from "koffi";

import { EvidenceContractError } from "./contract.js";

const F_SETLK = 6;
const F_RDLCK = 0;
const F_WRLCK = 1;
const SEEK_SET = 0;
const LOCK_START = 0n;
const LOCK_LENGTH = 1n;
const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;
const RETRY_MILLISECONDS = 10;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

const Flock = koffi.struct({
  l_type: "int16_t",
  l_whence: "int16_t",
  l_start: "int64_t",
  l_len: "int64_t",
  l_pid: "int32_t",
});

type Fcntl = (descriptor: number, command: number, lock: FlockValue) => number;

interface FlockValue {
  l_type: number;
  l_whence: number;
  l_start: bigint;
  l_len: bigint;
  l_pid: number;
}

export type CommitLockMode = "shared" | "exclusive";

export interface CommitLockOptions {
  readonly create?: boolean;
  readonly timeoutMilliseconds?: number;
}

let fcntlFunction: Fcntl | null = null;

function memberOffset(name: keyof FlockValue): number {
  return Flock.members?.[name]?.offset ?? -1;
}

export function posixFcntlAbi(): {
  readonly alignment: number;
  readonly offsets: Readonly<Record<keyof FlockValue, number>>;
  readonly size: number;
} {
  return {
    alignment: Flock.alignment,
    offsets: {
      l_len: memberOffset("l_len"),
      l_pid: memberOffset("l_pid"),
      l_start: memberOffset("l_start"),
      l_type: memberOffset("l_type"),
      l_whence: memberOffset("l_whence"),
    },
    size: Flock.size,
  };
}

function abiIsSupported(): boolean {
  const abi = posixFcntlAbi();
  return abi.alignment === 8 && abi.size === 32 &&
    abi.offsets.l_type === 0 && abi.offsets.l_whence === 2 &&
    abi.offsets.l_start === 8 && abi.offsets.l_len === 16 && abi.offsets.l_pid === 24;
}

function nativeFcntl(): Fcntl {
  if (process.platform !== "linux" || process.arch !== "x64" || !abiIsSupported()) {
    throw new EvidenceContractError("commitLockUnsupported");
  }
  if (fcntlFunction !== null) return fcntlFunction;
  try {
    const libc = koffi.load("libc.so.6");
    fcntlFunction = libc.func(
      "fcntl",
      "int",
      ["int", "int", koffi.inout(koffi.pointer(Flock))],
    ) as Fcntl;
    return fcntlFunction;
  } catch {
    throw new EvidenceContractError("commitLockUnsupported");
  }
}

function lockType(mode: CommitLockMode): number {
  if (mode === "shared") return F_RDLCK;
  if (mode === "exclusive") return F_WRLCK;
  throw new EvidenceContractError("commitLockModeInvalid");
}

function timeoutMilliseconds(options: CommitLockOptions): number {
  const value = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceContractError("commitLockTimeoutInvalid");
  }
  return value;
}

function privateDirectory(metadata: Stats): boolean {
  return !metadata.isSymbolicLink() && metadata.isDirectory() &&
    metadata.uid === process.getuid?.() && (metadata.mode & 0o777) === 0o700;
}

function privateLockFile(metadata: Stats): boolean {
  return !metadata.isSymbolicLink() && metadata.isFile() &&
    metadata.uid === process.getuid?.() && metadata.nlink === 1 &&
    (metadata.mode & 0o777) === 0o600;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function existingLockHandle(lockPath: string): Promise<FileHandle> {
  return open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
}

async function createOrOpenLockHandle(lockPath: string): Promise<{
  readonly created: boolean;
  readonly handle: FileHandle;
}> {
  try {
    return {
      created: true,
      handle: await open(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ),
    };
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    return { created: false, handle: await existingLockHandle(lockPath) };
  }
}

async function requirePrivateStateRoot(stateRoot: string): Promise<void> {
  if (!path.isAbsolute(stateRoot)) {
    throw new EvidenceContractError("unsafeHistoryDirectory");
  }
  if (!privateDirectory(await lstat(stateRoot))) {
    throw new EvidenceContractError("unsafeHistoryDirectory");
  }
}

async function selectLockHandle(
  lockPath: string,
  create: boolean,
): Promise<{ readonly created: boolean; readonly handle: FileHandle }> {
  if (create) {
    try {
      return await createOrOpenLockHandle(lockPath);
    } catch {
      throw new EvidenceContractError("commitLockFailed");
    }
  }
  try {
    return { created: false, handle: await existingLockHandle(lockPath) };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new EvidenceContractError("commitLockMissing");
    throw new EvidenceContractError("commitLockFailed");
  }
}

async function validateOpenedLock(
  stateRoot: string,
  opened: { readonly created: boolean; readonly handle: FileHandle },
): Promise<FileHandle> {
  try {
    if (!privateLockFile(await opened.handle.stat())) {
      throw new EvidenceContractError("unsafeCommitLock");
    }
    if (opened.created) {
      await opened.handle.sync();
      await syncDirectory(stateRoot);
    }
    return opened.handle;
  } catch (error) {
    await opened.handle.close().catch(() => undefined);
    if (error instanceof EvidenceContractError) throw error;
    throw new EvidenceContractError("commitLockFailed");
  }
}

async function openCommitLock(stateRoot: string, create: boolean): Promise<FileHandle> {
  await requirePrivateStateRoot(stateRoot);
  const lockPath = path.join(stateRoot, "commit.lock");
  return validateOpenedLock(stateRoot, await selectLockHandle(lockPath, create));
}

function lockValue(mode: CommitLockMode): FlockValue {
  return {
    l_type: lockType(mode),
    l_whence: SEEK_SET,
    l_start: LOCK_START,
    l_len: LOCK_LENGTH,
    l_pid: 0,
  };
}

function retryableErrno(errno: number): boolean {
  return errno === koffi.os.errno.EACCES || errno === koffi.os.errno.EAGAIN ||
    errno === koffi.os.errno.EINTR;
}

async function retryDelay(deadline: bigint): Promise<void> {
  const remaining = deadline - process.hrtime.bigint();
  if (remaining <= 0n) return;
  const roundedUpMilliseconds = Number(
    (remaining + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND,
  );
  await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_MILLISECONDS, roundedUpMilliseconds)));
}

async function acquireLock(
  descriptor: number,
  mode: CommitLockMode,
  timeout: number,
): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(timeout) * NANOSECONDS_PER_MILLISECOND;
  const fcntl = nativeFcntl();
  const value = lockValue(mode);
  while (true) {
    koffi.errno(0);
    if (fcntl(descriptor, F_SETLK, value) === 0) return;
    const errno = koffi.errno();
    if (!retryableErrno(errno)) throw new EvidenceContractError("commitLockFailed");
    if (process.hrtime.bigint() >= deadline) throw new EvidenceContractError("commitLockTimeout");
    await retryDelay(deadline);
  }
}

export async function withPosixCommitLock<T>(
  stateRoot: string,
  mode: CommitLockMode,
  operation: () => Promise<T> | T,
  options: CommitLockOptions = {},
): Promise<T> {
  const timeout = timeoutMilliseconds(options);
  const handle = await openCommitLock(stateRoot, options.create === true);
  try {
    await acquireLock(handle.fd, mode, timeout);
    return await operation();
  } finally {
    await handle.close();
  }
}
