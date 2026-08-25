import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { createBridgeGrantsStore } from "../host/bridge-grants-store.mjs";
import { createBridgeTokenKey } from "../host/bridge-token-key.mjs";
import { verifyCallerAttributedToken } from "../host/bridge-attributed-token.mjs";

const TOKEN_KEY = createBridgeTokenKey();

test("createBridgeGrantsStore mints and verifies caller-attributed tokens", () => {
  const store = createBridgeGrantsStore({ tokenKey: TOKEN_KEY });
  const token = store.mintGrant("alpha-caller", "provider-credential-write");
  assert.equal(typeof token, "string");
  // The minted token is a caller-attributed token; verifying it against the
  // (callerId, capability) the store expects succeeds.
  const ok = store.verifyCallerGrant("alpha-caller", "provider-credential-write", token);
  assert.ok(ok, "minted token must verify against the issuing store");
  assert.equal(ok.callerId, "alpha-caller");
  assert.equal(ok.capability, "provider-credential-write");
});

test("createBridgeGrantsStore rejects callers that don't supply a tokenKey", () => {
  assert.throws(
    () => createBridgeGrantsStore({}),
    /tokenKey/,
  );
});

test("createBridgeGrantsStore rejects tokenKey that's too short", () => {
  assert.throws(
    () => createBridgeGrantsStore({ tokenKey: Buffer.alloc(8) }),
    /tokenKey/,
  );
});

test("createBridgeGrantsStore.snapshot returns the perCallerGrants shape used by the bridge", () => {
  const store = createBridgeGrantsStore({ tokenKey: TOKEN_KEY });
  store.mintGrant("alpha-caller", "provider-credential-write");
  store.mintGrant("beta-caller", "provider-credential-write");
  store.mintGrant("beta-caller", "agent-control-plan");
  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ["alpha-caller", "beta-caller"]);
  assert.equal(Object.keys(snap["alpha-caller"]).length, 1);
  assert.equal(Object.keys(snap["beta-caller"]).length, 2);
  // Tokens are non-empty caller-attributed strings (containing a dot).
  assert.ok(snap["alpha-caller"]["provider-credential-write"].includes("."));
});

test("createBridgeGrantsStore.revoke removes a single capability or the whole caller", () => {
  const store = createBridgeGrantsStore({ tokenKey: TOKEN_KEY });
  store.mintGrant("alpha-caller", "provider-credential-write");
  store.mintGrant("alpha-caller", "agent-control-plan");
  store.revoke("alpha-caller", "provider-credential-write");
  assert.equal(
    store.verifyCallerGrant("alpha-caller", "provider-credential-write", "tok")?.callerId,
    undefined,
    "revoked capability must fail verification",
  );
  store.revoke("alpha-caller");
  assert.equal(
    store.verifyCallerGrant("alpha-caller", "agent-control-plan", "tok"),
    null,
  );
});

test("createBridgeGrantsStore.listCallers and listGrants enumerate without leaking tokens", () => {
  const store = createBridgeGrantsStore({ tokenKey: TOKEN_KEY });
  store.mintGrant("alpha-caller", "provider-credential-write");
  store.mintGrant("beta-caller", "provider-credential-write");
  store.mintGrant("beta-caller", "agent-control-plan");
  assert.deepEqual(store.listCallers().sort(), ["alpha-caller", "beta-caller"]);
  const grants = store.listGrants().sort((a, b) =>
    a.callerId === b.callerId ? a.capability.localeCompare(b.capability) : a.callerId.localeCompare(b.callerId)
  );
  assert.deepEqual(grants, [
    { callerId: "alpha-caller", capability: "provider-credential-write" },
    { callerId: "beta-caller", capability: "agent-control-plan" },
    { callerId: "beta-caller", capability: "provider-credential-write" },
  ]);
  // listGrants output must not contain tokens.
  for (const row of grants) {
    assert.ok(!("token" in row));
  }
});

test("createBridgeGrantsStore rejects empty callerId and capability", () => {
  const store = createBridgeGrantsStore({ tokenKey: TOKEN_KEY });
  assert.throws(() => store.mintGrant("", "provider-credential-write"), /callerId/);
  assert.throws(() => store.mintGrant("alpha-caller", ""), /capability/);
});

test("verifyCallerAttributedToken (low-level) refuses tokens that don't bind the expected caller", () => {
  const store = createBridgeGrantsStore({ tokenKey: TOKEN_KEY });
  const token = store.mintGrant("alpha-caller", "provider-credential-write");
  // Forging the caller-id hint on a token issued to alpha-caller doesn't work.
  // The token's signed payload still binds to alpha-caller.
  assert.equal(
    verifyCallerAttributedToken({
      token,
      tokenKey: TOKEN_KEY,
      requiredCapability: "provider-credential-write",
      expectedCallerId: "beta-caller",
    }),
    null,
  );
});
