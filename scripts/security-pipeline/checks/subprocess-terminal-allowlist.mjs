// subprocess-terminal-allowlist adapter.
//
// Wraps the terminal-allowlist core into the security-pipeline run-check.mjs contract:
//   run({ check, repoRoot }) -> { status, summary, evidence[] }
//
// Verdict mapping: pass->pass, flag->warn, block->fail, throw/no-surface->skipped.

import { check as core } from "./lib/terminal-allowlist.mjs";
import { runCore } from "./lib/adapter-util.mjs";

export async function run({ check, repoRoot }) {
  return runCore({ check, repoRoot, core, label: "terminal-allowlist" });
}
