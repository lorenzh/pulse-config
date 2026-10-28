# pulse-config

[![CI](https://github.com/lorenzh/pulse-config/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-config/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository will hold the shared tooling configuration (Biome, TypeScript, SonarJS, Lefthook, CI) that the other pulse repositories extend. It has no product code yet.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Development

```sh
npm ci
npm run check   # lint, typecheck and tests
```

Licensed under the MIT licence, see [LICENSE](LICENSE).
