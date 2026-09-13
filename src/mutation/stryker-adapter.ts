import { MutationProtocolError, compareUtf8 } from "./protocol.js";

export interface ClosedStrykerConfig {
  readonly mutate: readonly string[];
  readonly testRunner: "vitest";
  readonly vitest: { readonly configFile?: string };
  readonly coverageAnalysis: "perTest";
  readonly mutator: {
    readonly excludedMutations: readonly [];
    readonly plugins: null;
  };
  readonly incremental: false;
  readonly force: true;
  readonly inPlace: false;
  readonly ignoreStatic: false;
  readonly disableTypeChecks: false;
  readonly ignorePatterns: readonly string[];
}

function canonicalPath(value: unknown, label: string, code = "invalidScopePath"): string {
  if (typeof value !== "string") {
    throw new MutationProtocolError(code, `${label} must be a canonical project-relative path`);
  }
  const components = value.split("/");
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    components.some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new MutationProtocolError(
      code,
      `${label} must be a canonical project-relative path`,
    );
  }
  return value;
}

function exactInventory(
  values: readonly unknown[],
  label: string,
  code = "invalidScopePath",
): readonly string[] {
  const inventory = values.map((value) => canonicalPath(value, label, code)).sort(compareUtf8);
  if (inventory.some((value, index) => value === inventory[index - 1])) {
    const duplicateCode = code === "invalidScopePath" ? "duplicateScopePath" : code;
    throw new MutationProtocolError(duplicateCode, `${label} contains a duplicate path`);
  }
  return inventory;
}

export function reportedProductionInventory(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new MutationProtocolError(
      "reportedProductionInventoryInvalid",
      "reported production inventory must be an array",
    );
  }
  return exactInventory(
    value,
    "reported production inventory",
    "reportedProductionInventoryInvalid",
  );
}

export function buildClosedStrykerConfig(
  productionFiles: readonly string[],
  testFiles: readonly string[],
  vitestConfigFile: string | null,
  supportFiles: readonly string[] = [],
): ClosedStrykerConfig {
  const mutate = exactInventory(productionFiles, "production scope");
  if (mutate.length === 0) {
    throw new MutationProtocolError("emptyProductionScope", "production scope must not be empty");
  }
  const tests = exactInventory(testFiles, "test scope");
  if (tests.length === 0) {
    throw new MutationProtocolError("emptyTestScope", "test scope must not be empty");
  }
  const vitest = vitestConfigFile === null ? {} : { configFile: canonicalPath(vitestConfigFile, "Vitest config file") };
  const support = exactInventory(supportFiles, "Stryker support inventory");
  const files = exactInventory([...mutate, ...tests, ...support], "Stryker file inventory");
  return {
    mutate,
    testRunner: "vitest",
    vitest,
    coverageAnalysis: "perTest",
    mutator: { excludedMutations: [], plugins: null },
    incremental: false,
    force: true,
    inPlace: false,
    ignoreStatic: false,
    disableTypeChecks: false,
    ignorePatterns: ["**", ...files.map((file) => `!${file}`)],
  };
}
