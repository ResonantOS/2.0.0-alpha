// terminal-allowlist core (ported in-tree from research p0-invoke/checks/subprocess).
//
// check(commandRecord) -> { result: "pass" | "block", site, head, evidence[], recommendation }
//
//   command head on allowlist            => PASS (runs unprompted)
//   off-list WITH approval marker        => PASS (operator authorized THIS command)
//   off-list WITHOUT approval marker     => BLOCK
//   dynamic shell string (no resolvable inner head) => off-list => BLOCK w/o marker
//
// `commandRecord` provides ONE of: {program,args[]} | {command} | {argv[]},
//   plus optional { dynamic, approved_by }.
//
// The allowlist is inlined here (ported from terminal-allowlist.yml) so this is
// dependency-free with no external YAML file. No runtime import from .craft/.

const RECOMMENDATION =
  "Either add the command head to the terminal allowlist (only read-only / " +
  "safe inspection commands belong there) OR route it through the per-command " +
  "approval shim: record an explicit operator approval marker for THIS command " +
  "before execution. Arbitrary dynamic shell passthrough must always require " +
  "approval; never run an unresolved command string unprompted.";

const SHELL_FLAGS = new Set(["-lc", "-c", "-ic", "/c", "/C", "-Command", "-command"]);

export const ALLOWLIST = {
  approval_marker_field: "approved_by",
  shell_wrappers: ["sh", "bash", "zsh", "cmd", "powershell", "pwsh"],
  allow: [
    "command",
    "which",
    "where",
    "ps",
    "nm",
    "rg",
    "git",
    "ollama",
    "hermes",
    "uv",
  ],
};

function baseName(tok) {
  if (!tok) return "";
  const s = String(tok);
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function resolveHead(rec, policy) {
  const shells = new Set(policy.shell_wrappers || []);
  const headName = (tok) => baseName(tok);

  let argv = null;
  if (Array.isArray(rec.argv) && rec.argv.length) {
    argv = rec.argv.map(String);
  } else if (rec.program != null) {
    argv = [String(rec.program), ...((rec.args || []).map(String))];
  } else if (typeof rec.command === "string") {
    argv = rec.command.trim().split(/\s+/);
  }

  if (!argv || argv.length === 0) {
    return { head: null, shell: null, dynamic: true, reason: "no command vector to resolve" };
  }

  const head0 = headName(argv[0]);
  if (shells.has(head0)) {
    if (rec.dynamic === true) {
      return { head: null, shell: head0, dynamic: true, reason: "shell wraps a runtime-built dynamic command string" };
    }
    let innerStart = -1;
    for (let k = 1; k < argv.length; k++) {
      if (SHELL_FLAGS.has(argv[k])) {
        innerStart = k + 1;
        break;
      }
    }
    if (innerStart < 0) {
      const firstArg = argv.slice(1).find((t) => !t.startsWith("-"));
      if (!firstArg) {
        return { head: head0, shell: head0, dynamic: false, reason: `bare shell '${head0}' with no inner command` };
      }
      return {
        head: headName(firstArg),
        shell: head0,
        dynamic: false,
        reason: `shell script invocation ${head0} <${firstArg}>`,
      };
    }
    if (innerStart >= argv.length) {
      return { head: null, shell: head0, dynamic: true, reason: "shell invoked with no resolvable inner command" };
    }
    const innerTokens = argv
      .slice(innerStart)
      .join(" ")
      .replace(/^["']|["']$/g, "")
      .trim()
      .split(/\s+/);
    const innerHead = headName(innerTokens[0]);
    if (!innerHead) {
      return { head: null, shell: head0, dynamic: true, reason: "shell inner command head is empty/dynamic" };
    }
    return { head: innerHead, shell: head0, dynamic: false, reason: `unwrapped ${head0} -> '${innerHead}'` };
  }

  if (rec.dynamic === true) {
    return { head: head0 || null, shell: null, dynamic: true, reason: "command head is a runtime-built dynamic value" };
  }
  return { head: head0, shell: null, dynamic: false, reason: "direct command head" };
}

export function check(commandRecord, opts = {}) {
  const rec = commandRecord || {};
  const site = rec.site || "<unknown-site>";
  const policy = opts.allowlist || ALLOWLIST;

  const allowed = new Set(policy.allow || []);
  const markerField = policy.approval_marker_field || "approved_by";
  const approved = Boolean(rec[markerField]);

  const r = resolveHead(rec, policy);
  const onList = r.head != null && !r.dynamic && allowed.has(r.head);

  if (onList) {
    return {
      result: "pass",
      site,
      head: r.head,
      shell: r.shell || null,
      on_allowlist: true,
      approved,
      evidence: [],
      recommendation: null,
    };
  }

  if (approved) {
    return {
      result: "pass",
      site,
      head: r.head,
      shell: r.shell || null,
      on_allowlist: false,
      approved: true,
      evidence: [
        {
          rule: "off-list-approved",
          site,
          head: r.head,
          why: `off-allowlist command authorized by approval marker '${markerField}'=${JSON.stringify(rec[markerField])}.`,
        },
      ],
      recommendation: null,
    };
  }

  const evidence = [
    {
      rule: r.dynamic ? "dynamic-command-no-approval" : "off-list-no-approval",
      site,
      head: r.head,
      shell: r.shell || null,
      resolution: r.reason,
      why:
        (r.dynamic
          ? `dynamic/unresolved command (${r.reason})`
          : `command head '${r.head}' is not on the terminal allowlist`) +
        ` and carries no '${markerField}' approval marker => block.`,
    },
  ];

  return {
    result: "block",
    site,
    head: r.head,
    shell: r.shell || null,
    on_allowlist: false,
    approved: false,
    evidence,
    recommendation: RECOMMENDATION,
  };
}
