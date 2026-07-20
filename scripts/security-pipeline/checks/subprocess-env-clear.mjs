// subprocess-env-clear adapter.
//
// Wraps the env-clear-present core into the security-pipeline run-check.mjs contract:
//   run({ check, repoRoot }) -> { status, summary, evidence[] }
//
// Verdict mapping: pass->pass, flag->warn, block->fail, throw/no-surface->skipped.

import { check as core } from "./lib/env-clear.mjs";
import { runCore } from "./lib/adapter-util.mjs";

export async function run({ check, repoRoot }) {
  return runCore({ check, repoRoot, core, label: "env-clear" });
}
