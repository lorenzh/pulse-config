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
| `eslint.config.js`            | `import base from "@lorenzh/pulse-config/eslint.config.js"; export default [...base];`                            |
| `lefthook.yml`                | `extends` the file in `node_modules/@lorenzh/pulse-config`                                                        |
| `.github/workflows/check.yml` | `uses: lorenzh/pulse-config/.github/workflows/check.yml@<sha>`; input `build: true` adds Build and the dist check |

Targets depend on `"@lorenzh/pulse-config": "github:lorenzh/pulse-config#<sha>"` and set `install-strategy=nested` in `.npmrc`. The lint toolchain (ESLint, SonarJS, TypeScript 6) is a `dependency` of this package. It is installed nested inside it, so the target root keeps TypeScript 7. Run ESLint with `node node_modules/@lorenzh/pulse-config/node_modules/eslint/bin/eslint.js`.

The shared ESLint config does not ignore `.repos/`. If ESLint reaches a `.repos/` directory in a target (the Factory runner clone), add that ignore in the target's own `eslint.config.js`.

In this repository TypeScript 7 is installed as `typescript7` (an npm alias), because the `typescript` dependency is 6.0.3. `npm run typecheck` uses `typescript7`, so `npx tsc -v` here prints 6.0.3. `lefthook-local.yml` points the ESLint hook at the local binary.

## Updating the pin

1. Merge the change to `main` of `pulse-config`.
2. In each target, set the new SHA in `package.json` (`github:lorenzh/pulse-config#<sha>`) and refresh `package-lock.json`.
3. Set the same SHA in the `uses:` ref of the target's `.github/workflows/ci.yml`.

The two pins change together. No check asserts that they match (`job.workflow_sha` is not checked), so this is a manual rule.

## Development

```sh
npm ci
npm run check   # lint, typecheck and tests
```

Licensed under the MIT licence, see [LICENSE](LICENSE).
