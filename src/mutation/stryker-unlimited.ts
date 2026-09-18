// The pinned backend has no configuration value that disables its deadline.
// Override the deadline decorator in this child process only; cancellation still
// terminates the process group and no installed dependency file is changed.
const decoratorUrl = new URL("../../node_modules/@stryker-mutator/core/dist/src/test-runner/timeout-decorator.js", import.meta.url).href;
const module = await import(decoratorUrl) as { TimeoutDecorator: { prototype: { run: (options: unknown, action: () => Promise<unknown>) => Promise<unknown> } } };
module.TimeoutDecorator.prototype.run = async (_options, action) => action();
const api = await import(new URL("../../node_modules/@stryker-mutator/core/dist/src/index.js", import.meta.url).href) as {
  Stryker: new (options: { configFile: string }) => { runMutationTest: () => Promise<unknown> };
};
const configFile = process.argv[3];
if (process.argv[2] !== "run" || configFile === undefined) throw new Error("strykerArgumentsInvalid");
const keepAlive = setInterval(() => {}, 60_000);
try {
  await new api.Stryker({ configFile }).runMutationTest();
} finally {
  clearInterval(keepAlive);
}
export {};
