import { lstat, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";

async function packages(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const name of await readdir(root)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const child of await readdir(path.join(root, name))) {
        entries.set(`${name}/${child}`, await realpath(path.join(root, name, child)));
      }
    } else entries.set(name, await realpath(path.join(root, name)));
  }
  return entries;
}

export async function projectDependencyRoot(moduleRoot: string): Promise<string | undefined> {
  const root = path.join(moduleRoot, "node_modules");
  try { await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return realpath(root);
}

// Project libraries keep their installed versions; measurement tools remain pinned.
// A private node_modules directory keeps Vite caches out of both shared installations.
function isMeasurementPackage(name: string): boolean {
  return name === "vitest" || name === "vite" || name.startsWith("@vitest/") || name.startsWith("@stryker-mutator/");
}

export async function linkDependencies(tools: string, target: string, project?: string): Promise<void> {
  const entries = project === undefined ? new Map<string, string>() : await packages(project);
  for (const [name, source] of await packages(tools)) {
    if (isMeasurementPackage(name) || !entries.has(name)) entries.set(name, source);
  }
  await mkdir(target, { mode: 0o700 });
  for (const [name, source] of entries) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true, mode: 0o700 });
    await symlink(source, path.join(target, name));
  }
}
