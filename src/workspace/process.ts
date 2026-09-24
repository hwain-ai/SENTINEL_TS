import { spawn } from "node:child_process";
import { MutationProtocolError } from "../mutation/protocol.js";

export interface ChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Each checker owns a process group so cancellation also stops its test workers.
export function runProcess(executable: string, args: readonly string[], cwd: string,
  env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ChildResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    let size = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const child = spawn(executable, [...args], {
      cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = (value: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { failure = error; child.kill(value); } }
    };
    const abort = (): void => {
      kill("SIGTERM");
      timer = setTimeout(() => kill("SIGKILL"), 2000);
      timer.unref();
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        failure = new MutationProtocolError("childOutputOverflow", "checker output exceeded its limit");
        kill("SIGKILL");
      } else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", error => { failure = error; });
    child.once("close", (exitCode, childSignal) => {
      signal?.removeEventListener("abort", abort);
      if (timer !== undefined) clearTimeout(timer);
      kill("SIGKILL");
      if (signal?.aborted) { reject(signal.reason); return; }
      if (failure !== undefined) { reject(failure); return; }
      resolve({ exitCode, signal: childSignal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function runPair<A, B>(first: (signal: AbortSignal) => Promise<A>,
  second: (signal: AbortSignal) => Promise<B>, mode: string): Promise<[A, B]> {
  if (mode !== "parallel" && mode !== "sequential") throw new Error("invalidExecutionMode");
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new MutationProtocolError("checkCancelled", "check cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (mode === "sequential") return [await first(controller.signal), await second(controller.signal)];
    const capture = <T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      Promise.resolve().then(() => job(controller.signal)).catch(error => { controller.abort(error); throw error; });
    const results = await Promise.allSettled([capture(first), capture(second)]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw controller.signal.reason;
    return [(results[0] as PromiseFulfilledResult<A>).value, (results[1] as PromiseFulfilledResult<B>).value];
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
