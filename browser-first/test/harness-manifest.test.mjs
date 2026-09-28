import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hermes = JSON.parse(await readFile(new URL("../../public/addons/hermes.json", import.meta.url), "utf8"));
const boundHarness = () => ({
  ...structuredClone(hermes),
  requestedCapabilities: [...hermes.requestedCapabilities, { capability: "agent-runtime", granted: false, scope: "system", revocationBehavior: "hard-stop" }],
  agentRuntime: {
    ...hermes.agentRuntime,
    requiredCapabilities: [...hermes.agentRuntime.requiredCapabilities, "agent-runtime"],
    adapterVersion: 1,
    adapterId: "dsh-typert-v1",
    endpoint: "http://127.0.0.1:3080",
    authScheme: "dsh-action-token",
    credentialBinding: "dsh.main",
    supportedOperations: ["createSession", "invoke", "cancel", "history", "status", "selectModel"],
    contextRoleFidelity: "text-only",
    toolCallbacks: false,
  },
});

test("host imports the canonical manifest validator", async () => {
  const canonical = await import("../../packages/addon-sdk/src/validation.ts");
  const host = await import("../host/harness-adapter-contract.mjs");
  assert.equal(host.validateHarnessManifest(hermes).valid, true, "legacy Hermes stays valid");
  assert.equal(host.validateHarnessManifest(boundHarness()).valid, true, "authorized schema control");
  for (const [patch, code] of [
    [{ adapterVersion: 2 }, "agent-runtime-adapter-version"],
    [{ token: "private-canary" }, "agent-runtime-adapter-field"],
    [{ headers: { Authorization: "private-canary" } }, "agent-runtime-adapter-field"],
    [{ credentialBinding: "/tmp/token" }, "agent-runtime-credential-binding"],
    [{ endpoint: "http://localhost:3080/?token=private-canary" }, "agent-runtime-endpoint"],
    [{ supportedOperations: ["createSession", "invoke", "browser_execute"] }, "agent-runtime-operations"],
  ]) {
    const manifest = boundHarness();
    Object.assign(manifest.agentRuntime, patch);
    const result = host.validateHarnessManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(issue => issue.code === code), code);
    assert.deepEqual(result, canonical.validateAddOnManifest(manifest));
    assert.throws(() => host.assertValidHarnessManifest(manifest));
    assert.ok(!JSON.stringify(result).includes("private-canary"));
  }
  assert.equal(host.validateHarnessManifest, canonical.validateAddOnManifest);
});

test("operation validation rejects undeclared and unsupported operations", async () => {
  const { assertHarnessOperation } = await import("../host/harness-adapter-contract.mjs");
  const runtime = boundHarness().agentRuntime;
  assert.equal(assertHarnessOperation(runtime, "invoke"), "invoke");
  for (const operation of ["browser_execute", "modelCatalog", "__proto__", null]) {
    assert.throws(() => assertHarnessOperation(runtime, operation), { code: "unsupported-operation" });
  }
});

const event = () => ({ addonId: "addon.hermes", sessionId: "session-1", turnId: "turn-1", bootEpoch: "boot-1", generation: 1, sequence: 1, type: "delta", data: { text: "Hello" } });

test("event validation requires bounded host provenance and typed payloads", async () => {
  const { validateHarnessEvent } = await import("../host/harness-adapter-contract.mjs");
  assert.equal(validateHarnessEvent(event()), true);
  for (const patch of [
    { generation: -1 }, { generation: 1.5 }, { sequence: 0 }, { bootEpoch: "" },
    { sessionId: "../foreign" }, { turnId: null }, { addonId: "foreign" },
    { type: "browser_execute" }, { data: { token: "private-canary" } },
    { data: { text: "x".repeat(65_537) } }, { extra: "private-canary" },
    { data: { text: "ok", cookie: "private-canary" } },
  ]) assert.equal(validateHarnessEvent({ ...event(), ...patch }), false, JSON.stringify(patch).slice(0, 100));
  for (const [type, data] of [
    ["final", { text: "Done" }], ["status", { status: "running" }],
    ["cancelled", {}], ["error", { code: "runtime-unavailable", message: "Runtime unavailable." }],
  ]) assert.equal(validateHarnessEvent({ ...event(), type, data }), true);
});

test("public errors expose only fixed safe messages", async () => {
  const { publicHarnessError } = await import("../host/harness-adapter-contract.mjs");
  assert.deepEqual(publicHarnessError({ code: "unsupported-operation", message: "private-canary" }), { code: "unsupported-operation", message: "Operation unavailable." });
  assert.deepEqual(publicHarnessError(new Error("private-canary")), { code: "runtime-unavailable", message: "Runtime unavailable." });
});


test("invalid manifest assertions retain their safe public error classification", async () => {
  const { assertValidHarnessManifest, publicHarnessError } = await import("../host/harness-adapter-contract.mjs");
  const manifest = boundHarness();
  assert.equal(assertValidHarnessManifest(manifest), manifest);
  manifest.agentRuntime.adapterVersion = 2;
  assert.throws(() => assertValidHarnessManifest(manifest, { label: "private-canary" }), error => {
    assert.deepEqual(publicHarnessError(error), { code: "invalid-manifest", message: "Invalid harness manifest." });
    assert.equal(error.code, "invalid-manifest");
    assert.equal(error.message, "Invalid harness manifest.");
    return true;
  });
});

test("invalid-event errors are reachable and arbitrary event error messages are rejected", async () => {
  const { publicHarnessError, validateHarnessEvent } = await import("../host/harness-adapter-contract.mjs");
  const safeError = publicHarnessError({ code: "invalid-event", message: "private-canary" });
  assert.deepEqual(safeError, { code: "invalid-event", message: "Invalid runtime event." });
  assert.equal(validateHarnessEvent({ ...event(), type: "error", data: safeError }), true);
  assert.equal(validateHarnessEvent({ ...event(), type: "error", data: { ...safeError, message: "private-canary" } }), false);
});
