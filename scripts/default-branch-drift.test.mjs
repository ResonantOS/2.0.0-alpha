import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  findUnreviewedCommits, findUnknownWorkflows, findStalledRuns,
  checkBranchProtection, summarize, runDrift,
} from "./default-branch-drift.mjs";
import { WORKFLOW_ALLOWLIST } from "./check-repo-hygiene.mjs";

const now = Date.parse("2026-09-08T12:00:00Z");
const thresholdMs = 60 * 60 * 1000;
const commit = (sha, parents = [{ sha: "parent" }]) => ({ sha, parents });
const completeRules = [
  { type: "pull_request" }, { type: "non_fast_forward" }, { type: "deletion" },
  { type: "required_status_checks", parameters: {
    required_status_checks: [{ context: "Build Chrome extension alpha" }],
  } },
];
const emptyFindings = () => ({
  unreviewedCommits: [], unknownWorkflows: [], stalledRuns: [], missingProtection: [], unavailable: [],
});
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
function fixtureFetch(overrides = {}, calls = []) {
  return async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    const route = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    if (overrides[route]) return overrides[route](url, options);
    if (route === "/commits") return response([commit("reviewed")]);
    if (route === "/commits/reviewed/pulls") return response([{ merged_at: "2026-09-08T00:00:00Z" }]);
    if (route === "/contents/.github/workflows") return response(
      WORKFLOW_ALLOWLIST.map((name) => ({ path: `.github/workflows/${name}`, type: "file" })),
    );
    if (route === "/actions/runs") return response({ total_count: 0, workflow_runs: [] });
    if (route === "/rules/branches/dev") return response(completeRules);
    throw new Error(`Unexpected fixture route ${route}`);
  };
}
const driverOptions = (fetchImpl) => ({
  env: { GITHUB_TOKEN: "fixture-token", GITHUB_REPOSITORY: "example/project" }, now, fetchImpl,
});

test("direct pushes are detected while merged PR commits are ignored", () => {
  const commits = [commit("direct"), commit("reviewed"), commit("open-pr")];
  assert.deepEqual(findUnreviewedCommits(commits, {
    direct: [], reviewed: [{ merged_at: "2026-09-07T00:00:00Z" }],
    "open-pr": [{ state: "closed", merged_at: null }],
  }), [commits[0], commits[2]]);
});

test("merge commits are ignored without requiring a PR association", () => {
  assert.deepEqual(findUnreviewedCommits([commit("merge", [{ sha: "a" }, { sha: "b" }])], {}), []);
});

test("both incident commits and the added attacker workflow are flagged", () => {
  // Git objects verify ancestry/paths; empty PR associations are inline fixtures.
  const first = "fa42023d1a9d3169f5ea9b37a3827ff816bcd5ec";
  const second = "cc53f498c49de670e7e5d3d9e9f415c7d8d03b83";
  const commits = [commit(second, [{ sha: first }]), commit(first)];
  assert.deepEqual(findUnreviewedCommits(commits, { [first]: [], [second]: [] }), commits);
  assert.deepEqual(findUnknownWorkflows([
    ".github/workflows/alpha-build.yml", ".github/workflows/github_actions_security.yml",
  ], WORKFLOW_ALLOWLIST), [".github/workflows/github_actions_security.yml"]);
});

test("workflow paths use the shared allowlist and flag unknown filenames", () => {
  const allowed = WORKFLOW_ALLOWLIST.map((name) => `.github/workflows/${name}`);
  assert.deepEqual(findUnknownWorkflows([...allowed, ".github/workflows/unknown.yaml"], WORKFLOW_ALLOWLIST),
    [".github/workflows/unknown.yaml"]);
  assert.deepEqual(findUnknownWorkflows(allowed), []);
});

test("action_required runs are flagged regardless of their age when no window is given", () => {
  const blocked = { id: 1, status: "completed", conclusion: "action_required" };
  assert.deepEqual(findStalledRuns([blocked, { id: 2, status: "completed", conclusion: "success" }],
    { now, thresholdMs }), [blocked]);
});

test("a window drops action_required and queued runs older than maxAgeMs (no indefinite alerts)", () => {
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const runs = [
    { id: 1, status: "completed", conclusion: "action_required", updated_at: iso(2 * 60 * 60 * 1000) },      // 2h: flagged
    { id: 2, status: "completed", conclusion: "action_required", updated_at: iso(30 * 24 * 60 * 60 * 1000) }, // 30d: dropped
    { id: 3, status: "queued", updated_at: iso(3 * 60 * 60 * 1000) },                                          // 3h: flagged
    { id: 4, status: "queued", updated_at: iso(8 * 24 * 60 * 60 * 1000) },                                     // 8d: dropped
    { id: 5, status: "completed", conclusion: "action_required", created_at: iso(6 * 24 * 60 * 60 * 1000) }, // 6d via created_at: flagged
  ];
  assert.deepEqual(findStalledRuns(runs, { now, thresholdMs, maxAgeMs }).map((r) => r.id), [1, 3, 5]);
});

test("queued and waiting runs must exceed the injected age threshold", () => {
  const runs = [
    { id: 1, status: "queued", updated_at: "2026-09-08T10:59:59Z" },
    { id: 2, status: "waiting", updated_at: "2026-09-08T10:00:00Z" },
    { id: 3, status: "queued", updated_at: "2026-09-08T11:00:00Z" },
    { id: 4, status: "waiting", updated_at: "2026-09-08T11:59:00Z" },
    { id: 5, status: "in_progress", updated_at: "2026-09-07T00:00:00Z" },
    { id: 6, status: "queued", created_at: "2026-09-07T00:00:00Z" },
  ];
  assert.deepEqual(findStalledRuns(runs, { now, thresholdMs }), [runs[0], runs[1], runs[5]]);
});

test("protection reports a missing PR rule and accepts complete effective rules", () => {
  assert.deepEqual(checkBranchProtection(completeRules.slice(1)), ["pull_request"]);
  assert.deepEqual(checkBranchProtection(completeRules), []);
});

test("protection requires all rule types and the exact alpha build context", () => {
  assert.deepEqual(checkBranchProtection([]), [
    "pull_request", "non_fast_forward", "deletion", "required_status_checks", "Build Chrome extension alpha",
  ]);
  assert.deepEqual(checkBranchProtection(completeRules.map((rule) => rule.type === "required_status_checks"
    ? { type: rule.type, parameters: { required_status_checks: [{ context: "other" }] } } : rule)),
  ["Build Chrome extension alpha"]);
});

test("an empty-include ruleset inventory is not effective protection", () => {
  const inventory = [{ enforcement: "active", conditions: { ref_name: { include: [], exclude: [] } }, rules: completeRules }];
  assert.deepEqual(checkBranchProtection(inventory), [
    "pull_request", "non_fast_forward", "deletion", "required_status_checks", "Build Chrome extension alpha",
  ]);
});

test("summary returns false and the correct finding count with useful identifiers", () => {
  const result = summarize({ ...emptyFindings(), unreviewedCommits: [commit("direct")],
    unknownWorkflows: [".github/workflows/unknown.yml"], stalledRuns: [{ id: 42 }], missingProtection: ["pull_request"] });
  assert.ok(result, "summary must return a report");
  assert.equal(result.ok, false);
  assert.equal(result.count, 4);
  for (const expected of ["4 finding", "direct", "unknown.yml", "42", "pull_request"]) assert.ok(result.text.includes(expected));
  assert.equal(summarize(emptyFindings()).ok, true);
});

test("summary explicitly names unavailable checks and never reports all-clear", () => {
  const result = summarize({ ...emptyFindings(), unavailable: [{ check: "workflows", reason: "HTTP 403" }] });
  assert.ok(result, "summary must return a report");
  assert.equal(result.ok, false);
  assert.match(result.text, /unavailable.*workflows.*HTTP 403/i);
});

test("driver performs authenticated read-only dev checks and returns a clean report", async () => {
  const calls = [];
  const result = await runDrift(driverOptions(fixtureFetch({}, calls)));
  assert.ok(result, "driver must return findings and summary");
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, emptyFindings());
  assert.ok(calls.some(({ url }) => url.pathname.endsWith("/rules/branches/dev")));
  assert.ok(calls.some(({ url }) => url.searchParams.get("sha") === "dev" && url.searchParams.has("since")));
  assert.ok(calls.some(({ url }) => url.searchParams.get("ref") === "dev"));
  assert.deepEqual(calls.filter(({ url }) => url.pathname.endsWith("/actions/runs"))
    .map(({ url }) => url.searchParams.get("status")).sort(), ["action_required", "queued", "waiting"]);
  for (const { url, options } of calls) {
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(url.pathname.startsWith("/repos/example/project/"));
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname.endsWith("/actions/runs")) assert.equal(url.searchParams.get("branch"), "dev");
  }
});

for (const status of [403, 404, 500]) {
  test(`driver records HTTP ${status} at every API check and continues other checks`, async () => {
    for (const route of ["/commits", "/commits/reviewed/pulls", "/contents/.github/workflows", "/actions/runs", "/rules/branches/dev"]) {
      const calls = [];
      const result = await runDrift(driverOptions(fixtureFetch({ [route]: () => response({}, status) }, calls)));
      assert.ok(result, "driver must return an unavailable report");
      assert.equal(result.ok, false, route);
      assert.equal(result.exitCode, 1);
      assert.match(result.text, new RegExp(`unavailable.*HTTP ${status}`, "i"));
      assert.ok(result.findings.unavailable.length > 0);
      assert.deepEqual(result.findings.unreviewedCommits, [], "unknown PR associations are not confirmed direct pushes");
      assert.ok(calls.some(({ url }) => url.pathname.endsWith("/rules/branches/dev")), "continue independent checks");
    }
  });
}

test("driver contains transport and malformed API failures without leaking error text", async () => {
  for (const failure of [() => { throw new Error("private diagnostic"); }, () => response({ unexpected: true }),
    () => ({ ok: true, status: 200, json: async () => { throw new Error("private diagnostic"); } })]) {
    const result = await runDrift(driverOptions(fixtureFetch({ "/commits": failure })));
    assert.ok(result, "driver must return an unavailable report");
    assert.equal(result.ok, false);
    assert.match(result.text, /unavailable.*commits/i);
    assert.doesNotMatch(result.text, /private diagnostic/);
  }
});

test("driver follows pagination so later direct pushes and PR associations are checked", async () => {
  const result = await runDrift(driverOptions(fixtureFetch({
    "/commits": (url) => response(url.searchParams.get("page") === "1"
      ? Array.from({ length: 100 }, (_, i) => commit(`merge-${i}`, [{ sha: "a" }, { sha: "b" }]))
      : [commit("direct"), commit("reviewed")]),
    "/commits/direct/pulls": () => response([]),
    "/commits/reviewed/pulls": (url) => response(url.searchParams.get("page") === "1"
      ? Array.from({ length: 100 }, () => ({ merged_at: null })) : [{ merged_at: "2026-09-08T00:00:00Z" }]),
  })));
  assert.ok(result, "driver must return paginated findings");
  assert.deepEqual(result.findings.unreviewedCommits.map(({ sha }) => sha), ["direct"]);
  assert.equal(result.exitCode, 1);
});

test("driver reports API result caps and partial pagination as unavailable", async () => {
  for (const overrides of [
    { "/actions/runs": () => response({ total_count: 1001, workflow_runs: [] }) },
    { "/commits": (url) => url.searchParams.get("page") === "1"
      ? response(Array.from({ length: 100 }, () => commit("merge", [{ sha: "a" }, { sha: "b" }]))) : response({}, 403) },
    { "/contents/.github/workflows": () => response(Array.from({ length: 1000 }, () => ({ path: ".github/workflows/alpha-build.yml", type: "file" }))) },
  ]) {
    const result = await runDrift(driverOptions(fixtureFetch(overrides)));
    assert.ok(result, "driver must return an unavailable report");
    assert.equal(result.ok, false);
    assert.ok(result.findings.unavailable.length > 0);
  }
});

test("driver defaults the repository and makes missing credentials an explicit failure", async () => {
  const calls = [];
  const result = await runDrift({ env: { GITHUB_TOKEN: "fixture-token" }, now, fetchImpl: fixtureFetch({}, calls) });
  assert.ok(result, "driver must return a report");
  assert.equal(result.ok, true);
  assert.ok(calls.every(({ url }) => url.pathname.startsWith("/repos/ResonantOS/2.0.0-alpha/")));
  const missing = await runDrift({ env: {}, fetchImpl: () => assert.fail("must not request without a token") });
  assert.equal(missing.exitCode, 1);
  for (const check of ["commits", "workflows", "runs", "protection"]) assert.ok(missing.text.includes(check));
});

test("scheduled drift workflow has the specified triggers, permissions, pins, and token", () => {
  const path = new URL("../.github/workflows/security-drift.yml", import.meta.url);
  assert.ok(existsSync(path), "security-drift.yml must exist");
  const text = readFileSync(path, "utf8");
  assert.match(text, /cron: ['"]0 \*\/6 \* \* \*['"]/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /  drift:/);
  assert.match(text, /contents: read/);
  assert.match(text, /actions: read/);
  assert.match(text, /run: node scripts\/default-branch-drift\.mjs/);
  assert.deepEqual([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]), ["GITHUB_TOKEN"]);
  const uses = [...text.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  assert.equal(uses.length, 2);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);
  assert.doesNotMatch(text, /continue-on-error|\bpush:|\bpull_request:/);
});

test("successful HTTP responses containing null cannot silently skip a check", async () => {
  for (const route of ["/commits", "/commits/reviewed/pulls", "/contents/.github/workflows", "/actions/runs", "/rules/branches/dev"]) {
    const result = await runDrift(driverOptions(fixtureFetch({ [route]: () => response(null) })));
    assert.equal(result.ok, false, `${route} must be unavailable for a null response`);
    assert.ok(result.findings.unavailable.length > 0);
  }
});

test("malformed status-check parameters are unavailable rather than crashing", async () => {
  await assert.doesNotReject(async () => {
    const result = await runDrift(driverOptions(fixtureFetch({ "/rules/branches/dev": () => response([
      ...completeRules.slice(0, 3), { type: "required_status_checks", parameters: { required_status_checks: {} } },
    ]) })));
    assert.equal(result.ok, false);
    assert.ok(result.findings.unavailable.some(({ check }) => check === "protection"));
  });
});

test("incomplete PR pagination does not mislabel an unverified commit as a direct push", async () => {
  const result = await runDrift(driverOptions(fixtureFetch({
    "/commits/reviewed/pulls": () => response(Array.from({ length: 100 }, () => ({ merged_at: null }))),
  })));
  assert.deepEqual(result.findings.unreviewedCommits, []);
  assert.equal(result.ok, false);
  assert.match(result.text, /unavailable.*PR association/);
});
