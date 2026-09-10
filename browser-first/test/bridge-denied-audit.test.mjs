import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBridgeRequestForSelfTest } from "../host/bridge-server.mjs";
import { createBridgeGrantsStore } from "../host/bridge-grants-store.mjs";
import { createBridgeTokenKey } from "../host/bridge-token-key.mjs";

function makeSink() {
  const records = [];
  return { sink: (record) => { records.push(record); }, records };
}

test("audit emits a denied record with reason=bridge-token when bridgeToken is missing", async () => {
  const { sink, records } = makeSink();
  await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/status",
    headers: {},
    bridgeToken: "expected",
    bridgeCapabilityTokens: {},
    routes: [{ method: "GET", path: "/status", handler: async () => ({ ok: true }) }],
    auditSink: sink,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 401);
  assert.equal(records[0].reason, "bridge-token");
  assert.equal(records[0].route, null);
});

test("audit emits a denied record with reason=unknown-route when path does not match", async () => {
  const { sink, records } = makeSink();
  await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/no/such/route",
    headers: { "X-ResonantOS-Bridge-Token": "expected" },
    bridgeToken: "expected",
    bridgeCapabilityTokens: {},
    routes: [{ method: "GET", path: "/status", handler: async () => ({ ok: true }) }],
    auditSink: sink,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 404);
  assert.equal(records[0].reason, "unknown-route");
});

test("audit emits a denied record with reason=bootstrap-missing when capability-bootstrap is required but absent", async () => {
  const { sink, records } = makeSink();
  await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/admin/restart",
    headers: { "X-ResonantOS-Bridge-Token": "expected" },
    bridgeToken: "expected",
    bridgeCapabilityTokens: {},
    capabilityBootstrapToken: "expected-bootstrap",
    routes: [{
      method: "POST",
      path: "/admin/restart",
      requiredCapabilityBootstrap: true,
      handler: async () => ({ restarted: true }),
    }],
    auditSink: sink,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 403);
  assert.equal(records[0].reason, "bootstrap-missing");
  assert.equal(records[0].route, "/admin/restart");
  assert.equal(records[0].callerId, "anonymous");
});

test("audit emits a denied record with reason=capability-denied when the supplied token doesn't grant the capability", async () => {
  const tokenKey = createBridgeTokenKey();
  const grants = createBridgeGrantsStore({ tokenKey });
  const { sink, records } = makeSink();
  await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": "expected",
      "X-ResonantOS-Bridge-Capability-Token": "supplied-token",
      "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
    },
    bridgeToken: "expected",
    bridgeCapabilityTokens: {},
    perCallerGrants: grants.snapshot(),
    tokenKey,
    callerGrantVerifier: grants.verifyCallerGrant.bind(grants),
    routes: [{
      method: "GET",
      path: "/providers/credentials",
      requiredCapability: "provider-credential-write",
      handler: async () => ({ ok: true }),
    }],
    auditSink: sink,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 403);
  assert.equal(records[0].reason, "capability-denied");
  assert.equal(records[0].route, "/providers/credentials");
  assert.equal(records[0].callerId, "anonymous");
});

test("audit emits an authorized record with reason=authorized on success", async () => {
  const tokenKey = createBridgeTokenKey();
  const grants = createBridgeGrantsStore({ tokenKey });
  const token = grants.mintGrant("alpha-caller", "provider-credential-write");
  const { sink, records } = makeSink();
  await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": "expected",
      "X-ResonantOS-Bridge-Capability-Token": token,
      "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
    },
    bridgeToken: "expected",
    bridgeCapabilityTokens: {},
    perCallerGrants: grants.snapshot(),
    tokenKey,
    callerGrantVerifier: grants.verifyCallerGrant.bind(grants),
    routes: [{
      method: "GET",
      path: "/providers/credentials",
      requiredCapability: "provider-credential-write",
      handler: async () => ({ ok: true }),
    }],
    auditSink: sink,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 200);
  assert.equal(records[0].reason, "authorized");
  assert.equal(records[0].callerId, "alpha-caller");
  assert.equal(records[0].capability, "provider-credential-write");
});

test("audit emitted records never include the supplied capability token", async () => {
  const { sink, records } = makeSink();
  await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/status",
    headers: {
      "X-ResonantOS-Bridge-Token": "wrong-token-value",
    },
    bridgeToken: "expected",
    bridgeCapabilityTokens: {},
    routes: [{ method: "GET", path: "/status", handler: async () => ({ ok: true }) }],
    auditSink: sink,
  });
  assert.equal(records.length, 1);
  const serialized = JSON.stringify(records[0]);
  assert.ok(!serialized.includes("wrong-token-value"),
    "audit record must not include the supplied (failed) bridge token");
});
