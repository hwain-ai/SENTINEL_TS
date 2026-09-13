import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import koffi from "koffi";

import { EvidenceContractError } from "./contract.js";

const SEEK_SET = 0;
const LOCK_START = 0n;
const LOCK_LENGTH = 1n;

// POSIX advisory record locks through the C library. Linux (glibc, x86_64 and aarch64) and
// Darwin (x86_64 and arm64) lay out struct flock differently and number the commands differently.
interface FcntlAbi {
  readonly library: string;
  readonly F_SETLK: number;
  readonly F_RDLCK: number;
  readonly F_WRLCK: number;
  readonly members: readonly (readonly [keyof FlockValue, string])[];
  readonly size: number;
  readonly offsets: Readonly<Record<keyof FlockValue, number>>;
}

const LINUX_ABI: FcntlAbi = {
  library: "libc.so.6",
  F_SETLK: 6,
  F_RDLCK: 0,
  F_WRLCK: 1,
  members: [["l_type", "int16_t"], ["l_whence", "int16_t"], ["l_start", "int64_t"], ["l_len", "int64_t"], ["l_pid", "int32_t"]],
  size: 32,
  offsets: { l_type: 0, l_whence: 2, l_start: 8, l_len: 16, l_pid: 24 },
};

const DARWIN_ABI: FcntlAbi = {
  library: "libSystem.B.dylib",
  F_SETLK: 8,
  F_RDLCK: 1,
  F_WRLCK: 3,
  members: [["l_start", "int64_t"], ["l_len", "int64_t"], ["l_pid", "int32_t"], ["l_type", "int16_t"], ["l_whence", "int16_t"]],
  size: 24,
  offsets: { l_start: 0, l_len: 8, l_pid: 16, l_type: 20, l_whence: 22 },
};

const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);

function platformAbi(): FcntlAbi | null {
  if (!SUPPORTED_ARCHITECTURES.has(process.arch)) return null;
  if (process.platform === "linux") return LINUX_ABI;
  if (process.platform === "darwin") return DARWIN_ABI;
  return null;
}

const ABI = platformAbi();
const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;
const RETRY_MILLISECONDS = 10;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

const Flock = koffi.struct(Object.fromEntries((ABI ?? LINUX_ABI).members));

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

function abiIsSupported(abi: FcntlAbi): boolean {
  const observed = posixFcntlAbi();
  return observed.alignment === 8 && observed.size === abi.size &&
    (Object.keys(abi.offsets) as (keyof FlockValue)[]).every((name) => observed.offsets[name] === abi.offsets[name]);
}

function nativeFcntl(): Fcntl {
  if (ABI === null || !abiIsSupported(ABI)) {
    throw new EvidenceContractError("commitLockUnsupported");
  }
  if (fcntlFunction !== null) return fcntlFunction;
  try {
    const libc = koffi.load(ABI.library);
    // fcntl is variadic; Apple arm64 passes variadic arguments on the stack, so the
    // declaration must say so and the lock pointer travels as a typed variadic argument.
    const variadic = libc.func("fcntl", "int", ["int", "int", "..."]) as (
      descriptor: number,
      command: number,
      type: unknown,
      lock: FlockValue,
    ) => number;
    const lockPointer = koffi.inout(koffi.pointer(Flock));
    fcntlFunction = (descriptor, command, lock) => variadic(descriptor, command, lockPointer, lock);
    return fcntlFunction;
  } catch {
    throw new EvidenceContractError("commitLockUnsupported");
  }
}

function lockType(mode: CommitLockMode): number {
  const abi = ABI ?? LINUX_ABI;
  if (mode === "shared") return abi.F_RDLCK;
  if (mode === "exclusive") return abi.F_WRLCK;
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
    if (fcntl(descriptor, (ABI ?? LINUX_ABI).F_SETLK, value) === 0) return;
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
