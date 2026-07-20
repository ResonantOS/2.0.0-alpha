// pinned-roots core (ported in-tree from research p0-invoke/checks/subprocess).
//
// check(loadRecord) -> { result: "pass" | "block", site, kind, program, evidence[], recommendation }
//
// A native shared library load (Library::new) or an executed binary MUST be
// resolved from a PINNED root (absolute path, system bin, install prefix, or
// current_exe anchored under a pinned subdir). A path anchored on a DYNAMIC base
// (cwd, env-var, user-supplied, bare path-lookup) is unpinned => BLOCK.
//
// `loadRecord` = { site, kind: "native-library"|"binary", program,
//   resolution: { base, path, env_var?, anchored_under? }, candidates?: [...] }
//
// Dependency-free. No runtime import from .craft/.

const RECOMMENDATION =
  "Resolve the library/binary from a PINNED root only: an absolute path, a " +
  "system bin dir, or a path anchored under the app bundle (current_exe -> " +
  "Resources/lib). Do NOT anchor on env::current_dir() (CWD), a bare PATH " +
  "lookup, or a raw env-var/user path. If a path must come from config, " +
  "canonicalize it and assert it is contained within an allowlisted pinned " +
  "prefix before Library::new / Command::new.";

const PINNED_BASES = new Set(["absolute", "system-bin", "install-prefix"]);
const UNPINNED_BASES = new Set(["cwd", "env-var", "user-supplied", "path-lookup"]);
const EXE_PINNED_ANCHORS = new Set(["Resources", "MacOS", "lib", "bin", "Contents"]);

function isAbsolutePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  return false;
}

function classify(cand) {
  const base = cand.base || "<unspecified>";
  const path = cand.path || "";

  if (UNPINNED_BASES.has(base)) {
    return { pinned: false, base, path, reason: `base '${base}' is attacker-influenceable` };
  }
  if (base === "absolute" || isAbsolutePath(path)) {
    return { pinned: true, base, path, reason: "absolute pinned path" };
  }
  if (PINNED_BASES.has(base)) {
    return { pinned: true, base, path, reason: `pinned base '${base}'` };
  }
  if (base === "current_exe") {
    const anchor = cand.anchored_under;
    if (anchor && EXE_PINNED_ANCHORS.has(anchor)) {
      return { pinned: true, base, path, reason: `anchored under current_exe/${anchor}` };
    }
    return { pinned: false, base, path, reason: "current_exe candidate not anchored under a pinned subdir" };
  }
  return { pinned: false, base, path, reason: `relative path on base '${base}'` };
}

export function check(loadRecord) {
  const rec = loadRecord || {};
  const site = rec.site || "<unknown-site>";
  const kind = rec.kind || "binary";
  const program = rec.program || "<unknown>";
  const evidence = [];

  const candidates = [];
  if (rec.resolution) candidates.push(rec.resolution);
  if (Array.isArray(rec.candidates)) candidates.push(...rec.candidates);
  if (candidates.length === 0) {
    evidence.push({
      rule: "no-resolution",
      site,
      kind,
      why: "load_record carries no resolution/candidates to evaluate; cannot prove a pinned root.",
    });
  }

  for (const cand of candidates) {
    const c = classify(cand);
    if (!c.pinned) {
      evidence.push({
        rule: kind === "native-library" ? "unpinned-native-load" : "unpinned-binary-exec",
        site,
        kind,
        program,
        base: c.base,
        path: c.path,
        env_var: cand.env_var,
        why:
          `${kind === "native-library" ? "Library::new" : "Command::new"} resolves ` +
          `'${program}' from ${c.reason}` +
          (cand.env_var ? ` (env var ${cand.env_var})` : "") +
          `: ${c.path || "<no path>"}. Code loaded/executed from an unpinned root.`,
      });
    }
  }

  const result = evidence.length > 0 ? "block" : "pass";
  return {
    result,
    site,
    kind,
    program,
    evidence,
    recommendation: result === "block" ? RECOMMENDATION : null,
  };
}
