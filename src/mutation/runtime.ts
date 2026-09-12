import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MutationProtocolError } from "./protocol.js";

const CORE = "@stryker-mutator/core";
const RUNNER = "@stryker-mutator/vitest-runner";
const ENTRY = `node_modules/${CORE}/bin/stryker.js`;

interface RuntimeIdentity {
  readonly version: string;
  readonly executable: string;
}

interface RuntimeLock {
  readonly node: string;
  readonly npm: string;
  readonly stryker: string;
  readonly vitestRunner: string;
  readonly entrySha256: string;
}

interface Diagnostic {
  readonly component: string;
  readonly code: string;
}

interface PackageInspection {
  readonly version: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface RuntimeInspection {
  readonly repository: "SENTINEL_TS";
  readonly node: string;
  readonly npm: string | null;
  readonly stryker: string | null;
  readonly vitestRunner: string | null;
  readonly status: "ready" | "unavailable";
  readonly diagnostics: readonly Diagnostic[];
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime metadata must be an object");
  }
  return value as Record<string, unknown>;
}

async function regularFile(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("runtime metadata must be a regular file");
  }
  return readFile(file);
}

async function readObject(file: string): Promise<Record<string, unknown>> {
  return object(JSON.parse((await regularFile(file)).toString("utf8")));
}

function version(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(value)) {
    throw new Error("runtime metadata requires an exact version");
  }
  return value;
}

function requireBackendIdentity(backend: Record<string, unknown>): void {
  const valid = backend.status === "locked" && backend.package === CORE &&
    backend.runnerPackage === RUNNER && backend.entry === ENTRY;
  if (!valid) throw new Error("unsupported runtime lock identity");
  if (backend.version !== backend.runnerVersion) {
    throw new Error("Stryker core and runner must share a version");
  }
}

async function runtimeLock(root: string): Promise<RuntimeLock> {
  const document = await readObject(path.join(root, "toolchain.lock.json"));
  if (document.repository !== "SENTINEL_TS" || document.status !== "locked") {
    throw new Error("runtime lock is not approved");
  }
  const node = object(object(document.toolchains).node);
  if (node.status !== "locked") throw new Error("Node runtime lock is not approved");
  const backend = object(object(node.packageTools).stryker);
  requireBackendIdentity(backend);
  if (typeof backend.entrySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(backend.entrySha256)) {
    throw new Error("runtime entry digest is invalid");
  }
  return {
    node: version(node.version), npm: version(node.npmVersion),
    stryker: version(backend.version), vitestRunner: version(backend.runnerVersion),
    entrySha256: backend.entrySha256,
  };
}

function readFailure(error: unknown): string {
  return object(error).code === "ENOENT" ? "dependencyMissing" : "dependencyManifestInvalid";
}

async function inspectPackage(
  file: string, name: string, expected: string, component: string,
): Promise<PackageInspection> {
  try {
    const manifest = await readObject(file);
    const actual = version(manifest.version);
    const diagnostics: Diagnostic[] = [];
    if (manifest.name !== name) diagnostics.push({ component, code: "dependencyIdentityMismatch" });
    if (actual !== expected) diagnostics.push({ component, code: "dependencyVersionMismatch" });
    return { version: actual, diagnostics };
  } catch (error) {
    return { version: null, diagnostics: [{ component, code: readFailure(error) }] };
  }
}

async function inspectEntry(root: string, expected: string): Promise<readonly Diagnostic[]> {
  try {
    const actual = createHash("sha256").update(await regularFile(path.join(root, ENTRY))).digest("hex");
    return actual === expected ? [] : [{ component: "strykerEntry", code: "dependencyArtifactMismatch" }];
  } catch (error) {
    return [{ component: "strykerEntry", code: readFailure(error) }];
  }
}

function unavailable(node: string): RuntimeInspection {
  return {
    repository: "SENTINEL_TS", node, npm: null, stryker: null, vitestRunner: null,
    status: "unavailable", diagnostics: [{ component: "lock", code: "runtimeLockInvalid" }],
  };
}

// These read-only checks supplement the launcher's complete installation digests.
// They do not execute npm, package entry points, tests, or project configuration.
export async function inspectStrykerRuntime(
  root = repositoryRoot(),
  runtime: RuntimeIdentity = { version: process.versions.node, executable: process.execPath },
): Promise<RuntimeInspection> {
  let lock: RuntimeLock;
  try {
    lock = await runtimeLock(root);
  } catch {
    return unavailable(runtime.version);
  }
  const [npm, stryker, runner, entryDiagnostics] = await Promise.all([
    inspectPackage(path.resolve(path.dirname(runtime.executable), "../lib/node_modules/npm/package.json"),
      "npm", lock.npm, "npm"),
    inspectPackage(path.join(root, "node_modules", CORE, "package.json"), CORE, lock.stryker, "stryker"),
    inspectPackage(path.join(root, "node_modules", RUNNER, "package.json"), RUNNER, lock.vitestRunner, "vitestRunner"),
    inspectEntry(root, lock.entrySha256),
  ]);
  const diagnostics: Diagnostic[] = [...npm.diagnostics, ...stryker.diagnostics, ...runner.diagnostics, ...entryDiagnostics];
  if (runtime.version !== lock.node) diagnostics.unshift({ component: "node", code: "dependencyVersionMismatch" });
  return {
    repository: "SENTINEL_TS", node: runtime.version, npm: npm.version,
    stryker: stryker.version, vitestRunner: runner.version,
    status: diagnostics.length === 0 ? "ready" : "unavailable", diagnostics,
  };
}

export async function requireStrykerRuntime(
  root?: string, runtime?: RuntimeIdentity,
): Promise<void> {
  const inspection = await inspectStrykerRuntime(root, runtime);
  if (inspection.status !== "ready") {
    const reasons = inspection.diagnostics.map((item) => `${item.component}:${item.code}`).join(", ");
    throw new MutationProtocolError("strykerRuntimeUnavailable", `Stryker runtime is unavailable (${reasons})`);
  }
}
