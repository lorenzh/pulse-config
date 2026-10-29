export type Shape = "circle" | "square";

export function sides(shape: Shape): number {
  switch (shape) {
    case "circle":
      return 0;
    case "square":
      return 4;
    default: {
      const unreachable: never = shape;
      return unreachable;
    }
  }
}

export async function load(): Promise<number> {
  return 1;
}

export async function run(): Promise<number> {
  const first = [1][0];
  return (await load()) + (first ?? 0);
}
