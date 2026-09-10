import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  mintCallerAttributedToken,
  verifyCallerAttributedToken,
} from "../host/bridge-attributed-token.mjs";
import { createBridgeTokenKey } from "../host/bridge-token-key.mjs";

const TOKEN_KEY = createBridgeTokenKey();

test("mintCallerAttributedToken + verifyCallerAttributedToken: round-trip succeeds", () => {
  const token = mintCallerAttributedToken({
    callerId: "hermes",
    capability: "provider-model-invoke",
    tokenKey: TOKEN_KEY,
    expiresInMs: 60_000,
    now: 1_700_000_000_000,
  });
  const ok = verifyCallerAttributedToken({
    token,
    tokenKey: TOKEN_KEY,
    requiredCapability: "provider-model-invoke",
    expectedCallerId: "hermes",
    now: 1_700_000_000_000,
  });
  assert.ok(ok);
  assert.equal(ok.callerId, "hermes");
  assert.equal(ok.capability, "provider-model-invoke");
  assert.match(ok.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("verifyCallerAttributedToken: refuses expired tokens", () => {
  const token = mintCallerAttributedToken({
    callerId: "hermes",
    capability: "provider-model-invoke",
    tokenKey: TOKEN_KEY,
    expiresInMs: 1_000,
    now: 1_700_000_000_000,
  });
  assert.equal(
    verifyCallerAttributedToken({
      token,
      tokenKey: TOKEN_KEY,
      now: 1_700_000_001_500,
    }),
    null,
  );
});

test("verifyCallerAttributedToken: refuses tokens signed by a different key", () => {
  const token = mintCallerAttributedToken({
    callerId: "hermes",
    capability: "provider-model-invoke",
    tokenKey: TOKEN_KEY,
  });
  const rogueKey = createBridgeTokenKey();
  assert.equal(
    verifyCallerAttributedToken({ token, tokenKey: rogueKey }),
    null,
  );
});

test("verifyCallerAttributedToken: refuses tampered signatures", () => {
  const token = mintCallerAttributedToken({
    callerId: "hermes",
    capability: "provider-model-invoke",
    tokenKey: TOKEN_KEY,
  });
  const dot = token.indexOf(".");
  const sig = token.slice(dot + 1);
  const replacement = sig[0] === "A" ? "B" : "A";
  const tampered = `${token.slice(0, dot + 1)}${replacement}${sig.slice(1)}`;
  assert.equal(
    verifyCallerAttributedToken({ token: tampered, tokenKey: TOKEN_KEY }),
    null,
  );
});

test("verifyCallerAttributedToken: refuses when expectedCallerId mismatches token's callerId", () => {
  const token = mintCallerAttributedToken({
    callerId: "hermes",
    capability: "provider-model-invoke",
    tokenKey: TOKEN_KEY,
  });
  assert.equal(
    verifyCallerAttributedToken({
      token,
      tokenKey: TOKEN_KEY,
      expectedCallerId: "opencode",
    }),
    null,
  );
});

test("verifyCallerAttributedToken: refuses when requiredCapability mismatches", () => {
  const token = mintCallerAttributedToken({
    callerId: "hermes",
    capability: "provider-model-invoke",
    tokenKey: TOKEN_KEY,
  });
  assert.equal(
    verifyCallerAttributedToken({
      token,
      tokenKey: TOKEN_KEY,
      requiredCapability: "agent-control-plan",
    }),
    null,
  );
});

test("verifyCallerAttributedToken: refuses malformed input", () => {
  for (const malformed of [null, undefined, "", "no-dot-here", ".", "x.", "x.y", ".."]) {
    assert.equal(
      verifyCallerAttributedToken({ token: malformed, tokenKey: TOKEN_KEY }),
      null,
      `malformed=${JSON.stringify(malformed)} should reject`,
    );
  }
});

test("mintCallerAttributedToken refuses unsafe callerId or capability at mint time", () => {
  // Both are refused at mint time. Mint-side rejection matters because a
  // malformed callerId/capability can't smuggle through the verified path.
  assert.throws(
    () => mintCallerAttributedToken({
      callerId: "../etc/passwd",
      capability: "provider-model-invoke",
      tokenKey: TOKEN_KEY,
    }),
    /callerId/,
    "callerId with slashes must be refused",
  );
  assert.throws(
    () => mintCallerAttributedToken({
      callerId: "hermes",
      capability: "agent control plan",
      tokenKey: TOKEN_KEY,
    }),
    /capability/,
    "capability with spaces must be refused",
  );
});

test("mintCallerAttributedToken: rejects unsafe inputs", () => {
  assert.throws(
    () => mintCallerAttributedToken({ callerId: "", capability: "x", tokenKey: TOKEN_KEY }),
    /callerId/,
  );
  assert.throws(
    () => mintCallerAttributedToken({ callerId: "ok", capability: "", tokenKey: TOKEN_KEY }),
    /capability/,
  );
  assert.throws(
    () => mintCallerAttributedToken({
      callerId: "ok",
      capability: "x",
      tokenKey: Buffer.alloc(8),
    }),
    /tokenKey/,
  );
  assert.throws(
    () => mintCallerAttributedToken({
      callerId: "ok",
      capability: "x",
      tokenKey: TOKEN_KEY,
      expiresInMs: -1,
    }),
    /expiresInMs/,
  );
});
