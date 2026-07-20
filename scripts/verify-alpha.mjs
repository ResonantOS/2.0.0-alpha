#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export const ALPHA_COMMANDS = [
  { command: "npm", args: ["run", "repo:hygiene"] },
  { command: "npm", args: ["run", "docs:check"] },
  { command: "npm", args: ["run", "test:docs"] },
  { command: "npm", args: ["run", "build"] },
  { command: "npm", args: ["test", "--", "--run"] },
  { command: "npm", args: ["run", "test:browser-first"] },
  { command: "npm", args: ["run", "test:browser-host"] },
  { command: "npm", args: ["run", "test:living-archive-mcp"] },
  { command: "npm", args: ["run", "test:living-archive-memory-service"] },
  { command: "npm", args: ["run", "test:health"] },
  { command: "npm", args: ["run", "test:engineer-runner"] },
  { command: "npm", args: ["run", "test:security-pipeline"] },
  { command: "npm", args: ["run", "test:module-ownership"] },
  {
    command: "node",
    args: ["scripts/security-pipeline/run-check.mjs", "--certify"],
  },
  { command: "npm", args: ["run", "pre-release:scan"] },
  {
    command: "node",
    args: [
      "scripts/browser-first-release-scope-audit.mjs",
      "--committed",
      "--strict",
    ],
  },
];

function formatCommand({ command, args }) {
  return [command, ...args].join(" ");
}

export function runCommand(
  { command, args },
  {
    cwd = REPO_ROOT,
    env = process.env,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

export function reportEvent(event, write = console.error) {
  if (event.type === "start") {
    write(`[verify-alpha] START ${event.command}`);
    return;
  }

  const detail = event.signal
    ? `(signal ${event.signal})`
    : `(exit ${event.exitCode})`;
  write(`[verify-alpha] RESULT ${event.outcome} ${detail} ${event.command}`);
}

export async function runVerifier({ commands = ALPHA_COMMANDS, runner, report }) {
  for (const command of commands) {
    const label = formatCommand(command);
    report({ type: "start", command: label });
    let result;
    try {
      result = await runner(command);
    } catch {
      const spawnFailure = { exitCode: 1, signal: null };
      report({
        type: "result",
        command: label,
        outcome: "spawn-error",
        exitCode: spawnFailure.exitCode,
      });
      return spawnFailure;
    }
    if (result.signal) {
      report({
        type: "result",
        command: label,
        outcome: "signaled",
        signal: result.signal,
      });
      return result;
    }
    if (result.exitCode !== 0) {
      report({
        type: "result",
        command: label,
        outcome: "failed",
        exitCode: result.exitCode,
      });
      return result;
    }
    report({
      type: "result",
      command: label,
      outcome: "passed",
      exitCode: result.exitCode,
    });
  }

  return { exitCode: 0, signal: null };
}

export async function main({
  commands = ALPHA_COMMANDS,
  processRef = process,
  report = reportEvent,
  runner = runCommand,
} = {}) {
  const result = await runVerifier({ commands, runner, report });
  if (result.signal) {
    processRef.kill(processRef.pid, result.signal);
  } else if (result.exitCode !== 0) {
    processRef.exitCode = result.exitCode;
  }
  return result;
}

export function isDirectExecution(moduleUrl, argvEntry) {
  return Boolean(
    argvEntry && pathToFileURL(path.resolve(argvEntry)).href === moduleUrl,
  );
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await main();
}
