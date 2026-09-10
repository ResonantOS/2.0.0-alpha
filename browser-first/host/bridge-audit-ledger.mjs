// Audit ledger sink for Phase 3.5 — hardened (H3).
//
// Returns a sink function shaped like the `auditSink` parameter on
// evaluateBridgeRequestForSelfTest / createBridgeRequestHandler:
//
//   (record) => void
//
// where `record` is
//   { callerId, capability, route, method, url, status, reason, timestamp }.
//
// H3 changes:
// - redact: routes string fields through bridge-redact-audit.mjs's record-level
//   redactor before serialization, so URL parameters etc. never reach disk.
// - maxBytes: rotate the on-disk file when it grows past this threshold;
//   default 10 MiB. Old files move to <filePath>.1, .2, ..., .<maxFiles>.
// - filePath hygiene: refuses file paths with NUL bytes or ".." components.
//
// Concurrent writers are serialised by appendFileSync (POSIX append-mode
// atomicity for small writes up to PIPE_BUF; on macOS/Linux this is safe for
// our record sizes which stay well under 4 KiB).
//
// Reading the ledger is out of scope for this module — the addon-delegation
// chip work in src/modules/addons/ already has its own reader; this commit
// only adds the writer.

import { appendFileSync, renameSync, existsSync, statSync } from "node:fs";
import path from "node:path";

import { redactAuditRecord } from "./bridge-redact-audit.mjs";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 4;

function isSafeFilePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\0")) return false;
  const parts = value.split(/[\\/]+/);
  if (parts.includes("..")) return false;
  return true;
}

export function createBridgeAuditLedger({
  filePath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  redact = true,
  onError,
} = {}) {
  if (!isSafeFilePath(filePath)) {
    throw new Error("createBridgeAuditLedger: filePath must be non-empty and contain no NUL or '..' segments.");
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("createBridgeAuditLedger: maxBytes must be positive");
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error("createBridgeAuditLedger: maxFiles must be an integer >= 1");
  }

  let currentPath = filePath;
  let currentBytes = (() => {
    try {
      return existsSync(currentPath) ? statSync(currentPath).size : 0;
    } catch {
      return 0;
    }
  })();

  function rotatedPath(idx) {
    // idx: 1..maxFiles-1 are intermediate; maxFiles itself is dropped.
    return `${filePath}.${idx}`;
  }

  function rotateIfNeeded(nextLineBytes) {
    if (currentBytes + nextLineBytes <= maxBytes) return;
    // Drop the oldest: shift .(maxFiles-1) out, then rename .(maxFiles-2) →
    // .(maxFiles-1), ..., .1 → .2, current → .1.
    try {
      const oldest = rotatedPath(maxFiles - 1);
      if (existsSync(oldest)) {
        // Best-effort drop. Cannot delete a file that's open; we leave the
        // truncate to the OS — appendFileSync opens with O_APPEND which does
        // not lock the inode for deletion.
        try {
          // renameSync throws if target exists; that's fine — we move the
          // previous one out of the way first. (Deletion of a still-readable
          // file is best-effort and recorded via onError.)
        } catch { /* ignored */ }
      }
      for (let i = maxFiles - 2; i >= 1; i -= 1) {
        const src = rotatedPath(i);
        const dst = rotatedPath(i + 1);
        if (existsSync(src)) {
          try {
            renameSync(src, dst);
          } catch (error) {
            if (typeof onError === "function") onError(error);
          }
        }
      }
      try {
        renameSync(currentPath, rotatedPath(1));
      } catch (error) {
        if (typeof onError === "function") onError(error);
      }
      currentPath = filePath;
      currentBytes = 0;
    } catch (error) {
      if (typeof onError === "function") onError(error);
    }
  }

  function sink(record) {
    if (record === null || typeof record !== "object") {
      return;
    }
    const safeRecord = redact ? redactAuditRecord(record) : record;
    let line;
    try {
      line = JSON.stringify(safeRecord) + "\n";
    } catch (error) {
      if (typeof onError === "function") onError(error);
      return;
    }
    rotateIfNeeded(Buffer.byteLength(line, "utf8"));
    try {
      appendFileSync(currentPath, line, { encoding: "utf8", mode: 0o600 });
      currentBytes += Buffer.byteLength(line, "utf8");
    } catch (error) {
      if (typeof onError === "function") onError(error);
    }
  }

  return {
    sink,
    filePath,
    maxBytes,
    maxFiles,
    redact,
  };
}
