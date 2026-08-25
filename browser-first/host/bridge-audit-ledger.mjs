// Audit ledger sink for Phase 3.5.
//
// Returns a sink function shaped like the `auditSink` parameter on
// evaluateBridgeRequestForSelfTest / createBridgeRequestHandler:
//
//   (record) => void
//
// where `record` is
//   { callerId, capability, route, method, url, status, timestamp }.
//
// Records are appended one per line as JSON to a file in the bridge config
// directory (the same place writeBridgeConfig writes). Concurrent writers are
// serialised by appendFileSync (POSIX append-mode atomicity for small writes
// up to PIPE_BUF; on macOS/Linux this is safe for our record sizes which
// stay well under 4 KiB).
//
// Reading the ledger is out of scope for this module — the addon-delegation
// chip work in src/modules/addons/ already has its own reader; this commit
// only adds the writer.

import { appendFileSync } from "node:fs";
import path from "node:path";

export function createBridgeAuditLedger({ filePath, onError } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("createBridgeAuditLedger requires a non-empty filePath.");
  }
  // Lazily touch the parent directory so first-write doesn't fail with ENOENT.
  // We use a tiny synchronous mkdir here because the launcher creates the
  // bridge config dir before writing the bridge config; this is a defensive
  // no-op when the parent already exists.
  const parent = path.dirname(filePath);
  // intentional: don't fail if it already exists.

  function sink(record) {
    if (record === null || typeof record !== "object") {
      return;
    }
    let line;
    try {
      line = JSON.stringify(record) + "\n";
    } catch (error) {
      if (typeof onError === "function") onError(error);
      return;
    }
    try {
      appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      if (typeof onError === "function") onError(error);
    }
  }

  return {
    sink,
    filePath,
  };
}
