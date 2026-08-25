import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeGrantsStore } from "../host/bridge-grants-store.mjs";

test("createBridgeGrantsStore mints tokens and looks them up", () => {
  let counter = 0;
  const store = createBridgeGrantsStore({ mint: () => `tok-${++counter}` });
  const token = store.mintGrant("alpha-caller", "provider-credential-write");
  assert.equal(token, "tok-1");
  assert.equal(store.lookupToken("alpha-caller", "provider-credential-write"), "tok-1");
  assert.equal(store.lookupToken("unknown-caller", "provider-credential-write"), null);
  assert.equal(store.lookupToken("alpha-caller", "unknown-capability"), null);
});

test("createBridgeGrantsStore.mintGrant rotates the existing token on re-mint", () => {
  let counter = 0;
  const store = createBridgeGrantsStore({ mint: () => `tok-${++counter}` });
  store.mintGrant("alpha-caller", "provider-credential-write");
  store.mintGrant("alpha-caller", "provider-credential-write");
  assert.equal(store.lookupToken("alpha-caller", "provider-credential-write"), "tok-2");
});

test("createBridgeGrantsStore.snapshot returns the perCallerGrants shape used by the bridge", () => {
  let counter = 0;
  const store = createBridgeGrantsStore({ mint: () => `tok-${++counter}` });
  store.mintGrant("alpha-caller", "provider-credential-write");
  store.mintGrant("beta-caller", "provider-credential-write");
  store.mintGrant("beta-caller", "agent-control-plan");
  const snap = store.snapshot();
  assert.deepEqual(snap, {
    "alpha-caller": { "provider-credential-write": "tok-1" },
    "beta-caller": { "provider-credential-write": "tok-2", "agent-control-plan": "tok-3" },
  });
});

test("createBridgeGrantsStore.revoke removes a single capability or the whole caller", () => {
  let counter = 0;
  const store = createBridgeGrantsStore({ mint: () => `tok-${++counter}` });
  store.mintGrant("alpha-caller", "provider-credential-write");
  store.mintGrant("alpha-caller", "agent-control-plan");
  store.revoke("alpha-caller", "provider-credential-write");
  assert.equal(store.lookupToken("alpha-caller", "provider-credential-write"), null);
  assert.equal(store.lookupToken("alpha-caller", "agent-control-plan"), "tok-2");
  store.revoke("alpha-caller");
  assert.equal(store.lookupToken("alpha-caller", "agent-control-plan"), null);
});

test("createBridgeGrantsStore.listCallers enumerates granted callerIds", () => {
  const store = createBridgeGrantsStore({ mint: () => "tok" });
  store.mintGrant("alpha-caller", "provider-credential-write");
  store.mintGrant("beta-caller", "provider-credential-write");
  const ids = store.listCallers().sort();
  assert.deepEqual(ids, ["alpha-caller", "beta-caller"]);
});

test("createBridgeGrantsStore rejects empty callerId and capability", () => {
  const store = createBridgeGrantsStore({ mint: () => "tok" });
  assert.throws(() => store.mintGrant("", "provider-credential-write"), /callerId/);
  assert.throws(() => store.mintGrant("alpha-caller", ""), /capability/);
});
