// Shared helpers for subprocess security-pipeline adapters.
//
// Adapters wrap a research "core" (check(record) -> { result, evidence[] }) into
// the run-check.mjs contract: run({check, repoRoot}) -> { status, summary, evidence[] }.
//
// Verdict mapping (uniform across Stream B):
//   pass        -> pass
//   flag        -> warn
//   block       -> fail
//   throw              -> skipped evidence, warn aggregate
//   no surface         -> skipped
//
// Dependency-free. No runtime import from .craft/.

import { existsSync } from "node:fs";
import path from "node:path";

const CORE_TO_STATUS = new Map([
  ["pass", "pass"],
  ["flag", "warn"],
  ["block", "fail"],
]);

export function mapVerdict(coreResult) {
  return CORE_TO_STATUS.get(coreResult) ?? "fail";
}

// Resolve the configured surfaces against repoRoot. Returns the set of surfaces
// that actually exist on disk. An absent surface => the adapter reports skipped.
export function resolveSurfaces(check, repoRoot) {
  const surfaces = Array.isArray(check?.surfaces) ? check.surfaces : [];
  const present = [];
  const missing = [];
  for (const surface of surfaces) {
    const abs = path.resolve(repoRoot, surface);
    if (existsSync(abs)) present.push({ surface, abs });
    else missing.push(surface);
  }
  return { surfaces, present, missing };
}

// Spawn descriptors for a check come from `check.records` (config- or
// test-injected, the deterministic input the cores were designed around). When a
// surface is present but no descriptors are supplied, the adapter has nothing to
// score on this run and reports skipped (surface present, no observations).
export function collectRecords(check) {
  return Array.isArray(check?.records) ? check.records : [];
}

// Run a core over a set of records and fold into the adapter contract.
//   core: (record) => { result: "pass"|"flag"|"block", evidence?, ... }
export function runCore({ check, repoRoot, core, label }) {
  const { surfaces, present, missing } = resolveSurfaces(check, repoRoot);

  if (present.length === 0) {
    return {
      status: "skipped",
      summary:
        surfaces.length === 0
          ? `${label}: no surfaces configured.`
          : `${label}: configured surface(s) absent (${missing.join(", ")}); nothing to scan.`,
      evidence: [],
    };
  }

  const records = collectRecords(check);
  if (records.length === 0) {
    return {
      status: "skipped",
      summary: `${label}: surface present (${present
        .map((p) => p.surface)
        .join(", ")}) but no spawn descriptors supplied; no observations.`,
      evidence: [],
    };
  }

  const evidence = [];
  let worst = "pass"; // pass < warn < fail
  const rank = { pass: 0, warn: 1, fail: 2 };
  let blocked = 0;
  let flagged = 0;
  let unscored = 0;

  for (const record of records) {
    let out;
    try {
      out = core(record);
    } catch (error) {
      // A throwing core => skipped contribution for that record, recorded as evidence.
      unscored += 1;
      evidence.push({
        site: record?.site ?? "<unknown-site>",
        status: "skipped",
        reason: `core threw: ${error.message}`,
      });
      continue;
    }
    const status = mapVerdict(out?.result);
    if (rank[status] > rank[worst]) worst = status;
    if (status === "fail") blocked += 1;
    if (status === "warn") flagged += 1;
    evidence.push({
      site: out?.site ?? record?.site ?? "<unknown-site>",
      status,
      verdict: out?.result,
      findings: Array.isArray(out?.evidence) ? out.evidence : [],
      recommendation: out?.recommendation ?? null,
    });
  }

  if (unscored > 0 && rank[worst] < rank.warn) worst = "warn";

  const unscoredSummary =
    unscored > 0 ? ` and ${unscored} unscored descriptor(s)` : "";
  const summary =
    worst === "fail"
      ? `${label}: ${blocked} blocking finding(s)${unscoredSummary} across ${records.length} descriptor(s).`
      : worst === "warn"
        ? `${label}: ${flagged} warning(s)${unscoredSummary} across ${records.length} descriptor(s).`
        : `${label}: ${records.length} descriptor(s) clean.`;

  return { status: worst, summary, evidence };
}
