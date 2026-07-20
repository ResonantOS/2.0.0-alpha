// Intent citation: docs/architecture/ADR-017-resonant-browser-addon.md
// PR-R08 / finding P1-d — dependency-free path containment primitive.
//
// pathContains(root, target) -> { result: "pass" | "block", evidence }
//
// Decides whether `target` resolves INSIDE the allowed `root` after path
// normalization and read-only symlink resolution. Ported from the security
// research primitive (p1-invoke/checks/containment/path-contains.mjs); mirrors
// the rigor of browser-first/host/addon-delegation-service.mjs resolveDelegationPath
// (startsWith(root + sep)) and additionally resolves symlinks read-only so a
// `..` chain / absolute reroot / symlink-out escape cannot read or write outside
// the sandbox.
//
// Read-only guarantee: lstatSync / realpathSync READ semantics only. We never
// create, follow-into-and-mutate, or write anything. Non-existent leaves are
// permitted: we realpath the longest existing ancestor and re-append the
// normalized, unresolved tail so a not-yet-created target inside a real root
// still evaluates correctly WITHOUT touching the filesystem for write.

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const SEP = path.sep;

/**
 * Resolve a path to an absolute, normalized, symlink-resolved real path using
 * read-only filesystem semantics.
 *
 * @returns {{ ok: true, real: string, residue: string[] } | { ok: false, reason: string }}
 */
function resolveReal(input) {
  const residue = [];
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "empty-or-non-string-path" };
  }

  // Absolute-normalize first (collapses `.`/`..` lexically, applies cwd for
  // relative inputs). This is the "absolute + normalized" requirement.
  const absolute = path.resolve(input);

  // Walk from the full path up to the root, finding the longest existing prefix
  // we can realpath. realpathSync resolves symlinks for the existing portion.
  let existing = absolute;
  const tail = [];
  const maxSegments = absolute.split(SEP).length + 2;
  for (let i = 0; i < maxSegments; i += 1) {
    try {
      const ls = lstatSync(existing);
      if (ls.isSymbolicLink()) {
        residue.push(`symlink-leaf:${existing}`);
      }
      const real = realpathSync(existing);
      const rebuilt = tail.length ? path.join(real, ...tail.slice().reverse()) : real;
      return { ok: true, real: path.normalize(rebuilt), residue };
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const parent = path.dirname(existing);
        if (parent === existing) {
          return { ok: false, reason: "no-existing-ancestor" };
        }
        tail.push(path.basename(existing));
        existing = parent;
        continue;
      }
      if (err && (err.code === "ELOOP" || err.code === "ENOTDIR")) {
        return { ok: false, reason: `uncanonicalizable:${err.code}` };
      }
      return { ok: false, reason: `uncanonicalizable:${err && err.code ? err.code : "unknown"}` };
    }
  }
  return { ok: false, reason: "resolution-bound-exceeded" };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a trailing path separator (but keep a bare root like "/" or "C:\\").
 */
function stripTrailingSep(p) {
  if (p.length > 1 && p.endsWith(SEP)) {
    const trimmed = p.replace(new RegExp(`${escapeRe(SEP)}+$`), "");
    return trimmed.length ? trimmed : p;
  }
  return p;
}

/**
 * Prefix-path containment test on already-real, normalized paths. Returns true
 * if `target` is `root` itself OR strictly inside `root`, with a separator
 * boundary so "/a/b" does not falsely contain "/a/bad".
 */
function isContained(rootReal, targetReal) {
  const root = stripTrailingSep(rootReal);
  const target = stripTrailingSep(targetReal);
  if (target === root) return true;
  return target.startsWith(`${root}${SEP}`);
}

/**
 * pathContains — the containment primitive.
 *
 * @param {string} root   Allowed root directory.
 * @param {string} target Candidate path that must stay inside `root`.
 * @returns {{ result: "pass" | "block", evidence: object }}
 */
export function pathContains(root, target) {
  const rootRes = resolveReal(root);
  if (!rootRes.ok) {
    return {
      result: "block",
      evidence: {
        reason: "root-uncanonicalizable",
        detail: rootRes.reason,
        root,
        target,
        remediation:
          "Configure root to an existing, canonicalizable absolute directory before evaluating containment.",
      },
    };
  }

  const targetRes = resolveReal(target);
  if (!targetRes.ok) {
    return {
      result: "block",
      evidence: {
        reason: "target-uncanonicalizable",
        detail: targetRes.reason,
        root: rootRes.real,
        target,
        remediation:
          "Reject the operation: target path could not be resolved (missing ancestor, broken symlink, or non-directory in chain).",
      },
    };
  }

  const contained = isContained(rootRes.real, targetRes.real);
  const symlinkResidue = [...rootRes.residue, ...targetRes.residue];

  if (contained) {
    return {
      result: "pass",
      evidence: {
        reason: "contained",
        rootReal: rootRes.real,
        targetReal: targetRes.real,
        symlinkResidue,
      },
    };
  }

  // Classify the escape for actionable evidence.
  const lexicalAbs = stripTrailingSep(path.resolve(target));
  const rootReal = stripTrailingSep(rootRes.real);
  const lexicalWouldBeInside = lexicalAbs === rootReal || lexicalAbs.startsWith(`${rootReal}${SEP}`);
  const movedBySymlink = symlinkResidue.length > 0 || lexicalAbs !== stripTrailingSep(targetRes.real);

  let escapeKind = "outside-root";
  if (movedBySymlink && lexicalWouldBeInside) escapeKind = "symlink-escape";
  else if (String(target).includes("..")) escapeKind = "dotdot-escape";
  else if (path.isAbsolute(target)) escapeKind = "absolute-outside";

  return {
    result: "block",
    evidence: {
      reason: "escape",
      escapeKind,
      rootReal: rootRes.real,
      targetReal: targetRes.real,
      symlinkResidue,
      remediation:
        "Reject: resolved target falls outside the allowed root after normalization and symlink resolution.",
    },
  };
}

/**
 * Throwing convenience wrapper for product call sites. Resolves `target` against
 * the allowed `root` and throws a clear, typed Error when the target escapes.
 *
 * @param {string} root   Allowed root directory.
 * @param {string} target Candidate path that must stay inside `root`.
 * @param {string} label  Human label for the guarded resource (used in errors).
 * @returns {string} The resolved real (symlink-canonicalized) target path.
 */
export function assertContained(root, target, label = "path") {
  const verdict = pathContains(root, target);
  if (verdict.result !== "pass") {
    const ev = verdict.evidence ?? {};
    const kind = ev.escapeKind ? ` (${ev.escapeKind})` : "";
    const error = new Error(
      `Refused ${label}: resolved path escapes the allowed root${kind}. ${ev.remediation ?? ""}`.trim(),
    );
    error.code = "EPATH_CONTAINMENT";
    error.containment = verdict.evidence;
    throw error;
  }
  return verdict.evidence.targetReal;
}

export default pathContains;
