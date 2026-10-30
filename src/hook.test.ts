import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
// The launcher script has a `#!/usr/bin/env node` shebang; run it with the current runtime instead.
const lefthook = join(root, "node_modules", "lefthook", "bin", "index.js");
const probe = join("src", `hook-probe-${process.pid}-${Date.now()}.ts`);

async function preCommit(file: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [lefthook, "run", "pre-commit", "--file", file, "--no-tty"],
      { cwd: root },
    );
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: number; stdout?: string; stderr?: string };
    return { code: code ?? 1, output: `${stdout ?? ""}${stderr ?? ""}` };
  }
}

afterAll(() => rm(join(root, probe), { force: true }));

test("pre-commit hook skips the invalid fixtures", async () => {
  const result = await preCommit("test/fixtures/floating-promise/src/index.ts");
  assert.equal(result.code, 0, result.output);
});

test("pre-commit hook reports a real error", async () => {
  await writeFile(join(root, probe), "async function f(): Promise<void> {}\nf();\nexport { f };\n");
  const result = await preCommit(probe);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /no-floating-promises/);
});
