#!/usr/bin/env node
// Intent: docs/release/ALPHA_DISTRIBUTION.md#workflow-policy-incident-2026-09-04
import { pathToFileURL } from "node:url";
import { WORKFLOW_ALLOWLIST } from "./check-repo-hygiene.mjs";

const HOUR_MS = 60 * 60 * 1000;
const REQUIRED_BUILD = "Build Chrome extension alpha";

export function findUnreviewedCommits(commits, pullsBySha) {
  return commits.filter((commit) => commit.parents.length < 2
    && !(pullsBySha[commit.sha] ?? []).some((pull) => Boolean(pull.merged_at)));
}

export function findUnknownWorkflows(paths, allowlist = WORKFLOW_ALLOWLIST) {
  const allowed = new Set(allowlist);
  return paths.filter((path) => !allowed.has(path.replace(/^\.github\/workflows\//, "")));
}

// updated_at is GitHub's available approximation of time in the current status;
// the REST run object does not expose the exact status-transition timestamp.
// maxAgeMs bounds the window: a run stuck for longer than that is treated as
// historical noise, not live drift, so a single abandoned run cannot alert forever.
export function findStalledRuns(runs, { now, thresholdMs, maxAgeMs }) {
  return runs.filter((run) => {
    const age = now - Date.parse(run.updated_at ?? run.created_at);
    if (Number.isFinite(maxAgeMs) && !(age <= maxAgeMs)) return false;
    return run.conclusion === "action_required"
      || (["queued", "waiting"].includes(run.status) && age > thresholdMs);
  });
}

export function checkBranchProtection(rules) {
  // The incident spec records a June 2026 ruleset with an EMPTY branch include
  // list, protecting nothing. Inspect /rules/branches/dev (effective rules),
  // never flatten the ruleset inventory into evidence of protection.
  const types = new Set(rules.map((rule) => rule.type));
  const missing = ["pull_request", "non_fast_forward", "deletion", "required_status_checks"]
    .filter((type) => !types.has(type));
  if (!rules.some((rule) => rule.type === "required_status_checks"
    && rule.parameters?.required_status_checks?.some((check) => check.context === REQUIRED_BUILD))) {
    missing.push(REQUIRED_BUILD);
  }
  return missing;
}

export function summarize(findings) {
  const { unreviewedCommits = [], unknownWorkflows = [], stalledRuns = [],
    missingProtection = [], unavailable = [] } = findings;
  const count = unreviewedCommits.length + unknownWorkflows.length + stalledRuns.length + missingProtection.length;
  const ok = count === 0 && unavailable.length === 0;
  // Quote external identifiers and prefix every line, keeping control characters
  // and Actions workflow-command syntax out of executable log positions.
  const quote = (value) => JSON.stringify(String(value));
  const text = [
    `Drift: ${count} finding(s); ${unavailable.length} unavailable check(s). ${ok ? "OK" : "ATTENTION"}`,
    ...unreviewedCommits.map((commit) => `- unreviewed commit: ${quote(commit.sha)}`),
    ...unknownWorkflows.map((path) => `- unknown workflow: ${quote(path)}`),
    ...stalledRuns.map((run) => `- stalled run: ${quote(run.id)} (${quote(run.conclusion ?? run.status)})`),
    ...missingProtection.map((rule) => `- missing protection: ${quote(rule)}`),
    ...unavailable.map(({ check, reason }) => `- unavailable: ${quote(check)}: ${quote(reason)}`),
  ].join("\n");
  return { ok, count, text };
}

// Read-only driver, injectable for offline API fixtures. No I/O occurs on import.
export async function runDrift({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const findings = { unreviewedCommits: [], unknownWorkflows: [], stalledRuns: [], missingProtection: [], unavailable: [] };
  const unavailable = (check, reason) => findings.unavailable.push({ check, reason });
  const finish = () => {
    const summary = summarize(findings);
    return { ...summary, findings, exitCode: summary.ok ? 0 : 1 };
  };
  const repository = env.GITHUB_REPOSITORY || "ResonantOS/2.0.0-alpha";
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    for (const check of ["commits", "workflows", "runs", "protection"]) {
      unavailable(check, !env.GITHUB_TOKEN ? "GITHUB_TOKEN is missing" : "GITHUB_REPOSITORY is invalid");
    }
    return finish();
  }
  const base = `https://api.github.com/repos/${repository}`;

  async function read(path, check) {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        unavailable(check, `HTTP ${response.status}`);
        return null;
      }
      const body = await response.json();
      if (body === null) unavailable(check, "unexpected null API response");
      return body;
    } catch {
      // Never log headers, response bodies, or raw errors that might contain secrets.
      unavailable(check, "request or JSON response failed");
      return null;
    }
  }

  async function list(path, check, valid, { runs = false, paginated = true } = {}) {
    const items = [];
    for (let page = 1; page <= 10; page += 1) {
      const query = paginated ? `${path.includes("?") ? "&" : "?"}per_page=100&page=${page}` : "";
      const body = await read(`${path}${query}`, check);
      if (body === null) return null;
      const batch = runs ? body.workflow_runs : body;
      if (!Array.isArray(batch) || !batch.every((item) => item && valid(item))
        || (runs && (!Number.isInteger(body.total_count) || body.total_count < 0))) {
        unavailable(check, "unexpected API response shape");
        return null;
      }
      items.push(...batch);
      if ((!paginated && items.length >= 1000) || (runs && body.total_count > 1000)) {
        unavailable(check, "API result limit prevents a complete check");
        return null;
      }
      if (!paginated || batch.length < 100) {
        if (runs && body.total_count > items.length) {
          unavailable(check, "incomplete API pagination");
          return null;
        }
        return items;
      }
    }
    unavailable(check, "pagination limit prevents a complete check");
    return null;
  }

  // Seven days overlap scheduled runs and cover the four-day incident delay.
  // This is a recent-commit heuristic, not an audit log of push events.
  const since = encodeURIComponent(new Date(now - 7 * 24 * HOUR_MS).toISOString());
  const commits = await list(`/commits?sha=dev&since=${since}`, "commits",
    (item) => typeof item.sha === "string" && Array.isArray(item.parents));
  if (commits) {
    const checked = [];
    const pullsBySha = Object.create(null);
    for (const commit of commits.filter((item) => item.parents.length < 2)) {
      const pulls = await list(`/commits/${encodeURIComponent(commit.sha)}/pulls`, `commits: PR association ${commit.sha}`,
        (item) => item.merged_at === null || typeof item.merged_at === "string");
      if (pulls !== null) {
        checked.push(commit);
        pullsBySha[commit.sha] = pulls;
      }
    }
    findings.unreviewedCommits = findUnreviewedCommits(checked, pullsBySha);
  }

  const workflows = await list("/contents/.github/workflows?ref=dev", "workflows",
    (item) => typeof item.path === "string", { paginated: false });
  if (workflows) findings.unknownWorkflows = findUnknownWorkflows(workflows.map((item) => item.path));

  // Same seven-day window as the commit check: bounds both the API query and the filter.
  const STALLED_WINDOW_MS = 7 * 24 * HOUR_MS;
  const createdFilter = encodeURIComponent(`>=${new Date(now - STALLED_WINDOW_MS).toISOString().slice(0, 10)}`);
  const stalled = new Map();
  for (const status of ["action_required", "queued", "waiting"]) {
    const runs = await list(`/actions/runs?branch=dev&status=${status}&created=${createdFilter}`, `runs: ${status}`,
      (item) => Number.isInteger(item.id) && typeof item.status === "string"
        && (item.conclusion === "action_required" || Number.isFinite(Date.parse(item.updated_at ?? item.created_at))),
      { runs: true });
    if (runs) for (const run of findStalledRuns(runs, { now, thresholdMs: HOUR_MS, maxAgeMs: STALLED_WINDOW_MS })) stalled.set(run.id, run);
  }
  findings.stalledRuns = [...stalled.values()];

  const rules = await list("/rules/branches/dev", "protection", (item) => typeof item.type === "string"
    && (item.type !== "required_status_checks"
      || (Array.isArray(item.parameters?.required_status_checks)
        && item.parameters.required_status_checks.every((check) => typeof check?.context === "string"))));
  if (rules) findings.missingProtection = checkBranchProtection(rules);
  return finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDrift();
  console.log(result.text);
  process.exitCode = result.exitCode;
}
