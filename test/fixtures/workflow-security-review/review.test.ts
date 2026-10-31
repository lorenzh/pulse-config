import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorkflows, parsePolicy } from "../../../src/workflow-policy.ts";

const root = join(import.meta.dirname, "../../..");
const bin = join(root, "bin/pulse-workflows.js");
const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const sentinel = "SECRET-SECURITY-598-DO-NOT-PRINT";
const rawPolicy = JSON.parse(readFileSync(join(root, "actions-policy.json"), "utf8"));
const parsedPolicy = parsePolicy(rawPolicy);
if (!parsedPolicy.isOk) throw new Error("shipped policy is invalid");
const policy = parsedPolicy.policy;

function workflow(step: unknown): string {
  return JSON.stringify({ on: "push", jobs: { build: { "runs-on": "ubuntu-24.04", steps: [step] } } });
}

function cli(text: string | undefined, pkg = '{"name":"@lorenzh/pulse-api"}', extra?: (dir: string) => void): { code: number | null; output: string } {
  const dir = mkdtempSync(join(root, "test/fixtures/workflow-security-review/run-"));
  try {
    writeFileSync(join(dir, "package.json"), pkg);
    if (text !== undefined) {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(join(dir, ".github/workflows/ci.yml"), text);
    }
    extra?.(dir);
    const result = spawnSync(process.execPath, [bin], { cwd: dir, encoding: "utf8", timeout: 5000 });
    return { code: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("security: CLI error paths never reveal env, with, run or secrets values", () => {
  const values = { env: { TOKEN: sentinel }, with: { token: sentinel }, run: sentinel, secrets: { TOKEN: sentinel } };
  const cases = [
    workflow({ uses: checkout, ...values }),
    workflow({ uses: "evil/action@main", ...values }),
    workflow({ uses: null, ...values }),
    workflow({ uses: 1, ...values }),
    workflow({ uses: { token: sentinel }, ...values }),
    `env: { TOKEN: ${sentinel} }\njobs: [`,
    JSON.stringify({ env: values.env, jobs: { build: { services: values, steps: [{ run: sentinel }] } } }),
    JSON.stringify({ env: values.env, jobs: { build: { container: values, steps: [{ run: sentinel }] } } }),
    JSON.stringify({ secrets: values.secrets, jobs: { build: { uses: values } } }),
  ];
  for (const text of cases) {
    const result = cli(text);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(sentinel);
  }
  for (const pkg of [`{"name":"${sentinel}",`, "null", "[]"]) {
    const result = cli(workflow({ run: "true" }), pkg);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(sentinel);
  }
});

test("security: wrong shapes and malformed YAML fail closed without throwing", () => {
  const values = [null, true, 1, "x", [], {}, { jobs: null }, { jobs: [] }, { jobs: {} }, { jobs: { build: null } }, { jobs: { build: { steps: null } } }, { jobs: { build: { steps: [null] } } }];
  for (const value of values) {
    const result = checkWorkflows({ files: [{ name: "ci.yml", text: JSON.stringify(value) }], packageJson: {}, policy });
    expect(result.violations.length).toBeGreaterThan(0);
  }
  for (const text of ["jobs: [", "jobs: &a [*a]", "jobs: !unknown []", "jobs: {}\n---\njobs: {}", "\0"]) {
    const result = checkWorkflows({ files: [{ name: "ci.yml", text }], packageJson: {}, policy });
    expect(result.violations.length).toBeGreaterThan(0);
  }
});

test("security: control characters, huge strings and dynamic action refs are rejected", () => {
  const refs = [checkout + "\n", checkout + "\r", checkout + "\t", "x".repeat(1000000), "${{ matrix.action }}", "./action", "docker://alpine:latest", "Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@main"];
  for (const uses of refs) {
    const result = checkWorkflows({ files: [{ name: "ci.yml", text: workflow({ uses, with: { "persist-credentials": false } }) }], packageJson: {}, policy });
    expect(result.violations.length).toBeGreaterThan(0);
  }
});

test("security: checkout credential flags are enforced independently", () => {
  for (const value of [undefined, null, true, "false", 0, [], {}, "${{ false }}"]) {
    const text = workflow({ uses: checkout, with: { "persist-credentials": value } });
    expect(cli(text).code).toBe(1);
  }
  expect(cli(workflow({ uses: checkout, with: { "persist-credentials": false } })).code).toBe(0);
  const text = `on: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n      - &checkout\n        uses: ${checkout}\n        with: {persist-credentials: false}\n      - <<: *checkout\n        with: {token: ${sentinel}}\n`;
  const result = cli(text);
  expect(result.code).toBe(1);
  expect(result.output).not.toContain(sentinel);
});

test("security: YAML prototype and constructor names do not hide jobs or steps", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const text = `jobs:\n  ${name}:\n    steps:\n      - uses: ${checkout}\n`;
    expect(cli(text).code).toBe(1);
  }
  expect(Object.hasOwn(Object.prototype, "jobs")).toBe(false);
});

test("security: hostile local policy cannot replace the shipped policy", () => {
  const result = cli(workflow({ uses: "evil/action@1111111111111111111111111111111111111111" }), undefined, (dir) => {
    writeFileSync(join(dir, "actions-policy.json"), JSON.stringify({ source: "attacker", actions: [{ uses: "evil/action", sha: "1111111111111111111111111111111111111111", version: "v1" }] }));
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain("action is not in the policy");
});

test("security: symlinked workflow content still receives policy validation", () => {
  const result = cli(workflow({ run: "true" }), undefined, (dir) => {
    writeFileSync(join(dir, "payload"), workflow({ uses: "evil/action@main" }));
    symlinkSync("../../payload", join(dir, ".github/workflows/linked.yaml"));
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain("linked.yaml");
});

test("security: invalid policy and malformed package diagnostics hide file contents", () => {
  const layout = mkdtempSync(join(root, "test/fixtures/workflow-security-review/layout-"));
  try {
    mkdirSync(join(layout, "bin"));
    mkdirSync(join(layout, "src"));
    cpSync(bin, join(layout, "bin/pulse-workflows.js"));
    cpSync(join(root, "src/workflow-policy.ts"), join(layout, "src/workflow-policy.ts"));
    for (const text of [sentinel, JSON.stringify({ source: sentinel, actions: [{ uses: sentinel, sha: sentinel, version: sentinel }] })]) {
      writeFileSync(join(layout, "actions-policy.json"), text);
      const result = spawnSync(process.execPath, [join(layout, "bin/pulse-workflows.js")], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toStartWith("actions-policy.json:");
      expect(result.stderr).not.toContain(sentinel);
    }
  } finally {
    rmSync(layout, { recursive: true, force: true });
  }
});
