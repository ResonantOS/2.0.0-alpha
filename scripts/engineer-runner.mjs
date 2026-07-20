#!/usr/bin/env node
/**
 * Engineer Runner: deterministic guardrails around local coding agents.
 *
 * The runner treats OpenCode/Qwen/Hermes output as untrusted until the repo
 * state passes objective checks: changed-file scope and required commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const VALID_STATUSES = new Set(["verified", "failed"]);

function toPortablePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function loadTaskContract(contractPath) {
  if (!contractPath) {
    throw new Error("Missing task contract path.");
  }
  const resolvedPath = resolve(contractPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Task contract not found: ${resolvedPath}`);
  }
  return normalizeTaskContract(JSON.parse(readFileSync(resolvedPath, "utf-8")), resolvedPath);
}

export function normalizeTaskContract(input, sourcePath = "<inline>") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Task contract must be a JSON object.");
  }
  const repo = normalizeRequiredString(input.repo, "repo");
  const goal = normalizeRequiredString(input.goal, "goal");
  const allowedFiles = normalizeStringList(input.allowedFiles, "allowedFiles");
  const requiredCommands = normalizeStringList(input.requiredCommands ?? input.commands ?? [], "requiredCommands");
  const requirements = normalizeStringList(input.requirements ?? [], "requirements");
  const repoPath = resolve(repo);
  if (!existsSync(repoPath)) {
    throw new Error(`Task repo does not exist: ${repoPath}`);
  }
  if (!allowedFiles.length) {
    throw new Error("Task contract must include at least one allowed file.");
  }
  const normalizedAllowedFiles = allowedFiles.map((file) => normalizeRepoRelativePath(file, repoPath, "allowedFiles"));
  return {
    schemaVersion: input.schemaVersion ?? 1,
    sourcePath,
    repo: repoPath,
    goal,
    allowedFiles: Array.from(new Set(normalizedAllowedFiles)).sort(),
    requiredCommands,
    requirements,
  };
}

export function buildOpenCodePrompt(contract) {
  const requirementsBlock = contract.requirements.length
    ? contract.requirements.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "No extra requirements were listed. Infer the smallest implementation that satisfies the goal.";
  const commandBlock = contract.requiredCommands.length
    ? contract.requiredCommands.map((command) => `- ${command}`).join("\n")
    : "- No required commands listed. Run the narrowest deterministic checks available.";
  return `Work in ${contract.repo}.

Goal:
${contract.goal}

Allowed files:
${contract.allowedFiles.map((file) => `- ${file}`).join("\n")}

Do not edit any file outside the allowed file list. If you believe another file must change, stop and report the reason instead of editing it.

Requirements:
${requirementsBlock}

Required verification commands:
${commandBlock}

Use the local model engineering loop:
1. Implement pass
2. Review pass
3. Fix pass
4. Verification pass

In the Review pass, trace every explicit requirement against the implementation and tests. Do not treat your own tests as proof of correctness.
In the Verification pass, run the required commands and direct spot checks for externally visible behavior.
Final response must include: Files changed, Review pass, Fix pass, Verification, Residual risk.`;
}

export function listChangedFiles(repo) {
  const result = runCommand(repo, "git status --porcelain --untracked-files=all", { timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect git status: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return parseGitStatusPorcelain(result.stdout);
}

export function parseGitStatusPorcelain(stdout) {
  const changed = new Set();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    const pathSpec = line.slice(3);
    if (!pathSpec) {
      continue;
    }
    if (pathSpec.includes(" -> ")) {
      for (const part of pathSpec.split(" -> ")) {
        changed.add(toPortablePath(part.trim().replace(/^"|"$/g, "")));
      }
    } else {
      changed.add(toPortablePath(pathSpec.trim().replace(/^"|"$/g, "")));
    }
  }
  return Array.from(changed).sort();
}

export function evaluateScope(changedFiles, allowedFiles) {
  const allowed = new Set(allowedFiles);
  const outsideAllowedFiles = changedFiles.filter((file) => !allowed.has(file));
  return {
    ok: outsideAllowedFiles.length === 0,
    changedFiles,
    allowedFiles,
    outsideAllowedFiles,
  };
}

export function runRequiredCommands(repo, commands, options = {}) {
  return commands.map((command) => runCommand(repo, command, options));
}

export function verifyTaskContract(contract, options = {}) {
  const changedFiles = listChangedFiles(contract.repo);
  const scope = evaluateScope(changedFiles, contract.allowedFiles);
  const commands = runRequiredCommands(contract.repo, contract.requiredCommands, options);
  const commandsOk = commands.every((command) => command.status === 0);
  const status = scope.ok && commandsOk ? "verified" : "failed";
  return {
    status,
    contract: {
      sourcePath: contract.sourcePath,
      repo: contract.repo,
      goal: contract.goal,
      allowedFiles: contract.allowedFiles,
      requiredCommands: contract.requiredCommands,
      requirements: contract.requirements,
    },
    scope,
    commands,
  };
}

export function renderTextReport(report) {
  if (!VALID_STATUSES.has(report.status)) {
    throw new Error(`Unsupported runner status: ${report.status}`);
  }
  const lines = [
    "=== Engineer Runner Report ===",
    `Status: ${report.status.toUpperCase()}`,
    `Repo: ${report.contract.repo}`,
    "",
    "Changed files:",
    ...(report.scope.changedFiles.length ? report.scope.changedFiles.map((file) => `  - ${file}`) : ["  - none"]),
    "",
    `Scope gate: ${report.scope.ok ? "PASS" : "FAIL"}`,
  ];
  if (report.scope.outsideAllowedFiles.length) {
    lines.push("Outside allowed files:", ...report.scope.outsideAllowedFiles.map((file) => `  - ${file}`));
  }
  lines.push("", "Verification commands:");
  if (report.commands.length) {
    for (const command of report.commands) {
      lines.push(`  - ${command.command}: ${command.status === 0 ? "PASS" : `FAIL (${command.status})`}`);
    }
  } else {
    lines.push("  - none");
  }
  return `${lines.join("\n")}\n`;
}

export function runCommand(cwd, command, options = {}) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf-8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
  });
  return {
    command,
    status: typeof result.status === "number" ? result.status : 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

function normalizeRequiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Task contract field '${field}' must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeStringList(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`Task contract field '${field}' must be an array.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Task contract field '${field}[${index}]' must be a non-empty string.`);
    }
    return item.trim();
  });
}

function normalizeRepoRelativePath(file, repo, field) {
  if (isAbsolute(file)) {
    const rel = relative(repo, file);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Task contract field '${field}' includes a path outside repo: ${file}`);
    }
    return toPortablePath(rel);
  }
  const resolved = resolve(repo, file);
  const rel = relative(repo, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Task contract field '${field}' includes a path outside repo: ${file}`);
  }
  return toPortablePath(rel);
}

function printUsage() {
  console.log(`Usage:
  node scripts/engineer-runner.mjs prompt <task.json>
  node scripts/engineer-runner.mjs verify <task.json> [--json]

The runner verifies current git changes against allowedFiles and runs requiredCommands.`);
}

function main(argv) {
  const [command, contractPath, ...flags] = argv;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }
  const json = flags.includes("--json");
  const contract = loadTaskContract(contractPath);
  if (command === "prompt") {
    console.log(buildOpenCodePrompt(contract));
    return 0;
  }
  if (command === "verify") {
    const report = verifyTaskContract(contract);
    if (json) {
      console.log(JSON.stringify(report));
    } else {
      process.stdout.write(renderTextReport(report));
    }
    return report.status === "verified" ? 0 : 1;
  }
  throw new Error(`Unknown engineer-runner command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
