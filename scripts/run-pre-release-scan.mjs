#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_SCRIPT = path.join(import.meta.dirname, "pre-release-scan.sh");

export function bashCandidates(platform = process.platform) {
  if (platform === "win32") {
    return [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
  }
  return platform === "darwin"
    ? ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"]
    : ["/bin/bash", "/usr/bin/bash"];
}

export function resolveBash({ exists = existsSync, platform = process.platform } = {}) {
  return bashCandidates(platform).find((candidate) => exists(candidate)) ?? null;
}

export function runScan(
  scanArgs = [],
  {
    bash = resolveBash(),
    cwd = REPO_ROOT,
    env = process.env,
    script = SCAN_SCRIPT,
    spawnImpl = spawn,
  } = {},
) {
  if (!bash) {
    return Promise.reject(new Error("A supported fixed Bash installation is required for the pre-release scan."));
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bash, [script, ...scanArgs], {
      cwd,
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

export function isDirectExecution(moduleUrl, argvEntry) {
  return Boolean(argvEntry && pathToFileURL(path.resolve(argvEntry)).href === moduleUrl);
}

export async function main({ argv = process.argv, processRef = process } = {}) {
  try {
    const result = await runScan(argv.slice(2));
    if (result.signal) {
      processRef.kill(processRef.pid, result.signal);
    } else if (result.exitCode !== 0) {
      processRef.exitCode = result.exitCode;
    }
    return result;
  } catch {
    console.error("Pre-release scan could not start: install Git for Windows or Bash in a supported system location.");
    processRef.exitCode = 1;
    return { exitCode: 1, signal: null };
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await main();
}
