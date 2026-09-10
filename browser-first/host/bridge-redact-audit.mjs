// Record-level redactor for the bridge audit ledger (Phase 3.5 hardening, H3).
//
// Wraps the existing redactTraceText helper to apply redaction on every
// string-typed field of an audit record before it is serialized. The
// redactor is intentionally a separate small module — bridge-audit-ledger.mjs
// stays focused on append/rotation, and the redactor can be reused by any
// future ledger-style writer.
//
// Field set walked: callerId, capability, route, method, url, status,
// reason, timestamp, and any ad-hoc fields. Records are flat today;
// shallow walk is enough. Nested objects are serialised intact.

import { redactTraceText } from "../resonantos-side-panel-extension/src/lib/trace-redaction.js";

const REDACT_FIELDS = [
  "callerId",
  "capability",
  "route",
  "method",
  "url",
  "status",
  "reason",
  "timestamp",
];

export function redactAuditRecord(record) {
  if (record === null || typeof record !== "object") return record;
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && REDACT_FIELDS.includes(key)) {
      out[key] = redactTraceText(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
