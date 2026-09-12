export {
  readRunEvidence,
  writeRunEvidenceDraft,
  type Finding,
  type RunEvidence,
  type RunEvidenceDraft,
  type StoredFinding,
} from "./evidence/store.js";

import {
  readRunEvidence,
  type StoredFinding,
} from "./evidence/store.js";

export interface RepeatedFinding extends StoredFinding {
  readonly occurrences: number;
}

export interface HistorySummary {
  readonly runCount: number;
  readonly repeated: readonly RepeatedFinding[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export async function summarizeRepeatedFindings(projectRoot: string): Promise<HistorySummary> {
  const runs = await readRunEvidence(projectRoot);
  const byFingerprint = new Map<string, { finding: StoredFinding; occurrences: number }>();
  for (const run of runs) {
    const seenInRun = new Set<string>();
    for (const finding of run.findings) {
      if (seenInRun.has(finding.fingerprint)) continue;
      seenInRun.add(finding.fingerprint);
      const current = byFingerprint.get(finding.fingerprint);
      byFingerprint.set(finding.fingerprint, {
        finding,
        occurrences: (current?.occurrences ?? 0) + 1,
      });
    }
  }
  const repeated = [...byFingerprint.values()]
    .filter((value) => value.occurrences >= 2)
    .map(({ finding, occurrences }) => ({ ...finding, occurrences }))
    .sort((left, right) => compareUtf8(left.fingerprint, right.fingerprint));
  return { runCount: runs.length, repeated };
}
