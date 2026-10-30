# pulse-config

[![CI](https://github.com/lorenzh/pulse-config/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-config/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository holds the shared tooling configuration (Biome, TypeScript, SonarJS, Lefthook, CI) that the other pulse repositories extend. It has no product code.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.

## Files

| File                          | Use in a target                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `biome.json`                  | `"extends": ["@lorenzh/pulse-config/biome.json"]` (fallback: `./node_modules/@lorenzh/pulse-config/biome.json`)   |
| `tsconfig.base.json`          | `"extends": "@lorenzh/pulse-config/tsconfig.base.json"`; the target sets its own `include`                        |
| `bin/pulse-eslint.js`         | `pulse-eslint` bin: runs the ESLint of this package                                                               |
| `eslint.config.js`            | `import base from "@lorenzh/pulse-config/eslint.config.js"; export default [...base];`                            |
| `lefthook.yml`                | `extends` the file in `node_modules/@lorenzh/pulse-config`                                                        |
| `.github/workflows/check.yml` | `uses: lorenzh/pulse-config/.github/workflows/check.yml@<sha>`; input `build: true` adds Build and the dist check |

Targets run on Bun 1.4.0 (`"packageManager": "bun@1.4.0"`, `"engines": {"bun": "1.4.0"}`) and depend on `"@lorenzh/pulse-config": "github:lorenzh/pulse-config#<sha>"`. The lint toolchain (ESLint, SonarJS, TypeScript 6) is a `dependency` of this package, so the target root keeps TypeScript 7 as `typescript7`. `@types/bun` 1.4.0 is also a `dependency` of this package, and `tsconfig.base.json` sets `"types": ["node", "bun"]`. A target gets `@types/bun` through this package; if its install layout does not hoist it, add `@types/bun` 1.4.0 to its own `devDependencies`. Run ESLint with the `pulse-eslint` bin of this package (`pulse-eslint .` in a `lint` script, `bunx --no-install pulse-eslint` in `lefthook.yml`; the bin starts with `#!/usr/bin/env bun` and spawns ESLint with the running Bun). It finds its own ESLint whatever the `node_modules` layout, passes its arguments on, and uses the shared config when the target has no `eslint.config.*` and no `--config`.

The shared ESLint config does not ignore `.repos/`. If ESLint reaches a `.repos/` directory in a target (the Factory runner clone), add that ignore in the target's own `eslint.config.js`.

The shared ESLint config adds type-aware rules for `.ts` files (`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`) through `projectService` rooted at the working directory. Every linted `.ts` file must be in a `tsconfig.json` `include`. Type information comes from the bundled TypeScript 6, which accepts all options of `tsconfig.base.json`; `tsc` is TypeScript 7. The base also sets `noUncheckedIndexedAccess`, `noImplicitReturns` and `exactOptionalPropertyTypes`; see `AGENTS.md` for the opt-out of the last one.

`eslint.local.config.js` holds this repository's own ESLint ignores (`test/fixtures/**`, `.repos/**`). `bun run lint` and the pre-commit hook use it. It is not in `package.json` `files` or `exports`, so it is not shipped. To check the hook: `node_modules/.bin/lefthook run pre-commit --file test/fixtures/floating-promise/src/index.ts --no-tty` exits 0, and the same command on a file with an un-awaited promise fails with `no-floating-promises`.

In this repository TypeScript 7 is installed as `typescript7` (an npm alias), because the `typescript` dependency is 6.0.3. `bun run typecheck` uses `typescript7`, so `bunx tsc -v` here prints 6.0.3. `lefthook-local.yml` points the ESLint hook at the local binary.

## Updating the pin

1. Merge the change to `main` of `pulse-config`.
2. In each target, set the new SHA in `package.json` (`github:lorenzh/pulse-config#<sha>`) and refresh `bun.lock` (`bun install`).
3. Set the same SHA in the `uses:` ref of the target's `.github/workflows/ci.yml`.

The two pins change together. No check asserts that they match (`job.workflow_sha` is not checked), so this is a manual rule.

## Development

```sh
bun install --frozen-lockfile
bun run check   # lint, typecheck and tests
```

Licensed under the MIT licence, see [LICENSE](LICENSE).
