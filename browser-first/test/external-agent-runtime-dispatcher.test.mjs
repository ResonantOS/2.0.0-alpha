// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#4-wire-format
//
// Integration test for the external-agent-runtime dispatcher.
//
// Drives six scenarios against an in-process Cordis stub HTTP server:
//
//   1. Allow path - caller has all required grants, Cordis returns 200,
//      dispatcher returns upstream body, audit ledger records success.
//   2. Deny path (capability-denied) - caller missing one grant; no
//      upstream call, no audit entry.
//   3. Deny path (unknown-tool) - tool name not in manifest.
//   4. Deny path (addon-not-found) - addon id not on disk.
//   5. Deny path (manifest-misconfigured) - addon has no service.entrypoint.
//   6. Deny path (upstream-unreachable) - addon points at a closed port.
//
// The dispatcher accepts a `repoRoot` override so the test doesn't
// have to mutate any tracked files. The test uses its own
// `examples/addons/` and `addon.deepseek-harness.json` inside a
// tmpdir, with `service.entrypoint` swapped to the stub's URL.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchExternalAgentRuntime,
  findAddonManifest,
  buildChatCompletionsRequest,
  checkToolGrants,
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

function makeGrantStore({ callerId, grantedCapabilities }) {
  const caps = new Map();
  for (const c of grantedCapabilities) caps.set(c, true);
  const buckets = new Map();
  buckets.set(callerId, { capabilities: caps, mintedAt: new Map() });
  return { get: (target) => buckets.get(target) };
}

function makeAuditLedger() {
  const entries = [];
  return { entries, record: (e) => entries.push(e) };
}

/**
 * Sets up a fresh tmpdir containing `examples/addons/addon.deepseek-harness.json`
 * whose `service.entrypoint` points at `entrypoint`. Returns the
 * `tmp` path which the caller passes as `repoRoot` to the dispatcher.
 */
function setupManifestFixture(t, entrypoint) {
  const tmp = mkdtempSync(join(tmpdir(), "ext-agent-rt-"));
  const examplesAddons = join(tmp, "examples", "addons");
  mkdirSync(examplesAddons, { recursive: true });
  writeFileSync(
    join(examplesAddons, "addon.deepseek-harness.json"),
    JSON.stringify(makeManifest(entrypoint), null, 2),
  );
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

test("findAddonManifest: respects repoRoot override", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "fm-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const examplesAddons = join(tmp, "examples", "addons");
  mkdirSync(examplesAddons, { recursive: true });
  writeFileSync(
    join(examplesAddons, "addon.deepseek-harness.json"),
    JSON.stringify(makeManifest("http://127.0.0.1:9999"), null, 2),
  );
  const manifest = await findAddonManifest("addon.deepseek-harness", { repoRoot: tmp });
  assert.ok(manifest);
  assert.equal(manifest.id, "addon.deepseek-harness");
  assert.equal(manifest.service.entrypoint, "http://127.0.0.1:9999");
});

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

test("buildChatCompletionsRequest: shape matches OpenAI-compatible API", () => {
  const req = buildChatCompletionsRequest({
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(req.model, "deepseek-reasoner");
  assert.equal(req.messages.length, 1);
});

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
  // agent-delegation intentionally missing.
  const grants = makeGrantStore({ callerId: "caller.test", grantedCapabilities: ["network", "providers"] });

  const result = await dispatchExternalAgentRuntime({
    addonId: "addon.deepseek-harness",
    toolName: "deepseek_harness.run_task", // requires agent-delegation
    payload: {},
    callerId: "caller.test",
    perCallerGrants: grants,
    auditLedger: ledger,
    repoRoot,
  });

  assert.equal(result.outcome, "deny");
  assert.equal(result.reason, "capability-denied");
  assert.match(result.detail, /agent-delegation/);
  assert.equal(ledger.entries.length, 0, "no audit entry on capability denial before any upstream call");
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
  assert.equal(result.reason, "manifest-misconfigured");
});

test("dispatchExternalAgentRuntime: deny path (upstream-unreachable)", async (t) => {
  // Stub on a port, then close it before dispatch - simulates the
  // dispatcher finding the addon but failing to reach the upstream.
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
