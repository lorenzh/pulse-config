# pulse-config

[![CI](https://github.com/lorenzh/pulse-config/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-config/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository holds the shared tooling configuration (Biome, TypeScript, SonarJS, Lefthook, CI) that the other pulse repositories extend. It has no product code.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.

## Files

| File                            | Use in a target                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `biome.json`                    | `"extends": ["@lorenzh/pulse-config/biome.json"]` (fallback: `./node_modules/@lorenzh/pulse-config/biome.json`)                |
| `tsconfig.base.json`            | `"extends": "@lorenzh/pulse-config/tsconfig.base.json"`; the target sets its own `include`                                     |
| `bin/pulse-eslint.js`           | `pulse-eslint` bin: runs the ESLint of this package                                                                            |
| `bin/pulse-workflows.js`        | `pulse-workflows` bin: checks the target's workflows; see [pulse-workflows](#pulse-workflows)                                  |
| `actions-policy.json`           | Approved actions for `pulse-workflows`; read by the bin, not by the target                                                     |
| `eslint.config.js`              | `import base from "@lorenzh/pulse-config/eslint.config.js"; export default [...base];`                                         |
| `lefthook.yml`                  | `extends` the file in `node_modules/@lorenzh/pulse-config`                                                                     |
| `.github/workflows/check.yml`   | `uses: lorenzh/pulse-config/.github/workflows/check.yml@<sha>`; input `build: true` adds Build and the dist check              |
| `.github/workflows/release.yml` | `uses: lorenzh/pulse-config/.github/workflows/release.yml@<sha>` in a `release` job; see [Releasing images](#releasing-images) |

Targets run on Bun 1.4.0 (`"packageManager": "bun@1.4.0"`, `"engines": {"bun": "1.4.0"}`) and depend on `"@lorenzh/pulse-config": "github:lorenzh/pulse-config#<sha>"`. The lint toolchain (ESLint, SonarJS, TypeScript 6) is a `dependency` of this package, so the target root keeps TypeScript 7 as `typescript7`. `@types/bun` 1.4.0 is also a `dependency` of this package, and `tsconfig.base.json` sets `"types": ["node", "bun"]`. A target gets `@types/bun` through this package; if its install layout does not hoist it, add `@types/bun` 1.4.0 to its own `devDependencies`. Run ESLint with the `pulse-eslint` bin of this package (`pulse-eslint .` in a `lint` script, `bunx --no-install pulse-eslint` in `lefthook.yml`; the bin starts with `#!/usr/bin/env bun` and spawns ESLint with the running Bun). It finds its own ESLint whatever the `node_modules` layout, passes its arguments on, and uses the shared config when the target has no `eslint.config.*` and no `--config`.

The shared ESLint config does not ignore `.repos/`. If ESLint reaches a `.repos/` directory in a target (the Factory runner clone), add that ignore in the target's own `eslint.config.js`.

The shared ESLint config adds type-aware rules for `.ts` files (`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`) through `projectService` rooted at the working directory. Every linted `.ts` file must be in a `tsconfig.json` `include`. Type information comes from the bundled TypeScript 6, which accepts all options of `tsconfig.base.json`; `tsc` is TypeScript 7. The base also sets `noUncheckedIndexedAccess`, `noImplicitReturns` and `exactOptionalPropertyTypes`; see `AGENTS.md` for the opt-out of the last one.

`eslint.local.config.js` holds this repository's own ESLint ignores (`test/fixtures/**`, `.repos/**`). `bun run lint` and the pre-commit hook use it. It is not in `package.json` `files` or `exports`, so it is not shipped. To check the hook: `node_modules/.bin/lefthook run pre-commit --file test/fixtures/floating-promise/src/index.ts --no-tty` exits 0, and the same command on a file with an un-awaited promise fails with `no-floating-promises`.

In this repository TypeScript 7 is installed as `typescript7` (an npm alias), because the `typescript` dependency is 6.0.3. `bun run typecheck` uses `typescript7`, so `bunx tsc -v` here prints 6.0.3. `lefthook-local.yml` points the ESLint hook at the local binary.

## Releasing images

`release.yml` is a reusable workflow (`workflow_call`, no inputs). A service calls it from its `ci.yml` when someone pushes a tag `vX.Y.Z`. It builds the image natively on `ubuntu-24.04` (linux/amd64) and `ubuntu-24.04-arm` (linux/arm64), merges both into one index, and pushes it to `ghcr.io/<repository>`, for example `ghcr.io/lorenzh/pulse-probe`. The index has a GitHub artifact attestation (SLSA build provenance). This repository does not call it.

The caller runs on `v*` tags and adds a `release` job after its gate jobs:

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref_type != 'tag' }}

jobs:
  # check, docker, ... as before
  release:
    if: github.ref_type == 'tag'
    needs: [check, docker]
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    uses: lorenzh/pulse-config/.github/workflows/release.yml@<sha>
```

- The job must grant exactly these four permissions; a reusable workflow gets no more than its caller grants.
- `needs` lists every gate job. The `if` has no status function (`always()`, `!cancelled()`), so a failed, cancelled or skipped gate skips the release.
- A push to `main` or a pull request publishes nothing.

Jobs: `version` checks the tag and computes the image tags; `build-amd64` and `build-arm64` push one image each by digest; `publish` creates the index with all tags and attests it. The builds use a BuildKit builder pinned by digest and no buildx attestations, so the index lists exactly the two platforms. Each platform image has the labels `org.opencontainers.image.source`, `revision`, `version`, `licenses` (`MIT`) and `title`. The index has the first four as annotations.

### Tag rules

- A tag must match `vX.Y.Z` or `vX.Y.Z-<pre-release>` (SemVer without build metadata, no leading zeros). Any other tag fails the `version` job, and nothing is built or pushed. The repository name must be lower case.
- A stable tag must point to a commit on `main`. A pre-release tag may point anywhere, for example to a test branch.
- The image tags come from the git tag. `package.json` `version` is not used.

| Git tag                             | Image tags    |
| ----------------------------------- | ------------- |
| `v0.1.0` (first stable)             | `0.1.0 0.1 0` |
| `v0.1.1` with `v0.1.0` present      | `0.1.1 0.1 0` |
| `v0.1.5` with `v0.2.0` present      | `0.1.5 0.1`   |
| `v0.1.5` with `v0.1.7` present      | `0.1.5`       |
| `v0.0.0-rc.1`                       | `0.0.0-rc.1`  |
| `v1.2.3-rc.1` with `v1.2.2` present | `1.2.3-rc.1`  |

`X.Y` moves only to the highest stable `vX.Y.*` tag, `X` only to the highest stable `vX.*.*` tag. Versions compare as numbers (`v0.10.0` is above `v0.9.0`), and pre-release tags never count. `publish` computes the tags again when it runs, so an older release that finishes late never moves an alias back. There is no `latest` and no `edge` tag. `0` moves across breaking 0.x minors, so a setup pins `X.Y.Z` by digest.

A release builds the image again from the tagged commit. Its content matches the image that the gate checked, but the digest can differ by timestamps.

### Re-publish

`publish` fails with "version already published" when `ghcr.io/<repository>:X.Y.Z` exists, before it writes any tag. A moved or re-pushed git tag never overwrites a released version. Never move a release tag; push a new version instead. The per-platform digests of such a run stay in the package as untagged versions. They are harmless.

### Owner steps

A person pushes release tags; a tag pushed with a job's `GITHUB_TOKEN` starts no workflow.

```sh
git tag vX.Y.Z <sha on main> && git push origin vX.Y.Z
gh attestation verify oci://ghcr.io/lorenzh/pulse-<service>:X.Y.Z --owner lorenzh
```

- Visibility: a new package under the user account starts private. Make it public once in the package settings on GitHub. There is no REST endpoint for this.
- Cleanup: delete a test tag with `git push origin :refs/tags/<tag>`, and its package version (with its untagged platform digests) with `gh api -X DELETE /user/packages/container/pulse-<service>/versions/<id>`.

## pulse-workflows

`pulse-workflows` checks the GitHub Actions workflows of the repository in the working directory. A target runs it in its `lint` script:

```json
"lint": "biome check . && pulse-eslint . && pulse-workflows"
```

It reads every top-level `.github/workflows/*.yml` and `*.yaml` file and the root `package.json`. It prints `pulse-workflows: ok (<n> files, <m> uses)` and exits `0`, or prints one line per violation to stderr (`<file>: jobs.<job>[.steps[<i>]]: <rule>`) and exits `1`. A line may name the `uses` value, never `with`, `env`, `run` or `secrets` values.

Rules:

1. Every file parses as YAML, its root is a map with a non-empty `jobs` map, each job is a map, and `steps` is a list of maps.
2. A step `uses` is `<owner>/<repo>@<sha>` with a 40 lower-case hex SHA. Tags, branches, short SHAs, sub-path actions, local actions, `docker://` and expressions fail.
3. `<owner>/<repo>` is in the policy, with exactly its SHA.
4. An action with `only` is allowed only for the listed `package.json` `name` and workflow file name.
5. Every `actions/checkout` step has `with: { persist-credentials: false }` (the boolean, on that step).
6. A job-level `uses` is `./.github/workflows/<file>` of a checked file, or `lorenzh/pulse-config/.github/workflows/check.yml@<sha>` or `release.yml@<sha>` where `<sha>` equals the `github:lorenzh/pulse-config#<sha>` pin of `package.json`.
7. A job with `container` or `services` fails: the policy does not cover their images.
8. A job without steps and without `uses` fails.

The policy `actions-policy.json` ships next to the bin; the bin never reads a policy from the checked repository. It is a snapshot of the target rows of "Runtime and CI" in `docs/approved-packages.md` of pulse-meta, and its `source` names that commit. A malformed policy makes the bin exit `1` with `actions-policy.json: <reason>`.

To approve a new action or pin: first a pulse-meta PR changes `docs/approved-packages.md`, then a pulse-config PR changes `actions-policy.json`, then the targets update their pin.

## Updating the pin

1. Merge the change to `main` of `pulse-config`.
2. In each target, set the new SHA in `package.json` (`github:lorenzh/pulse-config#<sha>`) and refresh `bun.lock` (`bun install`).
3. Set the same SHA in both `uses:` refs of the target's `.github/workflows/ci.yml`: `check.yml` and `release.yml`.

The pins change together. `pulse-workflows` fails when a `uses:` ref differs from the `package.json` pin.

## Development

```sh
bun install --frozen-lockfile
bun run check   # lint, typecheck and tests
```

Licensed under the MIT licence, see [LICENSE](LICENSE).
