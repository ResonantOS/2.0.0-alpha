// #200 drift guard: the browser-first bridge launcher mints one capability token
// per entry in BRIDGE_CAPABILITY_TOKEN_SPECS; the extension requests exactly the
// capabilities in RUNTIME_CAPABILITY_ALLOWLIST. If these ever diverge, first-time
// bootstrap 500s with `Unknown bridge capability requested: <name>` in production.
// This test locks them together so drift fails CI instead of a deployment.
import assert from "node:assert/strict";
import test from "node:test";

import { BRIDGE_CAPABILITIES, buildBridgeCapabilityTokens } from "../host/bridge-capability-tokens.mjs";
import { RUNTIME_CAPABILITY_ALLOWLIST } from "../resonantos-side-panel-extension/src/lib/bridge-client.js";

test("launcher capability set exactly matches the extension allowlist (#200)", () => {
  const missingInLauncher = RUNTIME_CAPABILITY_ALLOWLIST.filter((cap) => !BRIDGE_CAPABILITIES.includes(cap));
  const orphanInLauncher = BRIDGE_CAPABILITIES.filter((cap) => !RUNTIME_CAPABILITY_ALLOWLIST.includes(cap));
  assert.deepEqual(
    missingInLauncher, [],
    `Extension requests capabilities the launcher cannot mint (bootstrap would 500): ${missingInLauncher.join(", ")}`,
  );
  assert.deepEqual(
    orphanInLauncher, [],
    `Launcher mints capabilities the extension never requests (dead entries): ${orphanInLauncher.join(", ")}`,
  );
  assert.deepEqual([...BRIDGE_CAPABILITIES].sort(), [...RUNTIME_CAPABILITY_ALLOWLIST].sort());
});

test("buildBridgeCapabilityTokens mints a token for every capability", () => {
  const map = buildBridgeCapabilityTokens({ mint: () => "tok" });
  assert.equal(Object.keys(map).length, BRIDGE_CAPABILITIES.length);
  for (const cap of BRIDGE_CAPABILITIES) {
    assert.ok(map[cap], `no token minted for ${cap}`);
  }
});

test("buildBridgeCapabilityTokens honors arg > env > mint precedence", () => {
  const args = new Map([["provider-credential-token", "from-arg"]]);
  const env = { RESONANTOS_BROWSER_FIRST_PROVIDER_ROUTING_TOKEN: "from-env" };
  const map = buildBridgeCapabilityTokens({ args, env, mint: () => "minted" });
  assert.equal(map["provider-credential-write"], "from-arg", "CLI arg should win");
  assert.equal(map["provider-routing-write"], "from-env", "env var should win over mint");
  assert.equal(map["archive-read"], "minted", "mint is the fallback");
});

test("buildBridgeCapabilityTokens requires a mint function", () => {
  assert.throws(() => buildBridgeCapabilityTokens({}), /requires a mint/);
});
