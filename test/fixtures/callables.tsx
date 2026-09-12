const marker = "한글";

export function plain(flag: boolean) {
  if (flag && marker.length > 0) {
    return 1;
  }
  return 0;
}

export async function load(items: number[]) {
  for (const item of items) {
    if (item > 0) await Promise.resolve(item);
  }
}

export class Counter {
  constructor() {}
  get value() { return 1; }
  set value(next: number) {
    if (next < 0) throw new Error("negative");
  }

  method(input: number) {
    function nested(flag: boolean) {
      const normalized = flag;
      return normalized ? 1 : 0;
    }
    const expression = function (value: number) {
      return value > 0 && input > 0;
    };
    const arrow = (value: number) => value > 0 || input > 0;
    return nested(input > 0) + expression(input) + Number(arrow(input));
  }
}

export function Component() {
  return <button onClick={() => true ? "yes" : "no"}>Go</button>;
}
