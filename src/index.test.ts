import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";
import { name } from "./index.ts";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const fixtures = join(root, "test", "fixtures");
const bin = join(root, "bin", "pulse-eslint.js");
const tsc = join(root, "node_modules", "typescript7", "bin", "tsc");
const sharedConfig = join(root, "eslint.config.js");

interface Outcome {
  isOk: boolean;
  output: string;
}

async function exec(file: string, args: string[], cwd: string): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [file, ...args], { cwd });
    return { isOk: true, output: stdout + stderr };
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    return { isOk: false, output: `${stdout ?? ""}${stderr ?? ""}` };
  }
}

function lint(fixture: string): Promise<Outcome> {
  return exec(bin, ["--config", sharedConfig, "."], join(fixtures, fixture));
}

function typecheck(fixture: string): Promise<Outcome> {
  return exec(tsc, ["--noEmit", "-p", join(fixtures, fixture)], root);
}

test("exports the package name", () => {
  assert.equal(name, "pulse-config");
});

describe("type-aware ESLint rules", () => {
  test("accept the clean fixture", async () => {
    const outcome = await lint("clean");
    assert.equal(outcome.isOk, true, outcome.output);
  });

  const cases = [
    ["floating-promise", "no-floating-promises"],
    ["misused-promise", "no-misused-promises"],
    ["non-exhaustive-switch", "switch-exhaustiveness-check"],
  ] as const;
  for (const [fixture, rule] of cases) {
    test(`report ${rule}`, async () => {
      const outcome = await lint(fixture);
      assert.equal(outcome.isOk, false);
      assert.match(outcome.output, new RegExp(rule));
    });
  }
});

describe("compiler flags", () => {
  test("accept the clean fixture", async () => {
    const outcome = await typecheck("clean");
    assert.equal(outcome.isOk, true, outcome.output);
  });

  const cases = [
    ["unchecked-index", "noUncheckedIndexedAccess"],
    ["implicit-return", "noImplicitReturns"],
    ["exact-optional", "exactOptionalPropertyTypes"],
  ] as const;
  for (const [fixture, flag] of cases) {
    test(`reject code that breaks ${flag}`, async () => {
      const outcome = await typecheck(fixture);
      assert.equal(outcome.isOk, false);
      assert.match(outcome.output, /error TS/);
    });
  }
});

describe("pulse-eslint from a consumer layout", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function consumer(fixture: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pulse-eslint-"));
    dirs.push(dir);
    const pkg = join(dir, "node_modules", "@lorenzh", "pulse-config");
    await mkdir(pkg, { recursive: true });
    await cp(join(root, "bin"), join(pkg, "bin"), { recursive: true });
    for (const file of ["eslint.config.js", "tsconfig.base.json", "package.json"]) {
      await cp(join(root, file), join(pkg, file));
    }
    // Nested install: the package brings its own lint toolchain.
    await symlink(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
    await cp(join(fixtures, fixture, "src"), join(dir, "src"), { recursive: true });
    const tsconfig = { extends: "@lorenzh/pulse-config/tsconfig.base.json", include: ["src"] };
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    return dir;
  }

  test("uses the shared config and its own ESLint", async () => {
    const dir = await consumer("floating-promise");
    const entry = join(dir, "node_modules", "@lorenzh", "pulse-config", "bin", "pulse-eslint.js");
    const outcome = await exec(entry, ["."], dir);
    assert.equal(outcome.isOk, false);
    assert.match(outcome.output, /no-floating-promises/);
  });

  test("passes a clean project", async () => {
    const dir = await consumer("clean");
    const entry = join(dir, "node_modules", "@lorenzh", "pulse-config", "bin", "pulse-eslint.js");
    const outcome = await exec(entry, ["."], dir);
    assert.equal(outcome.isOk, true, outcome.output);
  });
});
