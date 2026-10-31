import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkWorkflows,
  type Policy,
  parsePolicy,
  violationLine,
  type WorkflowFile,
} from "./workflow-policy.ts";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const UPLOAD = "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9";
const ATTEST = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";
const PIN = "1111111111111111111111111111111111111111";

const policy: Policy = {
  source: "test",
  actions: [
    {
      uses: "actions/checkout",
      sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
      version: "v7.0.1",
    },
    {
      uses: "oven-sh/setup-bun",
      sha: "0c5077e51419868618aeaa5fe8019c62421857d6",
      version: "v2.2.0",
    },
    {
      uses: "actions/attest",
      sha: "1e69f48acb82d1966a394da916b4c1698aa569d6",
      version: "v4.2.2",
      only: [{ package: "@lorenzh/pulse-config", workflow: "release.yml" }],
    },
    {
      uses: "actions/upload-artifact",
      sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
      version: "v7.0.2",
      only: [{ package: "@lorenzh/pulse-api", workflow: "bench.yml" }],
    },
  ],
};

const apiPackage = {
  name: "@lorenzh/pulse-api",
  devDependencies: { "@lorenzh/pulse-config": `github:lorenzh/pulse-config#${PIN}` },
};

function check(
  files: WorkflowFile[],
  packageJson: unknown = apiPackage,
): { lines: string[]; uses: number } {
  const result = checkWorkflows({ files, packageJson, policy });
  return { lines: result.violations.map(violationLine), uses: result.uses };
}

// One job `build` whose steps are the given YAML lines (each starting with "- ").
function job(steps: string, file = "ci.yml"): WorkflowFile {
  return {
    name: file,
    text: `on: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n${steps}`,
  };
}

const goodCheckout = `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n`;

const compliant: WorkflowFile[] = [
  {
    name: "ci.yml",
    text: `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${CHECKOUT}
        with:
          path: other
          persist-credentials: false
      - uses: ${SETUP_BUN}
        with:
          bun-version: 1.4.0
      - run: bun test
  check:
    uses: lorenzh/pulse-config/.github/workflows/check.yml@${PIN}
  release:
    uses: lorenzh/pulse-config/.github/workflows/release.yml@${PIN}
  local:
    uses: ./.github/workflows/bench.yml
`,
  },
  job(`${goodCheckout}      - uses: ${UPLOAD}\n`, "bench.yml"),
];

describe("compliant workflows", () => {
  test("give zero violations", () => {
    expect(check(compliant)).toEqual({ lines: [], uses: 8 });
  });
});

describe("rule 5: checkout persists no credentials", () => {
  test("checkout without with", () => {
    expect(check([job(`      - uses: ${CHECKOUT}\n`)]).lines).toEqual([
      "ci.yml: jobs.build.steps[0]: actions/checkout needs with.persist-credentials: false",
    ]);
  });

  test("second checkout without the key", () => {
    const lines = check([job(`${goodCheckout}      - uses: ${CHECKOUT}\n`)]).lines;
    expect(lines).toEqual([
      "ci.yml: jobs.build.steps[1]: actions/checkout needs with.persist-credentials: false",
    ]);
  });

  test.each([['"false"'], ["true"], [`\${{ false }}`]])("persist-credentials: %s", (value) => {
    const steps = `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: ${value}\n`;
    expect(check([job(steps)]).lines).toHaveLength(1);
  });

  test("key in job env or on another step does not count", () => {
    const file: WorkflowFile = {
      name: "ci.yml",
      text: `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      persist-credentials: false
    steps:
      - uses: ${SETUP_BUN}
        with:
          persist-credentials: false
      - uses: ${CHECKOUT}
`,
    };
    expect(check([file]).lines).toEqual([
      "ci.yml: jobs.build.steps[1]: actions/checkout needs with.persist-credentials: false",
    ]);
  });

  test("a comment is not the key", () => {
    const steps = `      - uses: ${CHECKOUT}\n        # persist-credentials: false\n`;
    expect(check([job(steps)]).lines).toHaveLength(1);
  });
});

describe("rules 2 and 3: action refs", () => {
  test.each([
    ["actions/checkout@v7"],
    ["actions/checkout@main"],
    ["actions/checkout@3d3c42e"],
    ["actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1"],
    ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b2"],
    ["actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09"],
  ])("%s gives a ref violation and a checkout violation", (uses) => {
    const lines = check([job(`      - uses: ${uses}\n`)]).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith(`ci.yml: jobs.build.steps[0]: uses ${uses}:`);
  });

  test("unknown action with an approved sha", () => {
    const uses = "evil/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
    expect(check([job(`      - uses: ${uses}\n`)]).lines).toEqual([
      `ci.yml: jobs.build.steps[0]: uses ${uses}: action is not in the policy`,
    ]);
  });

  test.each([
    [`\${{ matrix.action }}`],
    ["./.github/actions/setup"],
    ["docker://alpine:3"],
    ["github/codeql-action/init@3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ])("%s is rejected", (uses) => {
    expect(check([job(`      - uses: "${uses}"\n`)]).lines).toHaveLength(1);
  });

  test("a defect only in a .yaml file is reported", () => {
    const files = [...compliant, job(`      - uses: ${CHECKOUT}\n`, "x.yaml")];
    expect(check(files).lines).toEqual([
      "x.yaml: jobs.build.steps[0]: actions/checkout needs with.persist-credentials: false",
    ]);
  });
});

describe("rule 4: scoped approvals", () => {
  test("upload-artifact in ci.yml of api", () => {
    expect(check([job(`      - uses: ${UPLOAD}\n`)]).lines).toEqual([
      `ci.yml: jobs.build.steps[0]: uses ${UPLOAD}: action is not approved for this package and workflow`,
    ]);
  });

  test("upload-artifact in bench.yml of probe", () => {
    const probe = { ...apiPackage, name: "@lorenzh/pulse-probe" };
    expect(check([job(`      - uses: ${UPLOAD}\n`, "bench.yml")], probe).lines).toHaveLength(1);
  });

  test("attest in a service workflow", () => {
    expect(check([job(`      - uses: ${ATTEST}\n`, "release.yml")]).lines).toHaveLength(1);
  });

  test("attest in release.yml of pulse-config", () => {
    const pkg = { name: "@lorenzh/pulse-config" };
    expect(check([job(`      - uses: ${ATTEST}\n`, "release.yml")], pkg).lines).toEqual([]);
  });
});

describe("rule 6: reusable workflows", () => {
  function reusable(uses: string): WorkflowFile {
    return { name: "ci.yml", text: `on: push\njobs:\n  check:\n    uses: ${uses}\n` };
  }

  test.each([
    [`lorenzh/pulse-config/.github/workflows/release.yml@dc69a126bebbe50d8a7339ea1325d51b2ea43d7d`],
    ["lorenzh/pulse-config/.github/workflows/check.yml@main"],
    [`lorenzh/pulse-config/.github/workflows/other.yml@${PIN}`],
    [`lorenzh/pulse-kit/.github/workflows/check.yml@${PIN}`],
    ["./.github/workflows/missing.yml"],
  ])("%s is rejected", (uses) => {
    const lines = check([reusable(uses)]).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`ci.yml: jobs.check: uses ${uses}:`);
  });

  test("ref differs from the package.json pin", () => {
    const uses =
      "lorenzh/pulse-config/.github/workflows/release.yml@dc69a126bebbe50d8a7339ea1325d51b2ea43d7d";
    expect(check([reusable(uses)]).lines).toEqual([
      `ci.yml: jobs.check: uses ${uses}: ref differs from the package.json pin`,
    ]);
  });

  test("no config pin rejects every remote reusable workflow", () => {
    const uses = `lorenzh/pulse-config/.github/workflows/check.yml@${PIN}`;
    expect(check([reusable(uses)], { name: "@lorenzh/pulse-api" }).lines).toHaveLength(1);
  });
});

describe("rules 1, 7 and 8: shape", () => {
  test.each([
    ["jobs: [", "ci.yml: not valid YAML"],
    ["- a\n- b\n", "ci.yml: root is not a map"],
    ["on: push\njobs: {}\n", "ci.yml: jobs must be a non-empty map"],
    ["on: push\njobs:\n  a: 1\n", "ci.yml: jobs.a: job is not a map"],
    ['on: push\njobs:\n  a:\n    steps: "x"\n', "ci.yml: jobs.a: steps is not a list"],
    [
      "on: push\njobs:\n  a:\n    steps:\n      - x\n",
      "ci.yml: jobs.a.steps[0]: step is not a map",
    ],
  ])("%p", (text, line) => {
    expect(check([{ name: "ci.yml", text }]).lines).toEqual([line]);
  });

  test("container job", () => {
    const text = `on: push\njobs:\n  a:\n    container: node:22\n    steps:\n      - run: x\n`;
    expect(check([{ name: "ci.yml", text }]).lines).toEqual([
      "ci.yml: jobs.a: container and services are not covered by the action policy",
    ]);
  });

  test("job without steps", () => {
    const text = "on: push\njobs:\n  idle:\n    runs-on: ubuntu-24.04\n";
    expect(check([{ name: "ci.yml", text }]).lines).toEqual([
      "ci.yml: jobs.idle: job has no steps",
    ]);
  });

  test("job with empty steps", () => {
    const text = "on: push\njobs:\n  idle:\n    runs-on: ubuntu-24.04\n    steps: []\n";
    expect(check([{ name: "ci.yml", text }]).lines).toEqual([
      "ci.yml: jobs.idle: job has no steps",
    ]);
  });

  test("job with one setup-bun step", () => {
    const text = `on: push\njobs:\n  idle:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: ${SETUP_BUN}\n`;
    expect(check([{ name: "ci.yml", text }]).lines).toEqual([]);
  });

  test("no workflow files and no package.json", () => {
    expect(check([], null).lines).toEqual([
      "package.json: missing or not a JSON object",
      ".github/workflows: no workflow files",
    ]);
  });
});

describe("parsePolicy", () => {
  test.each([
    [null, "not an object"],
    [{ actions: [] }, "source must be a non-empty string"],
    [{ source: "s", actions: [] }, "actions must be a non-empty list"],
    [{ source: "s", actions: [1] }, "actions[0] is not an object"],
    [
      { source: "s", actions: [{ uses: "a", sha: "", version: "v" }] },
      "actions[0].uses must be <owner>/<repo>",
    ],
    [
      {
        source: "s",
        actions: [{ uses: "a/b", sha: "3D3C42E5AAC5BA805825DA76410C181273BA90B1", version: "v" }],
      },
      "actions[0].sha must be 40 lower-case hex characters",
    ],
    [
      { source: "s", actions: [{ uses: "a/b", sha: PIN }] },
      "actions[0].version must be a non-empty string",
    ],
    [
      { source: "s", actions: [{ uses: "a/b", sha: PIN, version: "v", only: [] }] },
      "actions[0].only must be a non-empty list",
    ],
    [
      { source: "s", actions: [{ uses: "a/b", sha: PIN, version: "v", only: [{ package: "p" }] }] },
      "actions[0].only entries need a package and a workflow",
    ],
    [
      {
        source: "s",
        actions: [
          { uses: "a/b", sha: PIN, version: "v" },
          { uses: "a/b", sha: PIN, version: "v" },
        ],
      },
      "duplicate uses a/b",
    ],
  ])("rejects %j", (value, reason) => {
    expect(parsePolicy(value)).toEqual({ isOk: false, reason });
  });

  test("the shipped policy matches docs/approved-packages.md", async () => {
    const text = await readFile(join(import.meta.dirname, "..", "actions-policy.json"), "utf8");
    const result = parsePolicy(JSON.parse(text));
    if (!result.isOk) throw new Error(result.reason);
    // Literals copied from lorenzh/pulse-meta docs/approved-packages.md, rows "Runtime and CI".
    expect(result.policy.actions.map((a) => [a.uses, a.sha])).toEqual([
      ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
      ["oven-sh/setup-bun", "0c5077e51419868618aeaa5fe8019c62421857d6"],
      ["actions/attest", "1e69f48acb82d1966a394da916b4c1698aa569d6"],
      ["actions/upload-artifact", "cf430e030ddbb5b0abf93d22962f4752f3646cd9"],
    ]);
  });
});
