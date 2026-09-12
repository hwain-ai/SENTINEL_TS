import { createHash } from "node:crypto";

export class UnicodeScalarError extends Error {
  public readonly utf16Offset: number;

  public constructor(utf16Offset: number) {
    super(`source contains an unpaired UTF-16 surrogate at offset ${utf16Offset}`);
    this.name = "UnicodeScalarError";
    this.utf16Offset = utf16Offset;
  }
}

export class PathTextError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathTextError";
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function assertUnicodeScalarSequence(source: string): void {
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      if (index + 1 >= source.length || !isLowSurrogate(source.charCodeAt(index + 1))) {
        throw new UnicodeScalarError(index);
      }
      index += 1;
    } else if (isLowSurrogate(codeUnit)) {
      throw new UnicodeScalarError(index);
    }
  }
}

export function assertValidPathText(value: string): void {
  assertUnicodeScalarSequence(value);
  if (value.includes("\u0000")) throw new PathTextError("path must not contain NUL");
}

export function assertCanonicalModulePath(value: string): void {
  assertValidPathText(value);
  if (value.length === 0) throw new PathTextError("module path must not be empty");
  if (value.startsWith("/")) throw new PathTextError("module path must be relative");
  if (value.includes("\\")) throw new PathTextError("module path must use POSIX separators");
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new PathTextError("module path contains a noncanonical segment");
  }
}

export function isUnicodeScalarBoundary(source: string, utf16Offset: number): boolean {
  if (utf16Offset <= 0 || utf16Offset >= source.length) return true;
  return !(
    isHighSurrogate(source.charCodeAt(utf16Offset - 1)) &&
    isLowSurrogate(source.charCodeAt(utf16Offset))
  );
}

export function utf8ByteOffset(source: string, utf16Offset: number): number {
  return Buffer.byteLength(source.slice(0, utf16Offset), "utf8");
}

export function digestSource(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}
