export function isSourceFile(file: string): boolean {
  const extensions = [".ts", ".tsx"];
  return extensions.some((extension) => file.endsWith(extension));
}
