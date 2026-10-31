import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const workflowText = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
const workflow: unknown = Bun.YAML.parse(workflowText);

type Dict = Record<string, unknown>;

// A GitHub Actions expression as it appears in the workflow text.
function expr(body: string): string {
  return `$\{{ ${body} }}`;
}

function byText(a: string, b: string): number {
  return a.localeCompare(b);
}

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dict(value: unknown, what: string): Dict {
  if (!isDict(value)) assert.fail(`${what} is not a map`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) assert.fail(`${what} is not a list`);
  return value;
}

function jobs(doc: unknown): Dict {
  return dict(dict(doc, "workflow").jobs, "jobs");
}

function job(doc: unknown, name: string): Dict {
  return dict(jobs(doc)[name], `job ${name}`);
}

function steps(doc: unknown, name: string): Dict[] {
  return list(job(doc, name).steps, `steps of ${name}`).map((step) => dict(step, "step"));
}

function allSteps(doc: unknown): Dict[] {
  return Object.keys(jobs(doc)).flatMap((name) => steps(doc, name));
}

function runs(doc: unknown): string[] {
  return allSteps(doc).flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
}

function versionScript(doc: unknown, name: string): string {
  const step = steps(doc, name).find((candidate) => candidate.id === "version");
  if (step === undefined || typeof step.run !== "string") {
    assert.fail(`job ${name} has no run step with id version`);
  }
  return step.run;
}

function needs(doc: unknown, name: string): unknown[] {
  const value = job(doc, name).needs;
  return Array.isArray(value) ? value : [value];
}

// Version logic: run the real script of the step `id: version` in a throwaway git repository.

const git = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "tag.gpgSign=false",
];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Repo {
  dir: string;
  main: string;
  side: string;
}

async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...git, ...args], { cwd: dir });
  return stdout.trim();
}

async function makeRepo(mainTags: string[], sideTags: string[] = []): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), "pulse-release-"));
  dirs.push(dir);
  await gitIn(dir, ["init", "-q"]);
  await gitIn(dir, ["commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "main"]);
  const main = await gitIn(dir, ["rev-parse", "HEAD"]);
  await gitIn(dir, ["update-ref", "refs/remotes/origin/main", main]);
  const side = await gitIn(dir, ["commit-tree", "HEAD^{tree}", "-p", main, "-m", "side"]);
  for (const tag of mainTags) await gitIn(dir, ["tag", tag, main]);
  for (const tag of sideTags) await gitIn(dir, ["tag", tag, side]);
  return { dir, main, side };
}

interface Result {
  code: number;
  outputs: Map<string, string>;
  stderr: string;
}

async function runVersion(
  script: string,
  repo: Repo,
  env: { TAG: string; SHA: string; REPOSITORY?: string },
): Promise<Result> {
  const scriptFile = join(repo.dir, ".version.sh");
  const outputFile = join(repo.dir, ".github-output");
  await writeFile(scriptFile, script);
  await writeFile(outputFile, "");
  const fullEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    REPOSITORY: "lorenzh/pulse-probe",
    GITHUB_OUTPUT: outputFile,
    ...env,
  };
  let code = 0;
  let stderr = "";
  try {
    ({ stderr } = await run("bash", [scriptFile], { cwd: repo.dir, env: fullEnv }));
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    code = typeof failed.code === "number" ? failed.code : 1;
    stderr = failed.stderr ?? "";
  }
  const outputs = new Map<string, string>();
  for (const line of (await readFile(outputFile, "utf8")).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs.set(line.slice(0, at), line.slice(at + 1));
  }
  return { code, outputs, stderr };
}

describe("version script", () => {
  const script = versionScript(workflow, "version");

  const accepted = [
    { tag: "v0.1.0", present: [], tags: "0.1.0 0.1 0", prerelease: "false" },
    { tag: "v0.1.1", present: ["v0.1.0"], tags: "0.1.1 0.1 0", prerelease: "false" },
    { tag: "v0.1.5", present: ["v0.2.0"], tags: "0.1.5 0.1", prerelease: "false" },
    { tag: "v0.1.5", present: ["v0.1.7"], tags: "0.1.5", prerelease: "false" },
    { tag: "v0.0.0-rc.1", present: [], tags: "0.0.0-rc.1", prerelease: "true" },
    { tag: "v1.2.3-rc.1", present: ["v1.2.2"], tags: "1.2.3-rc.1", prerelease: "true" },
    { tag: "v0.10.0", present: ["v0.9.0"], tags: "0.10.0 0.10 0", prerelease: "false" },
    { tag: "v0.9.0", present: ["v0.10.0"], tags: "0.9.0 0.9", prerelease: "false" },
    { tag: "v0.2.1", present: ["v0.2.0", "v0.3.0-rc.1"], tags: "0.2.1 0.2 0", prerelease: "false" },
    { tag: "v10.20.30", present: [], tags: "10.20.30 10.20 10", prerelease: "false" },
    {
      tag: "v1.0.0-alpha.beta-1",
      present: [],
      tags: "1.0.0-alpha.beta-1",
      prerelease: "true",
    },
  ];
  for (const { tag, present, tags, prerelease } of accepted) {
    test(`${tag} with [${present.join(", ")}] pushes ${tags}`, async () => {
      const repo = await makeRepo([...present, tag]);
      const result = await runVersion(script, repo, { TAG: tag, SHA: repo.main });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.get("tags"), tags);
      assert.equal(result.outputs.get("prerelease"), prerelease);
      assert.equal(result.outputs.get("version"), tag.slice(1));
      assert.equal(result.outputs.get("image"), "ghcr.io/lorenzh/pulse-probe");
    });
  }

  const rejected = [
    "v1.2",
    "1.2.3",
    "v01.2.3",
    "v1.2.3+build.5",
    "v1.2.3-",
    "v1.2.3-rc..1",
    "v1.2.3-rc_1",
    "v1.2.3-$(id)",
    "vX.Y.Z",
    "release-1",
  ];
  for (const tag of rejected) {
    test(`rejects the tag ${tag}`, async () => {
      const repo = await makeRepo([]);
      const result = await runVersion(script, repo, { TAG: tag, SHA: repo.main });
      assert.notEqual(result.code, 0);
      assert.equal(result.outputs.has("tags"), false);
      assert.match(result.stderr, /Expected vX\.Y\.Z or vX\.Y\.Z-<pre-release>/);
    });
  }

  test("rejects a stable tag on a commit that is not on main", async () => {
    const repo = await makeRepo([], ["v0.2.0"]);
    const result = await runVersion(script, repo, { TAG: "v0.2.0", SHA: repo.side });
    assert.notEqual(result.code, 0);
    assert.equal(result.outputs.has("tags"), false);
    assert.match(result.stderr, /must point to a commit on main/);
  });

  test("accepts a pre-release tag on a commit that is not on main", async () => {
    const repo = await makeRepo([], ["v0.0.0-rc.2"]);
    const result = await runVersion(script, repo, { TAG: "v0.0.0-rc.2", SHA: repo.side });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.get("tags"), "0.0.0-rc.2");
  });

  test("rejects a repository name with upper-case letters", async () => {
    const repo = await makeRepo(["v0.1.0"]);
    const result = await runVersion(script, repo, {
      TAG: "v0.1.0",
      SHA: repo.main,
      REPOSITORY: "lorenzh/Pulse-Probe",
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.outputs.has("tags"), false);
  });

  test("publish recomputes the tags, so aliases never move back", async () => {
    const repo = await makeRepo(["v0.1.0"]);
    const early = await runVersion(script, repo, { TAG: "v0.1.0", SHA: repo.main });
    assert.equal(early.outputs.get("tags"), "0.1.0 0.1 0");
    await gitIn(repo.dir, ["tag", "v0.1.1", repo.main]);
    const late = await runVersion(versionScript(workflow, "publish"), repo, {
      TAG: "v0.1.0",
      SHA: repo.main,
    });
    assert.equal(late.code, 0, late.stderr);
    assert.equal(late.outputs.get("tags"), "0.1.0");
  });
});

// Structure: every rule passes on release.yml and fails on each mutated copy.

type Mutation = (text: string) => string;

function first(from: string, to: string): Mutation {
  return (text) => text.replace(from, to);
}

function last(from: string, to: string): Mutation {
  return (text) => {
    const at = text.lastIndexOf(from);
    return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length);
  };
}

interface Rule {
  name: string;
  check: (doc: unknown, text: string) => void;
  mutations: Mutation[];
}

const buildJobs = ["build-amd64", "build-arm64"];
const ociKeys = ["source", "revision", "version", "licenses"];
const extraStep = "      - name: Show the buildx version\n        run: docker buildx version\n";

function withStep(run: string): Mutation {
  return first(extraStep, `${extraStep}      - run: ${run}\n`);
}

function buildRuns(doc: unknown): string[] {
  return runs(doc).filter((script) => script.includes("docker buildx build"));
}

function attestStep(doc: unknown): Dict {
  const step = steps(doc, "publish").find(
    (candidate) =>
      typeof candidate.uses === "string" && candidate.uses.startsWith("actions/attest@"),
  );
  if (step === undefined) assert.fail("publish has no actions/attest step");
  return step;
}

const rules: Rule[] = [
  {
    name: "workflow permissions are empty",
    check: (doc) => assert.deepEqual(dict(doc, "workflow").permissions, {}),
    mutations: [first("permissions: {}\n", "permissions:\n  packages: write\n")],
  },
  {
    name: "each job declares exactly its permissions",
    check: (doc) => {
      const build = { contents: "read", packages: "write" };
      assert.deepEqual(job(doc, "version").permissions, { contents: "read" });
      assert.deepEqual(job(doc, "build-amd64").permissions, build);
      assert.deepEqual(job(doc, "build-arm64").permissions, build);
      assert.deepEqual(job(doc, "publish").permissions, {
        contents: "read",
        packages: "write",
        "id-token": "write",
        attestations: "write",
      });
      assert.deepEqual(
        Object.keys(jobs(doc)).sort(byText),
        [...buildJobs, "publish", "version"].sort(byText),
      );
    },
    mutations: [
      first(
        "      contents: read\n    outputs:\n",
        "      contents: read\n      packages: write\n    outputs:\n",
      ),
      first("      packages: write\n", "      packages: write\n      id-token: write\n"),
      last("      packages: write\n", "      packages: write\n      actions: write\n"),
    ],
  },
  {
    name: "publish waits for version and both builds",
    check: (doc) => {
      const publishNeeds = needs(doc, "publish");
      for (const name of ["version", ...buildJobs]) assert.ok(publishNeeds.includes(name), name);
    },
    mutations: [
      first("needs: [version, build-amd64, build-arm64]", "needs: [version, build-amd64]"),
      first("needs: [version, build-amd64, build-arm64]", "needs: [build-amd64, build-arm64]"),
    ],
  },
  {
    name: "both builds wait for version",
    check: (doc) => {
      for (const name of buildJobs) assert.deepEqual(needs(doc, name), ["version"], name);
    },
    mutations: [first("    needs: version\n", ""), last("    needs: version\n", "")],
  },
  {
    name: "publish runs one release per repository at a time",
    check: (doc) => {
      assert.deepEqual(job(doc, "publish").concurrency, {
        group: `release-${expr("github.repository")}`,
        "cancel-in-progress": false,
      });
    },
    mutations: [
      first(
        `release-${expr("github.repository")}`,
        `release-${expr("github.repository")}-${expr("github.ref")}`,
      ),
      first("cancel-in-progress: false", "cancel-in-progress: true"),
    ],
  },
  {
    name: "publish uses its own recomputed tags",
    check: (doc) => {
      assert.equal(
        JSON.stringify(job(doc, "publish")).includes("needs.version.outputs.tags"),
        false,
      );
      assert.equal(versionScript(doc, "publish"), versionScript(doc, "version"));
      const index = steps(doc, "publish").find((step) => step.id === "index");
      assert.equal(dict(index?.env, "index env").TAGS, expr("steps.version.outputs.tags"));
    },
    mutations: [
      first(
        `TAGS: ${expr("steps.version.outputs.tags")}`,
        `TAGS: ${expr("needs.version.outputs.tags")}`,
      ),
      last('tags="$tags $major"\n', 'tags="$tags $major"\n            tags="$tags 0"\n'),
    ],
  },
  {
    name: "every build uses the pinned builder",
    check: (doc) => {
      const scripts = buildRuns(doc);
      assert.equal(scripts.length, 2);
      for (const script of scripts)
        assert.match(script, /docker buildx build --builder pulse-release /);
      const creates = runs(doc).filter((script) => script.includes("docker buildx create"));
      assert.equal(creates.length, 2);
      for (const script of creates) {
        assert.match(script, /--name pulse-release --use /);
        assert.match(script, /--driver-opt image=moby\/buildkit:v0\.34\.1@sha256:[0-9a-f]{64}$/);
      }
    },
    mutations: [
      first("docker buildx build --builder pulse-release", "docker buildx build"),
      last("--name pulse-release --use", "--name pulse-release"),
    ],
  },
  {
    name: "builds set the labels and no buildx attestations",
    check: (doc) => {
      for (const script of buildRuns(doc)) {
        assert.match(script, /--provenance=false --sbom=false/);
        for (const key of [...ociKeys, "title"]) {
          assert.match(script, new RegExp(`--label "org\\.opencontainers\\.image\\.${key}=`), key);
        }
        assert.match(script, /push-by-digest=true,name-canonical=true,push=true/);
      }
      const index = runs(doc).find((script) => script.includes("imagetools create"));
      for (const key of ociKeys) {
        assert.match(
          index ?? "",
          new RegExp(`--annotation "index:org\\.opencontainers\\.image\\.${key}=`),
        );
      }
    },
    mutations: [
      first('--label "org.opencontainers.image.licenses=MIT"', ""),
      last("--provenance=false --sbom=false", "--sbom=false"),
      first('--annotation "index:org.opencontainers.image.revision=$SHA"', ""),
    ],
  },
  {
    name: "publish refuses a re-publish before it writes a tag",
    check: (doc) => {
      const scripts = steps(doc, "publish").map((step) =>
        typeof step.run === "string" ? step.run : "",
      );
      const refuse = scripts.findIndex((script) =>
        /if docker buildx imagetools inspect "\$IMAGE:\$VERSION" > \/dev\/null 2>&1; then\n.*version already published.*\n\s*exit 1/.test(
          script,
        ),
      );
      const create = scripts.findIndex((script) => script.includes("imagetools create"));
      assert.ok(refuse >= 0, "no re-publish check");
      assert.ok(refuse < create, "re-publish check runs after the index is written");
    },
    mutations: [
      first(
        "            exit 1\n          fi\n      - name: Create the multi-arch index",
        "          fi\n      - name: Create the multi-arch index",
      ),
    ],
  },
  {
    name: "every action is pinned by commit SHA with a version comment",
    check: (doc, text) => {
      for (const step of allSteps(doc)) {
        if (step.uses !== undefined) assert.match(String(step.uses), /^[^@]+@[0-9a-f]{40}$/);
      }
      const uses = text.split("\n").filter((line) => /^ *(?:- )?uses:/.test(line));
      assert.equal(uses.length, 5);
      for (const line of uses) assert.match(line, /uses: [^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      const actions = new Set(
        allSteps(doc).flatMap((step) => (step.uses === undefined ? [] : [String(step.uses)])),
      );
      assert.deepEqual([...actions].sort(byText), [
        "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      ]);
    },
    mutations: [
      first("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6", "actions/attest@v4.2.2"),
      first(" # v4.2.2", ""),
    ],
  },
  {
    name: "every checkout drops its credentials",
    check: (doc) => {
      const checkouts = allSteps(doc).filter((step) =>
        String(step.uses).startsWith("actions/checkout@"),
      );
      assert.equal(checkouts.length, 4);
      for (const step of checkouts)
        assert.equal(dict(step.with, "checkout with")["persist-credentials"], false);
    },
    mutations: [
      first("          persist-credentials: false\n", ""),
      last("persist-credentials: false", "persist-credentials: true"),
    ],
  },
  {
    name: "no run script interpolates an expression or a secret",
    check: (doc, text) => {
      for (const script of runs(doc)) assert.doesNotMatch(script, /\$\{\{/);
      assert.equal(text.includes("secrets."), false);
    },
    mutations: [
      withStep(`echo "${expr("github.ref_name")}"`),
      withStep(`echo "${expr("github.event.ref")}"`),
      first(`TOKEN: ${expr("github.token")}`, `TOKEN: ${expr("secrets.GHCR_TOKEN")}`),
    ],
  },
  {
    name: "no run pushes latest or edge",
    check: (doc) => {
      for (const script of runs(doc)) assert.doesNotMatch(script, /latest|edge/, script);
    },
    mutations: [
      withStep('docker buildx imagetools create -t "$IMAGE:latest" "$IMAGE:$VERSION"'),
      withStep('docker buildx imagetools create -t "$IMAGE:edge" "$IMAGE:$VERSION"'),
    ],
  },
  {
    name: "build-arm64 runs on the native arm64 runner",
    check: (doc) => {
      assert.equal(job(doc, "build-arm64")["runs-on"], "ubuntu-24.04-arm");
      assert.equal(job(doc, "build-amd64")["runs-on"], "ubuntu-24.04");
    },
    mutations: [first("runs-on: ubuntu-24.04-arm", "runs-on: ubuntu-24.04")],
  },
  {
    name: "attest pushes the provenance without a storage record",
    check: (doc) => {
      assert.deepEqual(attestStep(doc).with, {
        "subject-name": expr("steps.version.outputs.image"),
        "subject-digest": expr("steps.index.outputs.digest"),
        "push-to-registry": true,
        "create-storage-record": false,
      });
    },
    mutations: [
      first("create-storage-record: false", "create-storage-record: true"),
      first("push-to-registry: true", "push-to-registry: false"),
    ],
  },
];

describe("release.yml structure", () => {
  for (const rule of rules) {
    test(rule.name, () => {
      assert.doesNotThrow(() => rule.check(workflow, workflowText));
    });

    rule.mutations.forEach((mutate, index) => {
      test(`${rule.name}: rejects mutation ${index + 1}`, () => {
        const mutated = mutate(workflowText);
        assert.notEqual(mutated, workflowText, "the mutation did not change the workflow");
        assert.throws(() => rule.check(Bun.YAML.parse(mutated), mutated), assert.AssertionError);
      });
    });
  }
});
