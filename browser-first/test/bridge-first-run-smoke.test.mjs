// #203 first-run smoke test. A first-time browser-first bridge deployment hits
// several independent bug classes in sequence; each leaves the dashboard iframe
// dead. This exercises the in-repo-testable classes end-to-end so they fail CI
// instead of a deployment. (The network-layer classes — Caddy HTTP/2 ALPN #201,
// WS auth, upstream Hermes auth — require a live host and are covered by the
// setup runbook, not this suite.)
import assert from "node:assert/strict";
import test from "node:test";

import {
  createBridgeToken,
  scopedCapabilityTokenPayload,
  DASHBOARD_PROXY_MIRROR_PATHS,
  evaluateBridgeRequestForSelfTest,
} from "../host/bridge-server.mjs";
import { buildBridgeCapabilityTokens } from "../host/bridge-capability-tokens.mjs";
import {
  RUNTIME_CAPABILITY_ALLOWLIST,
  capabilityForBridgeRoute,
} from "../resonantos-side-panel-extension/src/lib/bridge-client.js";

// Class #4 — capability-token bootstrap. On first load the extension POSTs its
// full RUNTIME_CAPABILITY_ALLOWLIST to /api/capability-tokens; the launcher must
// mint a token for each or the bootstrap 500s ("Unknown bridge capability
// requested") and every capability-scoped route then 403s (#200/#204).
test("bootstrap mints a token for every capability the extension requests (#203, class #4)", () => {
  const mintMap = buildBridgeCapabilityTokens({ mint: createBridgeToken });
  const payload = scopedCapabilityTokenPayload([...RUNTIME_CAPABILITY_ALLOWLIST], mintMap);
  for (const capability of RUNTIME_CAPABILITY_ALLOWLIST) {
    assert.ok(payload[capability], `bootstrap returned no token for "${capability}"`);
  }
  assert.equal(Object.keys(payload).length, RUNTIME_CAPABILITY_ALLOWLIST.length);
});

test("bootstrap rejects a capability the launcher cannot mint (the #200 failure mode)", () => {
  const mintMap = buildBridgeCapabilityTokens({ mint: createBridgeToken });
  assert.throws(
    () => scopedCapabilityTokenPayload(["not-a-real-capability"], mintMap),
    /Unknown bridge capability requested/,
  );
});

test("a minted capability token authorizes its route end-to-end (#203)", async () => {
  const bridgeToken = "smoke-bridge-token";
  const mintMap = buildBridgeCapabilityTokens({ mint: () => "minted-credential-token" });
  const capability = capabilityForBridgeRoute("/providers/credentials", "POST"); // provider-credential-write
  const bootstrap = scopedCapabilityTokenPayload([capability], mintMap);
  const routes = [{
    method: "POST",
    path: "/providers/credentials",
    requiredCapability: capability,
    handler: async () => ({ saved: true }),
  }];

  const authorized = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": bootstrap[capability],
    },
    body: {},
    bridgeToken,
    bridgeCapabilityTokens: mintMap,
    routes,
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.payload.saved, true);
});

// Class #1 — the Hermes SPA redirects unauthenticated first loads to
// /auth/login. If the dashboard proxy does not mirror /auth, the redirect lands
// on the bridge's 404 catch-all and the iframe hangs silently (PR #199).
test("dashboard proxy mirrors /auth so the Hermes login redirect resolves (#203, class #1)", () => {
  assert.ok(
    DASHBOARD_PROXY_MIRROR_PATHS.some((entry) => entry.bridge === "/auth"),
    "dashboard proxy must mirror /auth or the Hermes /auth/login redirect 404s",
  );
});
