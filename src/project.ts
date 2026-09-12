import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { MutationProtocolError, compareUtf8 } from "./mutation/protocol.js";
import { parseProjectConfigJson } from "./project-json.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".sentinel",
  ".stryker-tmp",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reports",
]);
const VITEST_CONFIG_NAMES = [
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.ts",
  "vitest.config.mts",
] as const;

interface RawModule {
  readonly id: string;
  readonly language: "typescript";
  readonly root: string;
  readonly production: readonly string[];
  readonly testRoots: readonly string[];
  readonly testPatterns: readonly string[];
}

export interface MutationProject {
  readonly projectRoot: string;
  readonly moduleRoot: string;
  readonly moduleId: string;
  readonly productionFiles: readonly string[];
  readonly testFiles: readonly string[];
  readonly vitestConfigFile: string;
  readonly protectedFiles: readonly string[];
  readonly snapshotFiles: readonly string[];
}

function requireObject(value: unknown, code: string, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MutationProtocolError(code, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new MutationProtocolError("projectConfigShapeInvalid", `${label} contains unsupported fields`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new MutationProtocolError("projectConfigShapeInvalid", `${label} must be nonempty text`);
  }
  return value;
}

function textList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MutationProtocolError("projectConfigShapeInvalid", `${label} must be a nonempty array`);
  }
  const result = value.map((item) => requiredText(item, label));
  if (new Set(result).size !== result.length) {
    throw new MutationProtocolError("projectConfigShapeInvalid", `${label} must not contain duplicates`);
  }
  return result;
}

function validateCommand(value: unknown, label: string): void {
  const command = textList(value, label);
  if (command.some((argument) => argument.includes("\0") || argument.includes("\n") || argument.includes("\r"))) {
    throw new MutationProtocolError("projectConfigShapeInvalid", `${label} contains an invalid argument`);
  }
}

function validateCoverage(value: unknown): void {
  const coverage = requireObject(value, "projectConfigShapeInvalid", "coverage config");
  exactKeys(coverage, ["command", "format", "report"], "coverage config");
  if (Object.keys(coverage).length !== 3 || coverage.format !== "istanbul-json") {
    throw new MutationProtocolError("projectConfigShapeInvalid", "coverage config fields are invalid");
  }
  validateCommand(coverage.command, "coverage command");
  canonicalRelative(requiredText(coverage.report, "coverage report"), "coverage report");
}

function canonicalRelative(value: string, label: string, allowGlob = false): string {
  const components = value.split("/");
  const invalidGlob = !allowGlob && /[*?\[\]]/u.test(value);
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    invalidGlob ||
    components.some((component) => component.length === 0 || component === "..")
  ) {
    throw new MutationProtocolError("projectConfigShapeInvalid", `${label} must be project-relative`);
  }
  return components.filter((component) => component !== ".").join("/") || ".";
}

function rawModule(value: unknown): RawModule {
  const module = requireObject(value, "projectConfigShapeInvalid", "project module");
  exactKeys(
    module,
    ["id", "language", "root", "production", "testCommand", "coverage", "testRoots", "testPatterns"],
    "project module",
  );
  validateCommand(module.testCommand, "test command");
  validateCoverage(module.coverage);
  return {
    id: requiredText(module.id, "module id"),
    language: "typescript",
    root: canonicalRelative(requiredText(module.root, "module root"), "module root"),
    production: textList(module.production, "production patterns").map((item) =>
      canonicalRelative(item, "production pattern", true)),
    testRoots: textList(module.testRoots, "test roots").map((item) =>
      canonicalRelative(item, "test root")),
    testPatterns: textList(module.testPatterns, "test patterns").map((item) => {
      if (item.includes("/")) {
        throw new MutationProtocolError("projectConfigShapeInvalid", "test patterns must match file names");
      }
      return item;
    }),
  };
}

function matchingModules(
  modules: readonly Record<string, unknown>[],
  requestedModule: string | undefined,
): readonly Record<string, unknown>[] {
  return modules.filter((module) => requestedModule === undefined
    ? module.language === "typescript"
    : module.id === requestedModule);
}

function requireRequestedModule(
  selected: readonly Record<string, unknown>[],
  requestedModule: string | undefined,
): void {
  if (requestedModule === undefined) return;
  if (selected.length === 0) {
    throw new MutationProtocolError("moduleNotFound", "the requested TypeScript module was not found");
  }
  if (selected[0]?.language !== "typescript") {
    throw new MutationProtocolError("moduleLanguageMismatch", "selected module must use TypeScript");
  }
}

function requireUnambiguousModule(candidates: readonly RawModule[], requestedModule: string | undefined): void {
  if (requestedModule === undefined && candidates.length !== 1) {
    throw new MutationProtocolError("moduleSelectionRequired", "select one TypeScript module with --module");
  }
}

function selectModule(document: unknown, requestedModule: string | undefined): RawModule {
  const root = requireObject(document, "projectConfigShapeInvalid", "project config");
  exactKeys(root, ["specVersion", "modules"], "project config");
  if (root.specVersion !== "1.0.0" || !Array.isArray(root.modules) || root.modules.length === 0) {
    throw new MutationProtocolError("projectConfigShapeInvalid", "project config version or modules are invalid");
  }
  const modules = root.modules.map((value) =>
    requireObject(value, "projectConfigShapeInvalid", "project module"));
  const selectedValues = matchingModules(modules, requestedModule);
  requireRequestedModule(selectedValues, requestedModule);
  const candidates = selectedValues.map(rawModule);
  requireUnambiguousModule(candidates, requestedModule);
  const selected = requestedModule === undefined
    ? candidates[0]
    : candidates.find((candidate) => candidate.id === requestedModule);
  if (selected === undefined) {
    throw new MutationProtocolError("moduleNotFound", "the requested TypeScript module was not found");
  }
  return selected;
}

async function regularRoot(value: string): Promise<string> {
  const absolute = path.resolve(value);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new MutationProtocolError("invalidProjectRoot", "project root must be a regular directory");
  }
  return realpath(absolute);
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function containedDirectory(root: string, relative: string): Promise<string> {
  const candidate = path.resolve(root, relative);
  if (!within(candidate, root)) {
    throw new MutationProtocolError("moduleRootOutsideProject", "module root leaves the project");
  }
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new MutationProtocolError("invalidModuleRoot", "module root must be a regular directory");
  }
  const resolved = await realpath(candidate);
  if (!within(resolved, root)) {
    throw new MutationProtocolError("moduleRootOutsideProject", "resolved module root leaves the project");
  }
  return resolved;
}

async function walkFiles(root: string, directory = root): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new MutationProtocolError("projectSymlinkUnsupported", "project snapshot input must not contain symlinks");
    }
    if (entry.isDirectory()) files.push(...await walkFiles(root, fullPath));
    else if (entry.isFile()) files.push(path.relative(root, fullPath).split(path.sep).join("/"));
    else throw new MutationProtocolError("projectFileTypeUnsupported", "project contains a non-regular file");
  }
  return files;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function globExpression(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character !== "*") {
      expression += escapeRegularExpression(character);
      continue;
    }
    const next = pattern[index + 1];
    if (next !== "*") {
      expression += "[^/]*";
      continue;
    }
    index += 1;
    if (pattern[index + 1] === "/") {
      index += 1;
      expression += "(?:.*/)?";
    } else expression += ".*";
  }
  return new RegExp(`${expression}$`, "u");
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globExpression(pattern).test(value));
}

function isSourceFile(file: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
    !file.endsWith(".d.ts") &&
    !(VITEST_CONFIG_NAMES as readonly string[]).includes(file)
  );
}

function underRoot(file: string, root: string): boolean {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

function classifySources(files: readonly string[], module: RawModule): {
  readonly production: readonly string[];
  readonly tests: readonly string[];
} {
  const sources = files.filter(isSourceFile);
  const production = sources.filter((file) => matchesAny(file, module.production));
  const tests = sources.filter((file) =>
    module.testRoots.some((root) => underRoot(file, root)) &&
    matchesAny(path.posix.basename(file), module.testPatterns));
  if (production.length === 0) {
    throw new MutationProtocolError("emptyProductionScope", "production scope must not be empty");
  }
  if (tests.length === 0) {
    throw new MutationProtocolError("emptyTestScope", "test scope must not be empty");
  }
  const selected = new Set([...production, ...tests]);
  if (selected.size !== production.length + tests.length) {
    throw new MutationProtocolError("overlappingSourceScope", "production and test scopes overlap");
  }
  const unclassified = sources.filter((file) => !selected.has(file));
  if (unclassified.length > 0) {
    throw new MutationProtocolError("unclassifiedSource", `TypeScript source is unclassified: ${unclassified[0]}`);
  }
  return { production, tests };
}

async function oneVitestConfig(moduleRoot: string): Promise<string> {
  const matches: string[] = [];
  for (const name of VITEST_CONFIG_NAMES) {
    if (await vitestConfigExists(moduleRoot, name)) matches.push(name);
  }
  if (matches.length !== 1) {
    throw new MutationProtocolError("vitestConfigAmbiguous", "exactly one supported Vitest config is required");
  }
  return matches[0] as string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function vitestConfigExists(moduleRoot: string, name: string): Promise<boolean> {
  try {
    const metadata = await lstat(path.join(moduleRoot, name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new MutationProtocolError("invalidVitestConfig", "Vitest config must be a regular file");
    }
    return true;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return false;
  }
}

async function rejectMutationDirectives(moduleRoot: string, production: readonly string[]): Promise<void> {
  for (const file of production) {
    const source = await readFile(path.join(moduleRoot, file), "utf8");
    if (/\bStryker\s+(?:disable|restore)\b/u.test(source)) {
      throw new MutationProtocolError(
        "unauthorizedMutationDirective",
        "strict mutation does not permit source-level Stryker directives",
      );
    }
  }
}

export async function loadMutationProject(
  projectValue: string,
  configValue?: string,
  requestedModule?: string,
): Promise<MutationProject> {
  const projectRoot = await regularRoot(projectValue);
  const configRelative = canonicalRelative(configValue ?? "sentinel.config.json", "project config");
  const configPath = path.join(projectRoot, configRelative);
  const configMetadata = await lstat(configPath);
  if (configMetadata.isSymbolicLink() || !configMetadata.isFile()) {
    throw new MutationProtocolError("projectConfigNotFound", "project config must be a regular file");
  }
  const document = parseProjectConfigJson(await readFile(configPath, "utf8"));
  const module = selectModule(document, requestedModule);
  const moduleRoot = await containedDirectory(projectRoot, module.root);
  const files = await walkFiles(moduleRoot);
  const scope = classifySources(files, module);
  const vitestConfigFile = await oneVitestConfig(moduleRoot);
  await rejectMutationDirectives(moduleRoot, scope.production);
  const protectedFiles = [...new Set([...scope.production, ...scope.tests, vitestConfigFile])].sort(compareUtf8);
  return {
    projectRoot,
    moduleRoot,
    moduleId: module.id,
    productionFiles: [...scope.production].sort(compareUtf8),
    testFiles: [...scope.tests].sort(compareUtf8),
    vitestConfigFile,
    protectedFiles,
    snapshotFiles: [...files].sort(compareUtf8),
  };
}
