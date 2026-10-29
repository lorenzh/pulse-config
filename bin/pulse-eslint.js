#!/usr/bin/env node
// Runs the ESLint that ships with pulse-config, whatever the layout of node_modules.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const localConfigs = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
];

const eslintPackageJson = fileURLToPath(import.meta.resolve("eslint/package.json"));
const manifest = JSON.parse(readFileSync(eslintPackageJson, "utf8"));
const eslintBin = join(dirname(eslintPackageJson), manifest.bin.eslint);

const args = process.argv.slice(2);
const hasConfigFlag = args.some((arg) => arg === "-c" || arg.startsWith("--config"));
const hasLocalConfig = localConfigs.some((name) => existsSync(join(process.cwd(), name)));
if (!hasConfigFlag && !hasLocalConfig) {
  args.unshift("--config", fileURLToPath(new URL("../eslint.config.js", import.meta.url)));
}

const result = spawnSync(process.execPath, [eslintBin, ...args], { stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
