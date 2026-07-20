// env-clear-present core (ported in-tree from research p0-invoke/checks/subprocess).
//
// check(spawnRecord) -> { result: "pass" | "block", site, runtime, evidence[], recommendation }
//
// `spawnRecord` describes one agent-runtime spawn site:
//   { site, runtime, env_clear, env_remove[], env_vars[], opt_in_vars[], opt_in }
//
// Algorithm:
//   1. Resolve runtime allowlist = base_allow + runtimes.<runtime>.allow.
//   2. env_clear === false AND env_vars empty => blanket inheritance => BLOCK.
//   3. env_vars non-empty but env_clear === false => missing clear => BLOCK.
//   4. env_clear === true and an injected var is outside the allowlist (and not
//      an opt-in var) => BLOCK.
//   5. Otherwise PASS.
//
// The per-runtime env allowlist is inlined here (ported from env-allowlist.yml)
// so this is dependency-free with no external YAML file. No runtime .craft import.

const RECOMMENDATION =
  "Call .env_clear() (or build the Command from an empty env) BEFORE any " +
  ".env()/.envs() injection, then re-inject ONLY this runtime's allowlisted " +
  "vars. Pin PATH to fixed roots; do not append the ambient PATH. Extra vars " +
  "require the documented --allow-env opt-in.";

export const ALLOWLIST = {
  opt_in_flag: "--allow-env",
  base_allow: ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"],
  runtimes: {
    hermes: { allow: ["HERMES_HOME"] },
    opencode: { allow: [] },
    codex: { allow: ["PATH", "CODEX_HOME"] },
    ollama: { allow: ["OLLAMA_HOST", "OLLAMA_MODELS"] },
    memory: { allow: [] },
    "browser-host": { allow: ["RESONANTOS_NODE"] },
  },
};

export function check(spawnRecord, opts = {}) {
  const rec = spawnRecord || {};
  const site = rec.site || "<unknown-site>";
  const runtime = rec.runtime || "<unknown-runtime>";
  const policy = opts.allowlist || ALLOWLIST;
  const evidence = [];

  const envVars = Array.isArray(rec.env_vars) ? rec.env_vars.map(String) : [];
  const envRemove = Array.isArray(rec.env_remove) ? rec.env_remove.map(String) : [];
  const optInVars = Array.isArray(rec.opt_in_vars) ? rec.opt_in_vars.map(String) : [];
  const cleared = rec.env_clear === true;
  const optIn = rec.opt_in === true;

  const rt = policy.runtimes[runtime];
  const allowed = new Set([
    ...(policy.base_allow || []),
    ...((rt && rt.allow) || []),
    ...(optIn ? optInVars : []),
  ]);

  if (!rt) {
    evidence.push({
      rule: "unknown-runtime",
      site,
      runtime,
      why: `no allowlist defined for runtime '${runtime}'`,
    });
  }

  if (!cleared && envVars.length === 0) {
    evidence.push({
      rule: "blanket-inheritance",
      site,
      runtime,
      why:
        "spawn neither calls .env_clear() nor injects any var; the child " +
        "inherits the entire ambient parent environment (secrets, tokens, PATH).",
    });
  }

  if (!cleared && envVars.length > 0) {
    evidence.push({
      rule: "missing-env-clear",
      site,
      runtime,
      injected: envVars,
      env_remove: envRemove,
      why:
        ".env()/.envs() injection without a preceding .env_clear(): the " +
        "ambient parent env still flows through" +
        (envRemove.length
          ? ` (.env_remove of ${envRemove.join(", ")} drops only those, not the rest)`
          : "") +
        ".",
    });
  }

  if (cleared) {
    for (const v of envVars) {
      if (!allowed.has(v)) {
        evidence.push({
          rule: "var-outside-allowlist",
          site,
          runtime,
          var: v,
          allowed: [...allowed],
          why:
            `injected var '${v}' is not in the ${runtime} allowlist and is ` +
            `not an opt-in var under ${policy.opt_in_flag}.`,
        });
      }
    }
  }

  const result = evidence.length > 0 ? "block" : "pass";
  return {
    result,
    site,
    runtime,
    env_clear: cleared,
    evidence,
    recommendation: result === "block" ? RECOMMENDATION : null,
  };
}
