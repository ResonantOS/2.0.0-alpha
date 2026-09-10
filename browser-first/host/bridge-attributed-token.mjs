// Caller-attributed capability tokens (Phase 3.5 hardening, H1).
//
// A caller-attributed token is an ASCII string of the form
//
//   <base64url(payload)>.<base64url(signature)>
//
// where:
//
//   payload   = JSON object { callerId, capability, expiresAt, nonce }
//   signature = HMAC-SHA256(tokenKey, rawPayloadBytes) bytes,
//                base64url-encoded
//
// Verification is constant-time on the signature compare. On success the
// verifier returns { callerId, capability }; on any failure it returns
// null. Failures are silent so the audit log distinguishes "denied" from
// "garbled" using the surrounding request shape, not the token itself.
//
// SECURITY: the token-key must be held only inside the bridge process. See
// bridge-token-key.mjs for the lifetime contract.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { createBridgeToken } from "./bridge-server.mjs";

// Validation patterns. We refuse anything that doesn't conform so an
// attacker cannot smuggle a payload through parse-then-trust bugs.
const CALLER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

function base64urlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function base64urlDecode(value) {
  return Buffer.from(value, "base64url");
}

function signPayload(payloadBytes, tokenKey) {
  return createHmac("sha256", tokenKey).update(payloadBytes).digest();
}

export function mintCallerAttributedToken({
  callerId,
  capability,
  tokenKey,
  expiresInMs = 60 * 60 * 1000,
  now = Date.now(),
  nonce = randomBytes(16).toString("base64url"),
} = {}) {
  if (typeof callerId !== "string" || !CALLER_ID_PATTERN.test(callerId)) {
    throw new Error("mintCallerAttributedToken: invalid callerId");
  }
  if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
    throw new Error("mintCallerAttributedToken: invalid capability");
  }
  if (!Buffer.isBuffer(tokenKey) || tokenKey.length < 16) {
    throw new Error("mintCallerAttributedToken: tokenKey must be a Buffer of >=16 bytes");
  }
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
    throw new Error("mintCallerAttributedToken: expiresInMs must be positive");
  }
  const payload = {
    callerId,
    capability,
    expiresAt: new Date(now + expiresInMs).toISOString(),
    nonce,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.from(payloadJson, "utf8");
  const signature = signPayload(payloadBytes, tokenKey);
  return `${base64urlEncode(payloadBytes)}.${base64urlEncode(signature)}`;
}

export function verifyCallerAttributedToken({
  token,
  tokenKey,
  requiredCapability,
  expectedCallerId,
  now = Date.now(),
} = {}) {
  if (typeof token !== "string" || token.length === 0) return null;
  if (!Buffer.isBuffer(tokenKey) || tokenKey.length < 16) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);
  let payloadBytes;
  let signatureBytes;
  try {
    payloadBytes = base64urlDecode(payloadPart);
    signatureBytes = base64urlDecode(signaturePart);
  } catch {
    return null;
  }
  const expected = signPayload(payloadBytes, tokenKey);
  if (expected.length !== signatureBytes.length) return null;
  if (!timingSafeEqual(expected, signatureBytes)) return null;
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.callerId !== "string" || !CALLER_ID_PATTERN.test(payload.callerId)) return null;
  if (typeof payload.capability !== "string" || !CAPABILITY_PATTERN.test(payload.capability)) return null;
  if (typeof payload.expiresAt !== "string") return null;
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  if (expiresAtMs <= now) return null;
  if (typeof requiredCapability === "string" && payload.capability !== requiredCapability) return null;
  if (typeof expectedCallerId === "string" && payload.callerId !== expectedCallerId) return null;
  return {
    callerId: payload.callerId,
    capability: payload.capability,
    expiresAt: payload.expiresAt,
  };
}

// Internal: exposed for the random-nonce generator when callers want
// deterministic nonce tests.
export function randomTokenNonce() {
  return randomBytes(16).toString("base64url");
}

// Re-export to keep callers from needing a second import path.
export { createBridgeToken };
