import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { SentinelPlanReporter } from "./stryker-plan-reporter.js";
import { compareUtf8, type TypedKillProof } from "./protocol.js";

const EVENT_PREFIX = "SENTINEL_STRYKER_EVENT_V1:";

async function readProof(directory: string, entry: Dirent): Promise<TypedKillProof> {
  if (!/^[0-9a-f]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("sentinelProofEntryInvalid");
  }
  const filePath = path.join(directory, entry.name);
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("sentinelProofEntryUnsafe");
  }
  return JSON.parse(await readFile(filePath, "utf8")) as TypedKillProof;
}

class SentinelEventReporter extends SentinelPlanReporter {
  private async proofs(): Promise<readonly TypedKillProof[]> {
    const directory = process.env.SENTINEL_TS_PROOF_DIR;
    if (directory === undefined || !path.isAbsolute(directory)) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const proofs: TypedKillProof[] = [];
    for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
      proofs.push(await readProof(directory, entry));
    }
    return proofs.sort((left, right) => compareUtf8(left.mutantId, right.mutantId));
  }

  public async wrapUp(): Promise<void> {
    const record = { ...this.finalize(), proofs: await this.proofs() };
    const payload = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
    process.stdout.write(`${EVENT_PREFIX}${payload}\n`);
  }
}

export const strykerPlugins = [
  {
    kind: "Reporter",
    name: "sentinel-plan",
    injectableClass: SentinelEventReporter,
  },
];
