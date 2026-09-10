#!/usr/bin/env node
// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#9-deepseek-harness-exemplar
//
// Manual smoke test for the DeepSeek Harness addon / plugin.
//
// Loads examples/addons/addon.deepseek-harness.json (the canonical
// manifest for ADR-040 §9's external-agent-runtime exemplar),
// validates it, and drives F1-F10 in-process via runAddOnFailureMode.
//
// F10 is conditional: it asserts the deny path for an undeclared
// experimental route. If the manifest declares
// `allowExperimentalAuth: true`, F10 returns `fixture-mismatch` and
// is considered a "not applicable" outcome (rather than a failure).
// All other F-cases must produce a report whose `actual.code` matches
// the §7 expected deny code.
//
// For the dispatcher-to-Cordis round trip (against the cordis-stub or
// real Cordis), see `scripts/run-dispatcher-smoke.mjs` (separate).
//
// Usage:
//   node scripts/run-deepseek-smoke.mjs
//
// Exit codes:
//   0 - all checks passed
//   1 - manifest validation failed
//   2 - one or more F1-F10 cases failed
//   3 - manifest not found
//   4 - unhandled error

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAddOnManifest } from "../src/sdk/addons/validation.ts";
import {
  runAddOnFailureMode,
  FAILURE_MODE_IDS,
} from "../packages/addon-sdk-testing/src/failure-modes/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repoRoot, "examples", "addons", "addon.deepseek-harness.json");

function logLine(level, msg) {
  const stamp = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] [${level}] ${msg}`);
}

function bail(code, msg) {
  logLine("ERROR", msg);
  process.exit(code);
}

function main() {
  logLine("INFO", `repoRoot: ${repoRoot}`);
  logLine("INFO", `manifest: ${manifestPath}`);

  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    return bail(3, `manifest not found at ${manifestPath}: ${err.message}`);
  }
  const manifest = JSON.parse(raw);

  const result = validateAddOnManifest(manifest);
  const errors = result.issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    logLine("ERROR", "manifest validation failed:");
    for (const err of errors) logLine("ERROR", `  ${err.path}: ${err.code} - ${err.message}`);
    return bail(1, `${errors.length} error(s)`);
  }
  logLine("INFO", `manifest validation: ${result.issues.length === 0 ? "clean (0 issues)" : `${result.issues.length} warning(s), 0 errors`}`);

  const declaresExperimentalAuth =
    manifest.providerRequirements?.allowExperimentalAuth === true;
  if (declaresExperimentalAuth) {
    logLine("INFO", "manifest declares allowExperimentalAuth=true; F10 will be reported as fixture-mismatch (N/A)");
  }

  const callerId = "caller.smoke-test";
  const annotated = { ...manifest, callerId };

  let failed = 0;
  for (const modeId of FAILURE_MODE_IDS) {
    const report = runAddOnFailureMode(modeId, annotated);
    const isF10Na = modeId === "F10" && declaresExperimentalAuth && report.actual.code === "fixture-mismatch";
    const flag = report.pass || isF10Na ? "PASS" : "FAIL";
    const note = isF10Na ? " (N/A: experimental auth declared)" : "";
    logLine("INFO", `  ${modeId}: ${flag} (code=${report.actual.code})${note}`);
    if (!flag.startsWith("PASS")) failed += 1;
  }

  if (failed > 0) {
    logLine("ERROR", `${failed} of ${FAILURE_MODE_IDS.length} cases failed`);
    return bail(2, "F-cases failed");
  }
  logLine("INFO", `${FAILURE_MODE_IDS.length}/${FAILURE_MODE_IDS.length} F-cases passed`);
  logLine("INFO", "deepseek-harness addon SDK boundary contract: CONFORMANT");
  process.exit(0);
}

try {
  main();
} catch (err) {
  logLine("ERROR", `unhandled: ${err.stack ?? err.message ?? String(err)}`);
  process.exit(4);
}
