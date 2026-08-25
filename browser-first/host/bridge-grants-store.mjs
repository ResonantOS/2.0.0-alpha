// In-memory per-caller grants store for Phase 3.5 — hardened (H1).
//
// Backs the verifier of createBridgeRequestHandler's `perCallerGrants`
// parameter path. Each caller is keyed by its callerId (an opaque string
// like "hermes" / "opencode" / "resonant-context" / "resonator"). Each
// caller has a map of capability → minted caller-attributed token string.
//
// Tokens are produced by bridge-attributed-token.mjs's
// mintCallerAttributedToken, which signs a JSON payload with HMAC-SHA256
// using a tokenKey supplied at store creation. The callerId is embedded
// inside the token itself (not in any header), so a forged caller-id header
// cannot change attribution.
//
// Lifetime: per-bridge-process. tokenKey is regenerated on every bridge
// restart, which means tokens minted during a previous run become
// unverifiable on next start. Aligned with the in-memory grants store; see
// RESOLUTIONS_V0.1.md, C2 option (a).
//
// Thread safety: all mutators run inside a single Node event-loop turn; no
// locks needed.

import {
  mintCallerAttributedToken,
  verifyCallerAttributedToken,
} from "./bridge-attributed-token.mjs";

function makeCallerBucket() {
  return {
    capabilities: new Map(),
    mintedAt: new Map(),
    expiresAt: new Map(),
  };
}

export function createBridgeGrantsStore({
  tokenKey,
  expiresInMs = 60 * 60 * 1000,
} = {}) {
  if (!Buffer.isBuffer(tokenKey) || tokenKey.length < 16) {
    throw new Error("createBridgeGrantsStore: tokenKey must be a Buffer of >=16 bytes");
  }
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
    throw new Error("createBridgeGrantsStore: expiresInMs must be positive");
  }
  const callers = new Map();

  function getBucket(callerId) {
    let bucket = callers.get(callerId);
    if (!bucket) {
      bucket = makeCallerBucket();
      callers.set(callerId, bucket);
    }
    return bucket;
  }

  // Mint a fresh caller-attributed capability token. The token binds the
  // callerId inside the signed payload; the caller-supplied header
  // (X-ResonantOS-Bridge-Caller-Id) is ignored on the per-caller path.
  function mintGrant(callerId, capability) {
    const token = mintCallerAttributedToken({
      callerId,
      capability,
      tokenKey,
      expiresInMs,
    });
    const bucket = getBucket(callerId);
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
    bucket.capabilities.set(capability, token);
    bucket.mintedAt.set(capability, new Date().toISOString());
    bucket.expiresAt.set(capability, expiresAt);
    return token;
  }

  // Returns the issued token for the given (callerId, capability), or null
  // if either is unknown. Useful for diagnostic logging — the bridge does
  // not compare this against the request header directly anymore; see
  // verifyCallerGrant.
  function lookupToken(callerId, capability) {
    const bucket = callers.get(callerId);
    if (!bucket) return null;
    return bucket.capabilities.get(capability) ?? null;
  }

  // The bridge's primary verifier: verify a caller-supplied token against
  // The bridge's primary verifier: verify a caller-supplied token against
  // the tokenKey, restricted to (callerId, capability). The store's own
  // state is consulted first — a revoked grant is verified as null even if
  // the supplied token's HMAC still checks out. Returns
  // { callerId, capability, expiresAt } on success, null on any failure
  // (revoked, unknown caller, unknown capability, bad signature, expired,
  // wrong capability, wrong callerId).
  function verifyCallerGrant(callerId, capability, suppliedToken, { now = Date.now() } = {}) {
    if (typeof suppliedToken !== "string" || suppliedToken.length === 0) return null;
    const bucket = callers.get(callerId);
    if (!bucket) return null;
    if (!bucket.capabilities.has(capability)) return null;
    return verifyCallerAttributedToken({
      token: suppliedToken,
      tokenKey,
      requiredCapability: capability,
      expectedCallerId: callerId,
      now,
    });
  }

  // Remove a single capability for a caller, or all capabilities if
  // `capability` is omitted.
  function revoke(callerId, capability) {
    const bucket = callers.get(callerId);
    if (!bucket) return false;
    if (capability === undefined) {
      bucket.capabilities.clear();
      bucket.mintedAt.clear();
      bucket.expiresAt.clear();
    } else {
      bucket.capabilities.delete(capability);
      bucket.mintedAt.delete(capability);
      bucket.expiresAt.delete(capability);
    }
    return true;
  }

  // Snapshot suitable for createBridgeRequestHandler's `perCallerGrants`
  // argument: { callerId: { capability: token } }. With H1's caller-attributed
  // tokens, this snapshot is still useful as a quick lookup; the bridge's
  // verifier now uses the tokenKey-bearing verify path instead.
  function snapshot() {
    const out = {};
    for (const [callerId, bucket] of callers.entries()) {
      out[callerId] = Object.fromEntries(bucket.capabilities.entries());
    }
    return out;
  }

  // List the callerIds currently in the store. Useful for the launcher's
  // boot log and for tests.
  function listCallers() {
    return [...callers.keys()];
  }

  // List the (callerId, capability) pairs. Useful for the boot log; never
  // includes token contents.
  function listGrants() {
    const out = [];
    for (const [callerId, bucket] of callers.entries()) {
      for (const capability of bucket.capabilities.keys()) {
        out.push({ callerId, capability });
      }
    }
    return out;
  }

  return {
    mintGrant,
    lookupToken,
    verifyCallerGrant,
    revoke,
    snapshot,
    listCallers,
    listGrants,
    tokenKey,
    expiresInMs,
  };
}
