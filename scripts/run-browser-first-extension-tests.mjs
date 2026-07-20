#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testRoot = path.join(repoRoot, "browser-first", "test");

const files = (await readdir(testRoot))
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => path.join(testRoot, file));

if (!files.length) {
  console.error("No browser-first extension tests were found.");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
