// In-memory per-caller grants store for Phase 3.5.
//
// Backs createBridgeRequestHandler's `perCallerGrants` parameter. Each caller
// is keyed by its callerId (the value the extension sends in
// X-ResonantOS-Bridge-Caller-Id). Each caller has a map of
// capability → capability-token. Tokens are minted with createBridgeToken;
// tokens are opaque to this module — verification happens in
// isAuthorizedCapabilityRequest by comparing the request header against the
// looked-up token.
//
// Lifetime: per-bridge-process. Lost on restart. Persisted-grants durability
// is deferred to a follow-up (the C2 resolution recorded option (a) is the
// in-memory cut).
//
// Thread safety: all mutators run inside a single Node event-loop turn; no
// locks needed.

import { createBridgeToken } from "./bridge-server.mjs";

function makeCallerBucket() {
  return {
    capabilities: new Map(),
    mintedAt: new Map(),
  };
}

export function createBridgeGrantsStore({ mint = createBridgeToken } = {}) {
  if (typeof mint !== "function") {
    throw new Error("createBridgeGrantsStore requires a mint() function.");
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

  // Mint a fresh capability token for `callerId` on `capability`. Idempotent
  // only in the sense that calling twice yields two different tokens; the
  // second call replaces the first (typical for token rotation).
  function mintGrant(callerId, capability) {
    if (typeof callerId !== "string" || callerId.length === 0) {
      throw new Error("mintGrant requires a non-empty callerId.");
    }
    if (typeof capability !== "string" || capability.length === 0) {
      throw new Error("mintGrant requires a non-empty capability name.");
    }
    const token = mint();
    const bucket = getBucket(callerId);
    bucket.capabilities.set(capability, token);
    bucket.mintedAt.set(capability, new Date().toISOString());
    return token;
  }

  // Returns the token for the given (callerId, capability), or null if either
  // is unknown. This is the lookup bridge-server's isAuthorizedCapabilityRequest
  // performs internally once we pass `snapshot()` as perCallerGrants.
  function lookupToken(callerId, capability) {
    const bucket = callers.get(callerId);
    if (!bucket) return null;
    return bucket.capabilities.get(capability) ?? null;
  }

  // Remove a single capability for a caller, or all capabilities if
  // `capability` is omitted.
  function revoke(callerId, capability) {
    const bucket = callers.get(callerId);
    if (!bucket) return false;
    if (capability === undefined) {
      bucket.capabilities.clear();
      bucket.mintedAt.clear();
    } else {
      bucket.capabilities.delete(capability);
      bucket.mintedAt.delete(capability);
    }
    return true;
  }

  // Snapshot suitable for createBridgeRequestHandler's `perCallerGrants`
  // argument: a plain object { callerId: { capability: token } }.
  function snapshot() {
    const out = {};
    for (const [callerId, bucket] of callers.entries()) {
      out[callerId] = Object.fromEntries(bucket.capabilities.entries());
    }
    return out;
  }

  // List the callerIds currently in the store. Useful for tests and for the
  // launcher's status log.
  function listCallers() {
    return [...callers.keys()];
  }

  return {
    mintGrant,
    lookupToken,
    revoke,
    snapshot,
    listCallers,
  };
}
