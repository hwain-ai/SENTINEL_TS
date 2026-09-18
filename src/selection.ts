import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeTypeScript, type CallableRecord } from "./crap.js";
import type { MutationProject } from "./project.js";
import { MutationProtocolError } from "./mutation/protocol.js";

export interface CodeSelection {
  readonly files: readonly string[];
  readonly functions: readonly string[];
  readonly tests: readonly string[];
}

export async function selectProject(project: MutationProject, selection: CodeSelection): Promise<MutationProject> {
  validateSelection(project, selection);
  const productionFiles = selection.files.length ? [...new Set(selection.files)] : project.productionFiles;
  const selectedCallables = await selectFunctions(project, productionFiles, selection.functions);
  return { ...project, productionFiles, testFiles: selection.tests.length ? [...new Set(selection.tests)] : project.testFiles, selectedCallables };
}

function validateSelection(project: MutationProject, selection: CodeSelection): void {
  validateLists(selection);
  if (selection.functions.length && selection.files.length !== 1) {
    throw new MutationProtocolError("functionRequiresOneFile", "--function requires exactly one --file");
  }
  if (selection.files.some(file => !project.productionFiles.includes(file)) || selection.tests.some(file => !project.testFiles.includes(file))) {
    throw new MutationProtocolError("invalidSelection", "select existing production and test files from their configured scope");
  }
}

function validateLists(selection: CodeSelection): void {
  for (const key of ["files", "functions", "tests"] as const) {
    if (!Array.isArray(selection[key]) || selection[key].some(value => typeof value !== "string" || value.length === 0)) {
      throw new MutationProtocolError("invalidSelection", "selection must contain file, function and test lists");
    }
  }
}

async function selectFunctions(project: MutationProject, productionFiles: readonly string[], functions: readonly string[]): Promise<CallableRecord[]> {
  const selectedCallables: CallableRecord[] = [];
  if (functions.length) {
    const file = productionFiles[0]!;
    const callables = analyzeTypeScript(await readFile(path.join(project.moduleRoot, file), "utf8"), file);
    for (const name of functions) {
      let matches = callables.filter(item => item.qualifiedName === name || item.callableId === name || `${item.modulePath}:${item.callableId}` === name);
      if (!matches.length) matches = callables.filter(item => item.qualifiedName.split(".").at(-1) === name);
      if (matches.length !== 1) throw new MutationProtocolError("functionSelectionInvalid", "function name must identify exactly one callable");
      selectedCallables.push(matches[0]!);
    }
  }
  return selectedCallables;
}

export function positionAt(source: string, byte: number): { line: number; column: number } {
  const prefix = Buffer.from(source).subarray(0, byte).toString("utf8");
  const lines = prefix.split("\n");
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

export async function mutationOwners(project: MutationProject, candidates: readonly import("./mutation/protocol.js").MutationCandidate[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const file of project.productionFiles) {
    const source = await readFile(path.join(project.moduleRoot, file), "utf8");
    const functions = analyzeTypeScript(source, file);
    const lines = source.split("\n");
    for (const candidate of candidates.filter(item => item.modulePath === file)) {
      const position = candidate.location.start;
      const prefix = lines.slice(0, position.line - 1).map(line => `${line}\n`).join("") + lines[position.line - 1]!.slice(0, position.column - 1);
      const byte = Buffer.byteLength(prefix);
      const matches = functions.filter(item => item.sourceRange.startByte <= byte && byte < item.sourceRange.endByte)
        .sort((a, b) => (a.sourceRange.endByte - a.sourceRange.startByte) - (b.sourceRange.endByte - b.sourceRange.startByte));
      if (matches[0] !== undefined) owners.set(candidate.id, matches[0].qualifiedName);
    }
  }
  return owners;
}
