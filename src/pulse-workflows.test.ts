import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const bin = join(root, "bin", "pulse-workflows.js");
const SENTINEL = "sentinel-value-598";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(workflow: string | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pulse-workflows-"));
  dirs.push(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@lorenzh/pulse-api" }));
  if (workflow !== undefined) {
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, ".github", "workflows", "ci.yml"), workflow);
  }
  return dir;
}

function run(cwd: string, script = bin): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const compliant = `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${SETUP_BUN}
`;

describe("pulse-workflows bin", () => {
  test("compliant project exits 0", async () => {
    const result = run(await project(compliant));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("pulse-workflows: ok (1 files, 2 uses)\n");
  });

  test("a checkout defect exits 1 without printing step values", async () => {
    const workflow = `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${CHECKOUT}
        env:
          TOKEN: ${SENTINEL}
        with:
          token: ${SENTINEL}
`;
    const result = run(await project(workflow));
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "pulse-workflows: ci.yml: jobs.build.steps[0]: actions/checkout needs with.persist-credentials: false\n",
    );
    expect(result.stderr).not.toContain(SENTINEL);
  });

  test("no workflow directory exits 1", async () => {
    const result = run(await project(undefined));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no workflow files");
  });

  test("a policy with one changed sha character rejects a compliant project", async () => {
    const layout = await mkdtemp(join(tmpdir(), "pulse-workflows-layout-"));
    dirs.push(layout);
    await cp(join(root, "bin"), join(layout, "bin"), { recursive: true });
    await cp(join(root, "src", "workflow-policy.ts"), join(layout, "src", "workflow-policy.ts"));
    const policy = await readFile(join(root, "actions-policy.json"), "utf8");
    const changed = policy.replace(
      "3d3c42e5aac5ba805825da76410c181273ba90b1",
      "3d3c42e5aac5ba805825da76410c181273ba90b2",
    );
    expect(changed).not.toBe(policy);
    await writeFile(join(layout, "actions-policy.json"), changed);
    const result = run(await project(compliant), join(layout, "bin", "pulse-workflows.js"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sha is not the approved");
  });

  test("this repository passes", () => {
    const result = run(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("pulse-workflows: ok (3 files,");
  });
});
