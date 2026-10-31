#!/usr/bin/env bun
// Checks the workflows of the current repository against the action policy shipped next to this bin.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkflows, parsePolicy, violationLine } from "../src/workflow-policy.ts";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing or broken JSON is reported by the caller; the message could quote file content.
    return undefined;
  }
}

function readWorkflows(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    // No workflow directory: checkWorkflows reports "no workflow files".
    return [];
  }
  return names
    .filter((name) => /\.ya?ml$/.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

const policyResult = parsePolicy(
  readJson(fileURLToPath(new URL("../actions-policy.json", import.meta.url))),
);
if (!policyResult.isOk) {
  console.error(`actions-policy.json: ${policyResult.reason}`);
  process.exit(1);
}

const root = process.cwd();
const files = readWorkflows(join(root, ".github", "workflows"));
const result = checkWorkflows({
  files,
  packageJson: readJson(join(root, "package.json")),
  policy: policyResult.policy,
});
if (result.violations.length > 0) {
  for (const violation of result.violations) {
    console.error(`pulse-workflows: ${violationLine(violation)}`);
  }
  process.exit(1);
}
console.log(`pulse-workflows: ok (${files.length} files, ${result.uses} uses)`);
