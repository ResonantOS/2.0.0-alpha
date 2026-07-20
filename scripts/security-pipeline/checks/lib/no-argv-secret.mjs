// no-argv-secret core (ported in-tree from research p0-invoke/checks/subprocess).
//
// check(argvFixture) -> { result: "pass" | "block", site, evidence[], recommendation }
//
// `argvFixture` is a parsed spawn descriptor:
//   { site, program, args: [...], stdin?, env? }
// Scans each arg in the spawn arg vector. If any arg matches a secret pattern
// (Bearer token, prompt passthrough, API-key shape) -> "block". Otherwise "pass".
// A secret supplied via stdin / temp-file / SDK is NOT a finding.
//
// Dependency-free. No runtime import from .craft/.

const RECOMMENDATION =
  "Move the value off argv: feed via child stdin, a 0600 temp file referenced " +
  "by path, or the runtime SDK in-process auth. Never place secrets/prompts on " +
  "the command line (visible via /proc, `ps`, audit logs, shell history).";

// Flags whose *following* arg carries a secret or full user prompt.
const SECRET_VALUE_FLAGS = new Map([
  ["-q", "prompt passthrough (CLI quick-query flag carries full user prompt)"],
  ["--query", "prompt passthrough"],
  ["-p", "prompt passthrough"],
  ["--prompt", "prompt passthrough"],
  ["--api-key", "API key on argv"],
  ["--token", "auth token on argv"],
  ["--password", "credential on argv"],
  ["--secret", "secret on argv"],
  ["-H", "HTTP header on argv (may carry Authorization)"],
  ["--header", "HTTP header on argv (may carry Authorization)"],
]);

const INLINE_RULES = [
  {
    id: "bearer-token",
    why: "Authorization: Bearer <token> embedded in argv",
    test: (a) => /authorization\s*:\s*bearer\s+\S/i.test(a),
  },
  {
    id: "basic-auth",
    why: "Authorization: Basic <creds> embedded in argv",
    test: (a) => /authorization\s*:\s*basic\s+\S/i.test(a),
  },
  {
    id: "api-key-header",
    why: "x-api-key / api-key header value embedded in argv",
    test: (a) => /(x-api-key|api[-_]?key)\s*:\s*\S/i.test(a),
  },
  {
    id: "inline-flag-secret",
    why: "secret/key/token/password passed as --flag=value on argv",
    test: (a) =>
      /^--(api[-_]?key|token|password|secret|auth[-_]?token)=\S/i.test(a),
  },
  {
    id: "api-key-shape",
    why: "value matches a known API-key shape (sk-/OpenAI, sk-ant-/Anthropic, ghp_/GitHub, AKIA/AWS)",
    test: (a) =>
      /\bsk-ant-[A-Za-z0-9_-]{8,}/.test(a) ||
      /\bsk-[A-Za-z0-9]{16,}/.test(a) ||
      /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(a) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(a),
  },
  {
    id: "prompt-template-token",
    why: "argv carries an interpolated prompt placeholder (e.g. {prompt})",
    test: (a) =>
      /\{?\bprompt\b\}?/i.test(a) &&
      a.length > 0 &&
      /\{prompt\}|\$\{?prompt\}?|<prompt>/i.test(a),
  },
];

export function check(argvFixture) {
  const evidence = [];
  const site = argvFixture && argvFixture.site ? argvFixture.site : "<unknown-site>";
  const args = Array.isArray(argvFixture && argvFixture.args) ? argvFixture.args : [];

  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);

    for (const rule of INLINE_RULES) {
      if (rule.test(arg)) {
        evidence.push({ rule: rule.id, site, arg_index: i, arg, why: rule.why });
      }
    }

    const flagWhy = SECRET_VALUE_FLAGS.get(arg);
    if (flagWhy !== undefined && i + 1 < args.length) {
      const value = String(args[i + 1]);
      const isHeaderFlag = arg === "-H" || arg === "--header";
      const headerIsAuth =
        /authorization\s*:\s*(bearer|basic)\s+\S/i.test(value) ||
        /(x-api-key|api[-_]?key)\s*:\s*\S/i.test(value);
      if (!isHeaderFlag || headerIsAuth) {
        evidence.push({
          rule: "flag-value-secret",
          site,
          flag: arg,
          arg_index: i + 1,
          arg: value,
          why: flagWhy,
        });
      }
    }
  }

  const result = evidence.length > 0 ? "block" : "pass";
  return {
    result,
    site,
    evidence,
    recommendation: result === "block" ? RECOMMENDATION : null,
  };
}
