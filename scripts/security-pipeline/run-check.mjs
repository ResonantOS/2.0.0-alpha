#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VALID_POLICIES = new Set(["observe", "warn", "block", "disabled"]);
const VALID_STATUSES = new Set(["pass", "warn", "fail", "skipped", "disabled"]);

function parseArgs(argv) {
  const args = {
    config: ".github/security-pipeline/checks.yml",
    list: false,
    check: null,
    family: null,
    certify: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      args.config = argv[++index];
    } else if (arg === "--list") {
      args.list = true;
    } else if (arg === "--check") {
      args.check = argv[++index];
    } else if (arg === "--family") {
      args.family = argv[++index];
    } else if (arg === "--certify") {
      args.certify = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/security-pipeline/run-check.mjs [options]

Options:
  --config <path>   Registry path. Defaults to .github/security-pipeline/checks.yml
  --list            List enabled checks
  --check <id>      Run a single check
  --family <name>   Run checks in a family
  --certify         Require every enabled check to pass
  --help            Show this help
`);
}

async function loadRegistry(configPath) {
  const raw = await readFile(configPath, "utf8");
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${configPath} must be JSON-compatible YAML for the current dependency-free runner: ${error.message}`
    );
  }
  validateRegistry(registry, configPath);
  return registry;
}

function validateRegistry(registry, configPath) {
  if (!registry || typeof registry !== "object") {
    throw new Error(`${configPath} must contain an object registry`);
  }
  if (registry.version !== 1) {
    throw new Error(`${configPath} must declare version 1`);
  }
  if (!registry.families || typeof registry.families !== "object") {
    throw new Error(`${configPath} must declare families`);
  }
  if (!Array.isArray(registry.checks)) {
    throw new Error(`${configPath} must declare checks as an array`);
  }
  if (registry.recordSets !== undefined &&
      (!registry.recordSets || typeof registry.recordSets !== "object" || Array.isArray(registry.recordSets))) {
    throw new Error(`${configPath} recordSets must be an object`);
  }

  for (const [recordSetId, records] of Object.entries(registry.recordSets ?? {})) {
    if (!Array.isArray(records)) {
      throw new Error(`Record set ${recordSetId} must be an array`);
    }
  }

  const ids = new Set();
  for (const check of registry.checks) {
    for (const field of ["id", "family", "policy", "adapter"]) {
      if (!check[field] || typeof check[field] !== "string") {
        throw new Error(`Check entry is missing string field: ${field}`);
      }
    }
    if (ids.has(check.id)) {
      throw new Error(`Duplicate check id: ${check.id}`);
    }
    ids.add(check.id);
    if (!registry.families[check.family]) {
      throw new Error(`Check ${check.id} references unknown family ${check.family}`);
    }
    if (!VALID_POLICIES.has(check.policy)) {
      throw new Error(`Check ${check.id} uses invalid policy ${check.policy}`);
    }
    if (check.recordSets !== undefined && !Array.isArray(check.recordSets)) {
      throw new Error(`Check ${check.id} recordSets must be an array`);
    }
    for (const recordSetId of check.recordSets ?? []) {
      if (!Array.isArray(registry.recordSets?.[recordSetId])) {
        throw new Error(`Check ${check.id} references unknown record set ${recordSetId}`);
      }
    }
  }
}

function selectChecks(registry, args) {
  let checks = registry.checks;
  if (args.family) {
    checks = checks.filter((check) => check.family === args.family);
  }
  if (args.check) {
    checks = checks.filter((check) => check.id === args.check);
  }
  if (checks.length === 0) {
    const scope = args.check ? `check ${args.check}` : `family ${args.family}`;
    throw new Error(`No checks matched ${scope}`);
  }
  return checks;
}

function listChecks(registry, checks) {
  for (const check of checks) {
    const family = registry.families[check.family];
    const familyStatus = family?.status ?? "unknown";
    console.log(`${check.id}\t${check.family}\t${familyStatus}\t${check.policy}\t${check.adapter}`);
  }
}

async function runCheck(check, registry, configPath) {
  if (check.policy === "disabled") {
    return normalizeResult(check, {
      status: "disabled",
      summary: "Check is disabled by registry policy.",
      evidence: []
    });
  }

  const adapterPath = path.resolve("scripts/security-pipeline/checks", `${check.adapter}.mjs`);
  if (!existsSync(adapterPath)) {
    return normalizeResult(check, {
      status: "fail",
      summary: `Adapter not found: ${adapterPath}`,
      evidence: []
    });
  }

  const adapter = await import(pathToFileURL(adapterPath));
  if (typeof adapter.run !== "function") {
    return normalizeResult(check, {
      status: "fail",
      summary: `Adapter ${adapterPath} does not export run().`,
      evidence: []
    });
  }

  const records = [
    ...(Array.isArray(check.records) ? check.records : []),
    ...(check.recordSets ?? []).flatMap((recordSetId) => registry.recordSets[recordSetId]),
  ];
  const result = await adapter.run({
    check: { ...check, records },
    registry,
    configPath,
    repoRoot: process.cwd()
  });
  return normalizeResult(check, result);
}

function normalizeResult(check, result) {
  const status = result?.status ?? "fail";
  if (!VALID_STATUSES.has(status)) {
    return {
      checkId: check.id,
      family: check.family,
      policy: check.policy,
      status: "fail",
      summary: `Adapter returned invalid status: ${status}`,
      evidence: []
    };
  }
  return {
    checkId: result.checkId ?? check.id,
    family: result.family ?? check.family,
    policy: result.policy ?? check.policy,
    status,
    summary: result.summary ?? "",
    evidence: Array.isArray(result.evidence) ? result.evidence : []
  };
}

function shouldFail(result, certify) {
  if (certify) {
    return ["skipped", "warn", "fail"].includes(result.status);
  }
  return result.policy === "block" && result.status === "fail";
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const registry = await loadRegistry(args.config);
  const checks = selectChecks(registry, args);

  if (args.list) {
    listChecks(registry, checks);
    return;
  }

  const results = [];
  for (const check of checks) {
    const result = await runCheck(check, registry, args.config);
    results.push(result);
    printResult(result);
  }

  if (results.some((result) => shouldFail(result, args.certify))) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`security-pipeline: ${error.message}`);
  process.exitCode = 1;
});
