import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  fingerprintMaterial,
  isBinaryContentPath,
  listCandidateFiles,
  PRIVATE_KEY_FILENAME_PATTERN,
  scanText,
} from "./lib/private-key-material.mjs";

// Content scanning cap; larger tracked files are reported as `oversized` evidence (visible, non-failing)
// rather than silently skipped. Override per check with `maxContentBytes`.
const DEFAULT_MAX_CONTENT_BYTES = 16 * 1024 * 1024;

export async function run({ check, repoRoot }) {
  const allowlist = Array.isArray(check.allowlist) ? check.allowlist : [];
  const allowlistError = validateAllowlist(allowlist);
  if (allowlistError) {
    return allowlistError;
  }

  const allowlistedByPath = new Map(allowlist.map((entry) => [entry.path, entry.reason]));
  const surfaces = Array.isArray(check.surfaces) && check.surfaces.length > 0
    ? check.surfaces
    : ["."];
  const scopedFiles = listCandidateFiles(repoRoot).filter((filePath) => isInSurfaces(filePath, surfaces));
  const maxContentBytes = Number.isFinite(check.maxContentBytes) && check.maxContentBytes > 0
    ? check.maxContentBytes
    : DEFAULT_MAX_CONTENT_BYTES;
  const evidence = [];

  for (const filePath of scopedFiles) {
    if (PRIVATE_KEY_FILENAME_PATTERN.test(filePath)) {
      evidence.push(applyAllowlist({
        kind: "private-key-filename",
        path: filePath,
        line: 1,
        fingerprint: fingerprintMaterial(filePath),
      }, allowlistedByPath));
    }

    if (isBinaryContentPath(filePath)) {
      continue;
    }

    const absolutePath = path.join(repoRoot, filePath);
    let text;
    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.size > maxContentBytes) {
        evidence.push({
          kind: "oversized",
          path: filePath,
          line: 1,
          status: "oversized",
          reason: `${fileStat.size} bytes exceeds the ${maxContentBytes}-byte content cap; filename rule still applied`,
        });
        continue;
      }
      text = await readFile(absolutePath, "utf8");
    } catch (error) {
      // A tracked path that cannot be read (deleted in the working tree, dangling symlink,
      // directory symlink) must not abort the scan of every other file. Reported, not failed.
      evidence.push({
        kind: "unreadable",
        path: filePath,
        line: 1,
        status: "unreadable",
        reason: error?.code ?? "read-error",
      });
      continue;
    }
    for (const finding of scanText({ path: filePath, text })) {
      evidence.push(applyAllowlist(finding, allowlistedByPath));
    }
  }

  const failedFindings = evidence.filter((finding) => finding.status === "fail");
  const allowlistedFindings = evidence.filter((finding) => finding.status === "allowlisted");
  const unreadable = evidence.filter((finding) => finding.status === "unreadable");
  const oversized = evidence.filter((finding) => finding.status === "oversized");
  if (failedFindings.length > 0) {
    return {
      status: "fail",
      summary: `committed-private-key-material: ${failedFindings.length} finding(s) in ${scopedFiles.length} file(s) scanned`,
      evidence,
    };
  }

  return {
    status: "pass",
    summary: `committed-private-key-material: clean, ${scopedFiles.length} file(s) scanned (${allowlistedFindings.length} allowlisted, ${unreadable.length} unreadable, ${oversized.length} oversized)`,
    evidence,
  };
}

function validateAllowlist(allowlist) {
  for (const [index, entry] of allowlist.entries()) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      return {
        status: "fail",
        summary: `committed-private-key-material: allowlist entry ${index} must include a path and reason`,
        evidence: [],
      };
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      return {
        status: "fail",
        summary: `committed-private-key-material: allowlist entry ${entry.path} must include a non-empty reason`,
        evidence: [],
      };
    }
  }
  return null;
}

function applyAllowlist(finding, allowlistedByPath) {
  const reason = allowlistedByPath.get(finding.path);
  if (reason) {
    return { ...finding, status: "allowlisted", reason };
  }
  return { ...finding, status: "fail" };
}

function isInSurfaces(filePath, surfaces) {
  return surfaces.some((surface) => {
    if (surface === ".") return true;
    const prefix = surface.replace(/\/+$/u, "");
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  });
}
