// subprocess-pinned-roots adapter.
//
// Wraps the pinned-roots core into the security-pipeline run-check.mjs contract:
//   run({ check, repoRoot }) -> { status, summary, evidence[] }
//
// Verdict mapping: pass->pass, flag->warn, block->fail, throw/no-surface->skipped.

import { check as core } from "./lib/pinned-roots.mjs";
import { runCore } from "./lib/adapter-util.mjs";

export async function run({ check, repoRoot }) {
  return runCore({ check, repoRoot, core, label: "pinned-roots" });
}
