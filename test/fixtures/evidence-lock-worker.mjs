import { setTimeout as delay } from "node:timers/promises";

import { withPosixCommitLock } from "../../dist/evidence/fcntl-lock.js";

const [stateRoot, mode, holdMillisecondsText, timeoutMillisecondsText] = process.argv.slice(2);

try {
  await withPosixCommitLock(
    stateRoot,
    mode,
    async () => {
      process.stdout.write("locked\n");
      await delay(Number(holdMillisecondsText));
    },
    {
      create: true,
      timeoutMilliseconds: Number(timeoutMillisecondsText),
    },
  );
  process.stdout.write("released\n");
} catch (error) {
  process.stderr.write(`${error?.code ?? "unknownLockError"}\n`);
  process.exitCode = 23;
}
