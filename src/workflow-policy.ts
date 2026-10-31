// Checks GitHub Actions workflows against the approved action policy. Pure: the bin does the I/O.

export type PolicyScope = { package: string; workflow: string };

export type PolicyAction = {
  uses: string;
  sha: string;
  version: string;
  only?: PolicyScope[];
};

export type Policy = { source: string; actions: PolicyAction[] };

export type PolicyResult = { isOk: true; policy: Policy } | { isOk: false; reason: string };

export type Violation = { file: string; where: string; rule: string };

export type WorkflowFile = { name: string; text: string };

export type CheckInput = { files: WorkflowFile[]; packageJson: unknown; policy: Policy };

export type CheckResult = { violations: Violation[]; uses: number };

type Dict = Record<string, unknown>;

const shaPattern = /^[0-9a-f]{40}$/;
const actionPattern = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^@]*)$/;
const configWorkflowPattern =
  /^lorenzh\/pulse-config\/\.github\/workflows\/(check|release)\.yml@([^@]*)$/;
const configPinPattern = /^github:lorenzh\/pulse-config#([0-9a-f]{40})$/;
const localWorkflowPrefix = "./.github/workflows/";

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseScope(value: unknown): PolicyScope | undefined {
  if (!isDict(value)) return undefined;
  const { package: pkg, workflow } = value;
  if (!isNonEmptyString(pkg) || !isNonEmptyString(workflow)) return undefined;
  return { package: pkg, workflow };
}

type Parsed<T> = { value: T; reason?: undefined } | { value?: undefined; reason: string };

function parseScopes(value: unknown): Parsed<PolicyScope[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return { reason: "only must be a non-empty list" };
  }
  const scopes: PolicyScope[] = [];
  for (const item of value) {
    const scope = parseScope(item);
    if (scope === undefined) return { reason: "only entries need a package and a workflow" };
    scopes.push(scope);
  }
  return { value: scopes };
}

function parseAction(value: unknown, index: number): Parsed<PolicyAction> {
  const at = `actions[${index}]`;
  if (!isDict(value)) return { reason: `${at} is not an object` };
  const { uses, sha, version, only } = value;
  if (!isNonEmptyString(uses) || !/^[^/@\s]+\/[^/@\s]+$/.test(uses)) {
    return { reason: `${at}.uses must be <owner>/<repo>` };
  }
  if (typeof sha !== "string" || !shaPattern.test(sha)) {
    return { reason: `${at}.sha must be 40 lower-case hex characters` };
  }
  if (!isNonEmptyString(version)) return { reason: `${at}.version must be a non-empty string` };
  if (only === undefined) return { value: { uses, sha, version } };
  const scopes = parseScopes(only);
  if (scopes.value === undefined) return { reason: `${at}.${scopes.reason}` };
  return { value: { uses, sha, version, only: scopes.value } };
}

/** Validates the shape of `actions-policy.json`. Never throws. */
export function parsePolicy(value: unknown): PolicyResult {
  if (!isDict(value)) return { isOk: false, reason: "not an object" };
  if (!isNonEmptyString(value.source)) {
    return { isOk: false, reason: "source must be a non-empty string" };
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    return { isOk: false, reason: "actions must be a non-empty list" };
  }
  const actions: PolicyAction[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.actions.entries()) {
    const parsed = parseAction(item, index);
    const action = parsed.value;
    if (action === undefined) return { isOk: false, reason: parsed.reason ?? "invalid action" };
    if (seen.has(action.uses)) return { isOk: false, reason: `duplicate uses ${action.uses}` };
    seen.add(action.uses);
    actions.push(action);
  }
  return { isOk: true, policy: { source: value.source, actions } };
}

type Context = {
  file: string;
  packageName: string | undefined;
  configPin: string | undefined;
  localWorkflows: Set<string>;
  policy: Policy;
};

function readPackage(value: unknown): { name: string | undefined; pin: string | undefined } {
  if (!isDict(value)) return { name: undefined, pin: undefined };
  const name = typeof value.name === "string" ? value.name : undefined;
  let pin: string | undefined;
  for (const key of ["devDependencies", "dependencies"]) {
    const deps = value[key];
    const entry = isDict(deps) ? deps["@lorenzh/pulse-config"] : undefined;
    if (typeof entry === "string") {
      pin = configPinPattern.exec(entry)?.[1];
      break;
    }
  }
  return { name, pin };
}

function checkActionRef(uses: string, ctx: Context): string | undefined {
  if (uses.includes("${{")) return `uses ${uses}: expressions are not allowed`;
  const match = actionPattern.exec(uses);
  const repo = match?.[1];
  const sha = match?.[2];
  if (repo === undefined || sha === undefined) {
    return `uses ${uses}: must be <owner>/<repo>@<40-hex sha>`;
  }
  if (!shaPattern.test(sha)) return `uses ${uses}: ref must be a 40 lower-case hex sha`;
  const entry = ctx.policy.actions.find((action) => action.uses === repo);
  if (entry === undefined) return `uses ${uses}: action is not in the policy`;
  if (entry.sha !== sha) return `uses ${uses}: sha is not the approved ${entry.sha}`;
  const isInScope =
    entry.only === undefined ||
    entry.only.some((s) => s.package === ctx.packageName && s.workflow === ctx.file);
  if (!isInScope) return `uses ${uses}: action is not approved for this package and workflow`;
  return undefined;
}

function isCheckout(uses: string): boolean {
  return uses.startsWith("actions/checkout@");
}

function hasNoPersistedCredentials(step: Dict): boolean {
  const withMap = step.with;
  return isDict(withMap) && Object.hasOwn(withMap, "persist-credentials")
    ? withMap["persist-credentials"] === false
    : false;
}

function checkStep(step: unknown, ctx: Context): string[] {
  if (!isDict(step)) return ["step is not a map"];
  if (!Object.hasOwn(step, "uses")) return [];
  const uses = step.uses;
  if (typeof uses !== "string") return ["uses is not a string"];
  const rules: string[] = [];
  const refRule = checkActionRef(uses, ctx);
  if (refRule !== undefined) rules.push(refRule);
  if (isCheckout(uses) && !hasNoPersistedCredentials(step)) {
    rules.push("actions/checkout needs with.persist-credentials: false");
  }
  return rules;
}

function checkReusable(uses: unknown, ctx: Context): string | undefined {
  if (typeof uses !== "string") return "uses is not a string";
  if (uses.startsWith(localWorkflowPrefix)) {
    const name = uses.slice(localWorkflowPrefix.length);
    return ctx.localWorkflows.has(name) ? undefined : `uses ${uses}: no such workflow file`;
  }
  const match = configWorkflowPattern.exec(uses);
  const sha = match?.[2];
  if (sha === undefined) return `uses ${uses}: reusable workflow is not allowed`;
  if (ctx.configPin === undefined) {
    return `uses ${uses}: package.json has no github:lorenzh/pulse-config#<sha> pin`;
  }
  if (sha !== ctx.configPin) return `uses ${uses}: ref differs from the package.json pin`;
  return undefined;
}

function checkSteps(steps: unknown, where: string, ctx: Context): Violation[] {
  if (!Array.isArray(steps)) return [{ file: ctx.file, where, rule: "steps is not a list" }];
  const violations: Violation[] = [];
  for (const [index, step] of steps.entries()) {
    for (const rule of checkStep(step, ctx)) {
      violations.push({ file: ctx.file, where: `${where}.steps[${index}]`, rule });
    }
  }
  return violations;
}

function checkJob(name: string, job: unknown, ctx: Context): Violation[] {
  const where = `jobs.${name}`;
  const at = (rule: string): Violation => ({ file: ctx.file, where, rule });
  if (!isDict(job)) return [at("job is not a map")];
  const violations: Violation[] = [];
  if (Object.hasOwn(job, "container") || Object.hasOwn(job, "services")) {
    violations.push(at("container and services are not covered by the action policy"));
  }
  const hasUses = Object.hasOwn(job, "uses");
  if (hasUses) {
    const rule = checkReusable(job.uses, ctx);
    if (rule !== undefined) violations.push(at(rule));
  }
  if (Object.hasOwn(job, "steps")) violations.push(...checkSteps(job.steps, where, ctx));
  const hasSteps = Array.isArray(job.steps) && job.steps.length > 0;
  if (!hasSteps && !hasUses && (job.steps === undefined || Array.isArray(job.steps))) {
    violations.push(at("job has no steps"));
  }
  return violations;
}

function parseYaml(text: string): { isOk: true; value: unknown } | { isOk: false } {
  try {
    return { isOk: true, value: Bun.YAML.parse(text) };
  } catch {
    // The parser message may quote file content, so only the fact of the failure is reported.
    return { isOk: false };
  }
}

function checkFile(file: WorkflowFile, ctx: Context): Violation[] {
  const at = (rule: string): Violation => ({ file: file.name, where: "", rule });
  const parsed = parseYaml(file.text);
  if (!parsed.isOk) return [at("not valid YAML")];
  const doc = parsed.value;
  if (!isDict(doc)) return [at("root is not a map")];
  const jobs = doc.jobs;
  if (!isDict(jobs) || Object.keys(jobs).length === 0) return [at("jobs must be a non-empty map")];
  return Object.entries(jobs).flatMap(([name, job]) => checkJob(name, job, ctx));
}

function countUses(file: WorkflowFile): number {
  const parsed = parseYaml(file.text);
  if (!parsed.isOk || !isDict(parsed.value) || !isDict(parsed.value.jobs)) return 0;
  let count = 0;
  for (const job of Object.values(parsed.value.jobs)) {
    if (!isDict(job)) continue;
    if (job.uses !== undefined) count += 1;
    if (Array.isArray(job.steps)) {
      count += job.steps.filter((step) => isDict(step) && step.uses !== undefined).length;
    }
  }
  return count;
}

/** Returns every policy violation of the workflow files. */
export function checkWorkflows(input: CheckInput): CheckResult {
  const pkg = readPackage(input.packageJson);
  const violations: Violation[] = [];
  if (!isDict(input.packageJson)) {
    violations.push({ file: "package.json", where: "", rule: "missing or not a JSON object" });
  }
  if (input.files.length === 0) {
    violations.push({ file: ".github/workflows", where: "", rule: "no workflow files" });
  }
  const localWorkflows = new Set(input.files.map((file) => file.name));
  for (const file of input.files) {
    const ctx: Context = {
      file: file.name,
      packageName: pkg.name,
      configPin: pkg.pin,
      localWorkflows,
      policy: input.policy,
    };
    violations.push(...checkFile(file, ctx));
  }
  const uses = input.files.reduce((sum, file) => sum + countUses(file), 0);
  return { violations, uses };
}

/** One output line for a violation. */
export function violationLine(violation: Violation): string {
  return violation.where === ""
    ? `${violation.file}: ${violation.rule}`
    : `${violation.file}: ${violation.where}: ${violation.rule}`;
}
