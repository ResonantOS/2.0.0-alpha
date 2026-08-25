// Per-bridge-process HMAC key for caller-attributed capability tokens.
//
// Phase 3.5 hardening (H1): the caller-attributed token format used by
// bridge-grants-store.mjs requires a symmetric key for signing and verifying.
// The key lives only in memory for the bridge process; it is regenerated on
// every bridge restart, which means tokens minted during a previous run are
// rejected (good — revocation on restart is the desired posture when grant
// storage is also in-memory; see RESOLUTIONS_V0.1.md, C2 option (a)).
//
// The key never lands on disk and is never logged. createBridgeTokenKey
// returns it as a plain Buffer (32 raw bytes, the recommended HMAC-SHA256
// key length per RFC 2104).
//
// SECURITY: do not export the key from the bridge process. Any code that has
// the key can mint valid caller-attributed tokens for any callerId in any
// capability. The key is held only inside `createBridgeTokenKey`'s closure.

import { createBridgeToken } from "./bridge-server.mjs";

export function createBridgeTokenKey() {
  return Buffer.from(createBridgeToken(), "base64url");
}
