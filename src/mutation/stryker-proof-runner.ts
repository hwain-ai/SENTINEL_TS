import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TypedKillProof } from "./protocol.js";

interface DryRunTest {
  readonly id: string;
  readonly status: number;
}

type DryRunResult =
  | { readonly status: "complete"; readonly tests: readonly DryRunTest[]; readonly mutantCoverage?: unknown }
  | { readonly status: "error"; readonly errorMessage: string }
  | { readonly status: "timeout"; readonly reason?: string };

type MutantRunResult =
  | {
      readonly status: "killed";
      readonly killedBy: readonly string[];
      readonly failureMessage: string;
    }
  | { readonly status: "survived"; readonly nrOfTests: number }
  | { readonly status: "timeout"; readonly reason?: string }
  | { readonly status: "error"; readonly errorMessage: string };

interface MutantRunOptions {
  readonly activeMutant: { readonly id: string };
  readonly mutantActivation?: "static" | "runtime";
  readonly reloadEnvironment?: boolean;
  readonly [key: string]: unknown;
}

// Stryker derives mutantActivation from "is there a test filter", and the closed
// configuration always names its test files, so every mutant arrives as "runtime".
// A static mutant (module-level code, evaluated at import) must be active before the
// test file imports the source, or it can never be observed. Stryker marks exactly
// those mutants with reloadEnvironment, because a hot swap is only allowed for
// non-static mutants under a test filter.
function withStaticActivation(options: MutantRunOptions): MutantRunOptions {
  if (options.reloadEnvironment !== true || options.mutantActivation === "static") {
    return options;
  }
  return { ...options, mutantActivation: "static" };
}

interface OfficialRunner {
  capabilities(): unknown;
  init(): Promise<void>;
  dryRun(options: unknown): Promise<DryRunResult>;
  mutantRun(options: MutantRunOptions): Promise<MutantRunResult>;
  dispose(): Promise<void>;
}

interface OfficialFactory {
  (injector: unknown): OfficialRunner;
  readonly inject?: readonly string[];
}

interface OfficialPlugin {
  readonly factory: OfficialFactory;
  readonly kind: string;
  readonly name: string;
}

interface OfficialVitestModule {
  readonly strykerPlugins: readonly OfficialPlugin[];
  readonly strykerValidationSchema: unknown;
}

const officialModuleName: string = "@stryker-mutator/vitest-runner";
const officialModule = await import(officialModuleName) as OfficialVitestModule;
const officialVitestPlugins = officialModule.strykerPlugins;
export const strykerValidationSchema = officialModule.strykerValidationSchema;

const officialPlugin = officialVitestPlugins[0];
if (officialPlugin === undefined) {
  throw new Error("sentinelVitestPluginMissing");
}

interface VitestError {
  readonly name?: unknown;
  readonly constructor?: { readonly name?: unknown };
}

interface VitestTask {
  readonly tasks?: readonly VitestTask[];
  readonly result?: {
    readonly errors?: readonly VitestError[];
  };
}

interface VitestContextView {
  readonly state: {
    readonly getFiles: () => readonly VitestTask[];
    readonly errorsSet: ReadonlySet<unknown>;
  };
  readonly projects: readonly {
    readonly config: { readonly retry?: unknown };
  }[];
}

function completeTestSignature(result: DryRunResult): string | null {
  if (result.status !== "complete") return null;
  const tests = result.tests.map((item) => `${item.id}\0${item.status}`).sort();
  if (tests.length === 0 || result.tests.some((item) => item.status !== 0)) return null;
  return JSON.stringify(tests);
}

function contextOf(runner: OfficialRunner): VitestContextView | null {
  const context = (runner as unknown as { readonly ctx?: VitestContextView }).ctx;
  return context ?? null;
}

function errorType(error: VitestError): string {
  if (typeof error.name === "string" && error.name.length > 0) return error.name;
  const constructorName = error.constructor?.name;
  return typeof constructorName === "string" ? constructorName : "";
}

function collectErrorTypes(task: VitestTask): readonly string[] {
  const own = (task.result?.errors ?? []).map(errorType).filter((value) => value.length > 0);
  return [...own, ...(task.tasks ?? []).flatMap(collectErrorTypes)];
}

function assertionType(runner: OfficialRunner): string {
  const context = contextOf(runner);
  if (context === null || context.state.errorsSet.size !== 0) return "";
  const types = context.state.getFiles().flatMap(collectErrorTypes);
  return types.length > 0 && types.every((value) => value === "AssertionError")
    ? "AssertionError"
    : "";
}

function retryDisabled(runner: OfficialRunner): boolean {
  const context = contextOf(runner);
  return context !== null && context.projects.every((project) => (project.config.retry ?? 0) === 0);
}

function sameMutantFailure(
  first: MutantRunResult,
  second: MutantRunResult,
  firstAssertion: string,
  secondAssertion: string,
): boolean {
  if (first.status !== "killed" || second.status !== "killed") return false;
  return (
    firstAssertion === "AssertionError" &&
    firstAssertion === secondAssertion &&
    JSON.stringify([...first.killedBy].sort()) === JSON.stringify([...second.killedBy].sort()) &&
    first.failureMessage === second.failureMessage
  );
}

function writeProof(proof: TypedKillProof): void {
  const proofDirectory = process.env.SENTINEL_TS_PROOF_DIR;
  if (proofDirectory === undefined || !path.isAbsolute(proofDirectory)) {
    throw new Error("sentinelProofDirectoryMissing");
  }
  mkdirSync(proofDirectory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(proof.mutantId, "utf8").digest("hex");
  writeFileSync(path.join(proofDirectory, `${name}.json`), `${JSON.stringify(proof)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export class SentinelVitestRunner {
  private controlSignature: string | null = null;

  public constructor(private readonly delegate: OfficialRunner) {}

  public capabilities(): unknown {
    return this.delegate.capabilities();
  }

  public async init(): Promise<void> {
    await this.delegate.init();
  }

  public async dryRun(options: unknown): Promise<DryRunResult> {
    const first = await this.delegate.dryRun(options);
    const second = await this.delegate.dryRun(options);
    const firstSignature = completeTestSignature(first);
    const secondSignature = completeTestSignature(second);
    this.controlSignature = firstSignature !== null && firstSignature === secondSignature
      ? firstSignature
      : null;
    if (this.controlSignature === null) {
      return { status: "error", errorMessage: "sentinelControlReplayMismatch" };
    }
    return second;
  }

  public async mutantRun(
    options: MutantRunOptions,
  ): Promise<MutantRunResult> {
    const activated = withStaticActivation(options);
    const firstNonce = randomBytes(16).toString("hex");
    const first = await this.delegate.mutantRun(activated);
    const firstAssertion = assertionType(this.delegate);
    const secondNonce = randomBytes(16).toString("hex");
    const second = await this.delegate.mutantRun(activated);
    const secondAssertion = assertionType(this.delegate);
    if (first.status === "killed") {
      writeProof({
        mutantId: options.activeMutant.id,
        assertionType: firstAssertion,
        testId: first.killedBy.length === 1 ? (first.killedBy[0] ?? "") : "",
        executionNonce: firstNonce,
        controlPassed: this.controlSignature !== null,
        assertionFailed: firstAssertion === "AssertionError",
        replayMatched:
          firstNonce !== secondNonce &&
          sameMutantFailure(first, second, firstAssertion, secondAssertion),
        cacheObserved: false,
        retryObserved: !retryDisabled(this.delegate),
      });
    }
    return first;
  }

  public async dispose(): Promise<void> {
    await this.delegate.dispose();
  }
}

const sentinelVitestFactory = Object.assign(
  (injector: unknown): SentinelVitestRunner =>
    new SentinelVitestRunner(officialPlugin.factory(injector)),
  { inject: ["$injector"] as const },
);

export const strykerPlugins = [
  {
    factory: sentinelVitestFactory,
    kind: "TestRunner",
    name: "sentinel-vitest",
  },
];
