// Intent citation: docs/architecture/ADR-056-provider-fabric-boundary-external-agent-runtimes.md#4-wire-format
//
// Integration test for the external-agent-runtime dispatcher.
//
// Drives the allow path, the deny paths, and the closeout-review
// security properties against an in-process Cordis stub HTTP server.
//
// Closeout-review property coverage (per 2026-09-10 PR_BLOCKERS_SUMMARY.md
// for #330):
//   - findAddonManifest validates `addonId` (no path traversal).
//   - postToCordis / dispatchExternalAgentRuntime enforce a
//     loopback-only entrypoint allowlist.
//   - checkToolGrants honors grant expiry.
//   - buildChatCompletionsRequest strips `options.model` and
//     `options.messages` (the original dispatcher's `...options` spread
//     let a caller override both).
//   - audit-log entries are recursively redacted before they leave the
//     dispatcher (nested authorization header in
//     messages[*].content is rewritten to `[REDACTED]`).
//
// The dispatcher accepts a `repoRoot` override so the test doesn't have
// to mutate any tracked files.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchExternalAgentRuntime,
  findAddonManifest,
  findTool,
  buildChatCompletionsRequest,
  checkToolGrants,
  validateAddonId,
  assertLoopbackEntrypoint,
  redactRequestForLog,
} from "../host/external-agent-runtime-dispatcher.mjs";
import { startCordisStub } from "./_cordis-stub-loader.mjs";

function makeManifest(entrypoint) {
  return {
    id: "addon.deepseek-harness",
    name: "DeepSeek Harness",
    version: "0.1.0",
    author: "test",
    category: "agent",
    sdkVersion: "0.1.0",
    description: "test",
    runtimeType: "agent-addon",
    surfaces: [],
    archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
    requestedCapabilities: [
      { capability: "providers", granted: false, scope: "system", revocationBehavior: "hard-stop" },
      { capability: "network", granted: false, scope: "self", revocationBehavior: "hard-stop" },
      { capability: "agent-delegation", granted: false, scope: "workspace", revocationBehavior: "degrade" },
    ],
    provenance: { tier: "sideloaded-unverified", verificationState: "unverified", signed: false },
    runtimeIsolation: { boundary: "host-mediated-service", supportsDegradedMode: true, requiresReviewedGrant: true },
    grantPresets: [],
    providerRequirements: {
      sharedProfiles: ["openai-compatible-deepseek"],
      supportsPrivateCredentials: true,
      preferredRuntimeKinds: ["remote-user-owned"],
      allowExperimentalAuth: true,
      fallbackPolicyId: "experimental",
    },
    health: { strategy: "http-json-deepseek-harness-status", endpoint: `${entrypoint}/health` },
    service: {
      protocol: "http-json",
      entrypoint,
      healthCommand: "deepseek_harness_status",
      shutdownCommand: "deepseek_harness_stop_service",
    },
    delegation: { acceptsTasks: true, taskTypes: ["research"], artifactReturnTypes: ["summary"], defaultTargetRuntime: "remote-user-owned", requiresHumanApprovalBeforeExecution: true, notes: [] },
    tools: [
      {
        name: "deepseek_harness.status",
        description: "status",
        requiredCapabilities: ["network", "providers"],
        inputSchema: {},
        outputSchema: {},
        audit: { logRequest: true, logResult: true, artifactTypes: ["diagnostic-report"] },
        requiresHumanApproval: false,
      },
      {
        name: "deepseek_harness.run_task",
        description: "run",
        requiredCapabilities: ["network", "providers", "agent-delegation"],
        inputSchema: {},
        outputSchema: {},
        audit: { logRequest: true, logResult: true, artifactTypes: ["summary"] },
        requiresHumanApproval: true,
      },
    ],
    installHooks: { onInstall: "noop", onEnable: "noop" },
    compatibility: { shellVersion: "^0.1.0", platforms: ["macOS", "linux"] },
    agents: [],
  };
}

function makeGrantStore({ callerId, grantedCapabilities, expiresAt = new Map() }) {
  const caps = new Map();
  for (const c of grantedCapabilities) caps.set(c, true);
  const buckets = new Map();
  buckets.set(callerId, { capabilities: caps, expiresAt });
  return { get: (target) => buckets.get(target) };
}

function makeAuditLedger() {
  const entries = [];
  return { entries, record: (e) => entries.push(e) };
}

function setupManifestFixture(t, entrypoint, overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "ext-agent-rt-"));
  const examplesAddons = join(tmp, "examples", "addons");
  mkdirSync(examplesAddons, { recursive: true });
  const manifest = { ...makeManifest(entrypoint), ...overrides };
  writeFileSync(
    join(examplesAddons, "addon.deepseek-harness.json"),
    JSON.stringify(manifest, null, 2),
  );
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

// ---------------------------------------------------------------------------
// validateAddonId
// ---------------------------------------------------------------------------

test("validateAddonId: rejects empty / non-string / too-long ids", () => {
  assert.deepEqual(validateAddonId(""), { ok: false, reason: "addon-id-empty" });
  assert.deepEqual(validateAddonId(undefined), { ok: false, reason: "addon-id-empty" });
  assert.deepEqual(validateAddonId(null), { ok: false, reason: "addon-id-empty" });
  assert.deepEqual(validateAddonId(42), { ok: false, reason: "addon-id-empty" });
  assert.equal(validateAddonId("a".repeat(65)).ok, false);
});

test("validateAddonId: rejects ids containing path traversal, slashes, or null bytes", () => {
  for (const bad of ["../etc/passwd", "addon.deepseek/../etc", "..", "addon/with/slash", "addon\\backslash", "addon\0null", "addon..hidden", ".dotfile", "-leading-dash"]) {
    const result = validateAddonId(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected, got ${JSON.stringify(result)}`);
  }
});

test("validateAddonId: accepts the canonical deepseek harness id and other dot-separated lowercase ids", () => {
  assert.deepEqual(validateAddonId("addon.deepseek-harness"), { ok: true });
  assert.deepEqual(validateAddonId("addon.recursive-mas"), { ok: true });
  assert.deepEqual(validateAddonId("addon.simple"), { ok: true });
});

// ---------------------------------------------------------------------------
// assertLoopbackEntrypoint
// ---------------------------------------------------------------------------

test("assertLoopbackEntrypoint: allows 127.0.0.1, [::1], and localhost", () => {
  for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
    const result = assertLoopbackEntrypoint(`http://${host}:3080`);
    assert.equal(result.ok, true, `expected ${host} to be allowed`);
  }
});

test("assertLoopbackEntrypoint: rejects non-loopback hosts (SSRF guard)", () => {
  for (const bad of ["http://example.com", "http://10.0.0.1", "http://0.0.0.0", "http://192.168.1.1", "http://api.deepseek.com", "http://[::ffff:127.0.0.1]"]) {
    const url = `${bad}:3080`;
    const result = assertLoopbackEntrypoint(url);
    assert.equal(result.ok, false, `expected ${url} to be rejected`);
    assert.equal(result.reason, "entrypoint-not-allowed");
  }
});

test("assertLoopbackEntrypoint: rejects non-http(s) protocols and invalid URLs", () => {
  assert.equal(assertLoopbackEntrypoint("file:///etc/passwd").ok, false);
  assert.equal(assertLoopbackEntrypoint("gopher://127.0.0.1:1234").ok, false);
  assert.equal(assertLoopbackEntrypoint("not a url").ok, false);
  assert.equal(assertLoopbackEntrypoint("").ok, false);
  assert.equal(assertLoopbackEntrypoint(undefined).ok, false);
});

test("assertLoopbackEntrypoint: rejects port 0", () => {
  assert.equal(assertLoopbackEntrypoint("http://127.0.0.1:0").ok, false);
});

// ---------------------------------------------------------------------------
// redactRequestForLog
// ---------------------------------------------------------------------------

test("redactRequestForLog: redacts top-level credentials", () => {
  const out = redactRequestForLog({ model: "deepseek-chat", authorization: "Bearer sk-leaked", apiKey: "abc" });
  assert.equal(out.authorization, "[REDACTED]");
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.model, "deepseek-chat");
});

test("redactRequestForLog: redacts nested credentials inside arrays of objects", () => {
  const out = redactRequestForLog({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "you are a helper" },
      { role: "user", content: { text: "hi", headers: { authorization: "Bearer sk-leaked" } } },
    ],
    extras: [{ api_key: "k", body: "ok" }],
  });
  assert.equal(out.messages[0].content, "you are a helper");
  assert.equal(out.messages[1].content.headers.authorization, "[REDACTED]");
  assert.equal(out.extras[0].api_key, "[REDACTED]");
  assert.equal(out.extras[0].body, "ok");
});

test("redactRequestForLog: recurses into credential-shaped objects (does not collapse wholesale)", () => {
  const out = redactRequestForLog({
    messages: [{
      role: "system",
      content: { text: "x", credentials: { authorization: "Bearer sk-leaked", apiKey: "abc" } },
    }],
  });
  assert.equal(out.messages[0].content.text, "x");
  assert.equal(typeof out.messages[0].content.credentials, "object");
  assert.equal(out.messages[0].content.credentials.authorization, "[REDACTED]");
  assert.equal(out.messages[0].content.credentials.apiKey, "[REDACTED]");
});

test("redactRequestForLog: leaves plain content untouched", () => {
  const out = redactRequestForLog({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(out, { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
});

// ---------------------------------------------------------------------------
// findAddonManifest
// ---------------------------------------------------------------------------

test("findAddonManifest: respects repoRoot override", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "fm-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const examplesAddons = join(tmp, "examples", "addons");
  mkdirSync(examplesAddons, { recursive: true });
  writeFileSync(
    join(examplesAddons, "addon.deepseek-harness.json"),
    JSON.stringify(makeManifest("http://127.0.0.1:9999"), null, 2),
  );
  const result = await findAddonManifest("addon.deepseek-harness", { repoRoot: tmp });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, "addon.deepseek-harness");
  assert.equal(result.manifest.service.entrypoint, "http://127.0.0.1:9999");
});

test("findAddonManifest: returns addon-id-invalid for traversal-shaped ids without touching the filesystem", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "fm-traversal-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const result = await findAddonManifest("../etc/passwd", { repoRoot: tmp });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "addon-id-invalid");
});

test("findAddonManifest: returns addon-not-found for an unknown but well-formed id", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "fm-missing-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const result = await findAddonManifest("addon.does-not-exist", { repoRoot: tmp });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "addon-not-found");
});

// ---------------------------------------------------------------------------
// checkToolGrants
// ---------------------------------------------------------------------------

test("checkToolGrants: deny when caller missing a required capability", () => {
  const tool = { requiredCapabilities: ["network", "providers", "agent-delegation"] };
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network"] });
  const result = checkToolGrants({ tool, perCallerGrants: grants, callerId: "caller.test" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), ["agent-delegation", "providers"]);
});

test("checkToolGrants: allow when all required capabilities granted", () => {
  const tool = { requiredCapabilities: ["network", "providers", "agent-delegation"] };
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers", "agent-delegation"] });
  const result = checkToolGrants({ tool, perCallerGrants: grants, callerId: "caller.test" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("checkToolGrants: deny when a grant is expired", () => {
  const tool = { requiredCapabilities: ["network", "providers"] };
  const expiresAt = new Map([["providers", Date.now() - 1000]]);
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"], expiresAt });
  const result = checkToolGrants({ tool, perCallerGrants: grants, callerId: "caller.test" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["providers"]);
});

test("checkToolGrants: deny when caller id is not in the grant store", () => {
  const tool = { requiredCapabilities: ["network"] };
  const grants = makeGrantStore({ callerId: "someone-else", grantedCapabilities: ["network"] });
  const result = checkToolGrants({ tool, perCallerGrants: grants, callerId: "caller.test" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["network"]);
});

// ---------------------------------------------------------------------------
// buildChatCompletionsRequest
// ---------------------------------------------------------------------------

test("buildChatCompletionsRequest: shape matches OpenAI-compatible API", () => {
  const req = buildChatCompletionsRequest({
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(req.model, "deepseek-reasoner");
  assert.equal(req.messages.length, 1);
});

test("buildChatCompletionsRequest: refuses options.model and options.messages overrides", () => {
  const req = buildChatCompletionsRequest({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hello" }],
    options: { model: "evil-model", messages: [{ role: "user", content: "evil" }], temperature: 0.7, secret: "leaked" },
  });
  assert.equal(req.model, "deepseek-chat");
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].content, "hello");
  assert.equal(req.temperature, 0.7);
  assert.equal("secret" in req, false);
});

// ---------------------------------------------------------------------------
// findTool
// ---------------------------------------------------------------------------

test("findTool: returns null for an unknown tool", () => {
  const manifest = makeManifest("http://127.0.0.1:3080");
  assert.equal(findTool(manifest, "does.not.exist"), null);
});

// ---------------------------------------------------------------------------
// dispatchExternalAgentRuntime — full scenarios
// ---------------------------------------------------------------------------

test("dispatchExternalAgentRuntime: allow path (caller has all grants, Cordis stub returns 200)", async (t) => {
  const stub = await startCordisStub();
  t.after(() => stub.close());
  const repoRoot = setupManifestFixture(t, stub.entrypoint);

  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.status",
    payload: { model: "deepseek-chat", messages: [{ role: "user", content: "hello world" }] },
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "allow", JSON.stringify(result));
  assert.equal(result.response?.choices?.[0]?.message?.role, "assistant");
  assert.match(result.response.choices[0].message.content, /hello world/);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].upstreamOk, true);
  assert.equal(ledger.entries[0].upstreamStatus, 200);
  assert.equal(ledger.entries[0].callerId, "caller.test");
  assert.equal(ledger.entries[0].tool, "deepseek_harness.status");
});

test("dispatchExternalAgentRuntime: deny path (caller missing agent-delegation)", async (t) => {
  const stub = await startCordisStub();
  t.after(() => stub.close());
  const repoRoot = setupManifestFixture(t, stub.entrypoint);

  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.run_task",
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "capability-denied");
  assert.match(result.detail, /agent-delegation/);
  assert.equal(ledger.entries.length, 0);
});

test("dispatchExternalAgentRuntime: deny path (unknown-tool)", async (t) => {
  const stub = await startCordisStub();
  t.after(() => stub.close());
  const repoRoot = setupManifestFixture(t, stub.entrypoint);

  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers", "agent-delegation"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.unknown_tool",
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "unknown-tool");
});

test("dispatchExternalAgentRuntime: deny path (addon-not-found)", async () => {
  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network"] });
  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.does-not-exist",
    toolName: "any.tool",
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot: "/tmp/never-existed",
  });
  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "addon-not-found");
});

test("dispatchExternalAgentRuntime: deny path (manifest-misconfigured: no entrypoint)", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "misconfig-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const examplesAddons = join(repoRoot, "examples", "addons");
  mkdirSync(examplesAddons, { recursive: true });
  const manifest = makeManifest("");
  delete manifest.service.entrypoint;
  writeFileSync(join(examplesAddons, "addon.deepseek-harness.json"), JSON.stringify(manifest, null, 2));

  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.status",
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "entrypoint-invalid");
});

test("dispatchExternalAgentRuntime: deny path (entrypoint-not-allowed: external host)", async (t) => {
  const stub = await startCordisStub();
  t.after(() => stub.close());
  const repoRoot = setupManifestFixture(t, "http://api.deepseek.com:443");

  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.status",
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "entrypoint-not-allowed");
  assert.equal(ledger.entries.length, 0);
});

test("dispatchExternalAgentRuntime: deny path (addon-id-invalid: traversal-shaped id)", async (t) => {
  const stub = await startCordisStub();
  t.after(() => stub.close());
  const repoRoot = setupManifestFixture(t, stub.entrypoint);

  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "../etc/passwd",
    toolName: "deepseek_harness.status",
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "addon-id-invalid");
});

test("dispatchExternalAgentRuntime: deny path (upstream-unreachable)", async (t) => {
  const stub = await startCordisStub();
  const deadPort = stub.port;
  await stub.close();

  const repoRoot = setupManifestFixture(t, `http://127.0.0.1:${deadPort}`);
  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.status",
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "upstream-unreachable");
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].upstreamOk, false);
  assert.equal(ledger.entries[0].upstreamStatus, 0);
});

test("dispatchExternalAgentRuntime: allow-path audit entry has the request body recursively redacted", async (t) => {
  const stub = await startCordisStub();
  t.after(() => stub.close());
  const repoRoot = setupManifestFixture(t, stub.entrypoint);

  const ledger = makeAuditLedger();
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.status",
    payload: {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: { text: "you are a helper", credentials: { authorization: "Bearer sk-leaked", apiKey: "abc" } } },
        { role: "user", content: "hi" },
      ],
    },
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(ledger.entries.length, 1);
  const recorded = ledger.entries[0].request;
  assert.equal(recorded.messages[0].content.text, "you are a helper");
  assert.equal(recorded.messages[0].content.credentials.authorization, "[REDACTED]");
  assert.equal(recorded.messages[0].content.credentials.apiKey, "[REDACTED]");
  assert.equal(recorded.messages[1].content, "hi");
  const serialized = JSON.stringify(recorded);
  assert.equal(serialized.includes("sk-leaked"), false, "leaked token must not appear in the audit entry");
});
