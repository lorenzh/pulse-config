async function load(): Promise<number> {
  return 1;
}

export function run(): string {
  if (load()) {
    return "yes";
  }
  return "no";
}
