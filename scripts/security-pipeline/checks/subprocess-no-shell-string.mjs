// subprocess-no-shell-string adapter.
//
// Static scanner for the string-to-shell process-construction class fixed in
// PR #333 (engineer-runner runCommand used spawnSync(command, {shell:true})
// with contract-file strings). Flags, in tracked JS/TS sources:
//   R1 exec-string-api         exec()/execSync() calls (shell-interpreted by design)
//   R2 shell-true-option       spawn-family calls with a shell: option that is not
//                              false — string values (shell: "bash") and the
//                              shorthand form ({ shell }) both flag
//   R3 template-command-arg    spawn-family calls whose command argument is a
//                              template literal (dynamic command construction)
//   R4 unparseable-call-span   a matched call whose span cannot be parsed within
//                              MAX_CALL_SPAN_CHARS (a huge inline options object
//                              must not silently hide a shell: true)
// Bare and member calls both match (cp.spawnSync, child_process.execSync);
// only `.exec(` is excluded — member exec is RegExp.prototype.exec or a
// domain method, not the child_process string API. Argv-form spawns (array
// args, shell:false or default) are the sanctioned pattern and pass.
// Allowlist entries below carry the data-flow rationale for each known-safe
// site. Wraps into the run-check.mjs contract:
//   run({ check, repoRoot }) -> { status, summary, evidence[] }
//
// Known blind spots (by design, documented): string- and comment-literal
// contents are masked before matching, so call-shaped text inside strings or
// comments never flags (and code inside template ${...} interpolation is
// masked with the template). Regex literals are masked positionally (see
// maskCode), so a quote inside /.../ does not open a phantom string; a quote
// state opened by other malformed input resets at the next newline. The
// shorthand { shell } flags even when the variable is false — allowlist it
// with a reason if the data flow is provably safe. A template literal's
// backtick state legitimately spans lines, so an unterminated-looking
// template can mask later lines until its closing backtick (no instance in
// this repo). Spread overrides after a literal `shell: false` (e.g.
// { shell: false, ...options }) can re-enable the shell invisibly — spread
// values are not resolved. Provenance tracking is textual: an import-shaped
// string literal could register a phantom alias (over-matching direction;
// allowlist relief applies).
//
// Scope: in a git checkout the scan enumerates git-tracked and visible
// untracked files (git ls-files --cached --others --exclude-standard), so
// gitignored scratch and nested worktrees are never scanned; outside a git
// checkout it walks the tree skipping dot-directories, node_modules, dist,
// and coverage. Blind spot: a git invocation that fails mid-scan (including
// a >32 MiB ls-files overflow, unreachable at this repo's size) falls back
// to the plain walk, which does enter unignored scratch.
//
// Verdict mapping: clean -> pass, violation(s) -> fail, no sources -> skipped.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SOURCE_EXTENSIONS = new Set([".mjs", ".js", ".ts", ".tsx", ".jsx"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);
const MAX_CALL_SPAN_CHARS = 8000;

// Known-safe call sites. Each entry pins file + rule + exact trimmed source
// line, so moved or edited code re-flags and forces a fresh look.
// Why each is safe (data flow):
//  - engineer-runner.test.mjs: node:test fixtures whose command strings are
//    compile-time literals ("git init", ...) with no variable content.
//  - ensure-dev-server.mjs: argv elements are compile-time constants ("npm",
//    "run", "dev"); no stored/request content reaches the shell. Public
//    follow-up of the PR #333 fix (same shape as the engineer-runner site).
const ALLOWLIST = [
  {
    file: "scripts/engineer-runner.test.mjs",
    rule: "shell-true-option",
    snippet: `spawnSync("git init", { cwd: repo, shell: true, stdio: "ignore" });`,
    reason: "test fixture, literal command, no variable content",
  },
  {
    file: "scripts/engineer-runner.test.mjs",
    rule: "shell-true-option",
    snippet: `spawnSync("git config user.email test@example.com", { cwd: repo, shell: true, stdio: "ignore" });`,
    reason: "test fixture, literal command, no variable content",
  },
  {
    file: "scripts/engineer-runner.test.mjs",
    rule: "shell-true-option",
    snippet: `spawnSync("git config user.name Test", { cwd: repo, shell: true, stdio: "ignore" });`,
    reason: "test fixture, literal command, no variable content",
  },
  {
    file: "scripts/engineer-runner.test.mjs",
    rule: "shell-true-option",
    snippet: `spawnSync("git add . && git commit -m initial", { cwd: repo, shell: true, stdio: "ignore" });`,
    reason: "test fixture, literal command, no variable content",
  },
  {
    file: "scripts/ensure-dev-server.mjs",
    rule: "shell-true-option",
    snippet: `const child = spawn("npm", ["run", "dev"], {
  cwd: process.cwd(),
  stdio: "ignore",
  detached: true,
  shell: true,
});`,
    reason: "constant argv (\"npm\", [\"run\", \"dev\"]); no untrusted content; known follow-up of PR #333",
  },
];

// Three alternatives (review 2026-09-11): bare calls of any name — including
// per-file ALIAS names, injected into the alternation by buildCallPattern,
// because `spawnImpl = spawn` call sites are otherwise invisible; member
// calls such as cp.spawnSync(...); and receiver-qualified member calls with
// the receiver captured, so `.exec(` flags only when the receiver is a known
// child_process binding (member exec is overwhelmingly RegExp.prototype.exec
// or a domain method otherwise). Longest names first within each group so
// execFileSync is not matched as exec.
const CALL_NAMES = ["execFileSync", "execFile", "execSync", "exec", "spawnSync", "spawn"];

function buildCallPattern(extraNames = []) {
  const bareNames = [...new Set([...extraNames, ...CALL_NAMES])];
  const memberNames = CALL_NAMES.filter((name) => name !== "exec");
  return new RegExp(
    `(?<![.\\w$])(${bareNames.join("|")})\\s*\\(` +
      `|(?<=\\.)(${memberNames.join("|")})\\s*\\(` +
      `|([A-Za-z_$][\\w$]*)\\.(${CALL_NAMES.join("|")})\\s*\\(`,
    "g",
  );
}
const STRING_API_NAMES = new Set(["exec", "execSync"]);
const SPAWN_FAMILY_NAMES = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
// R2 match: an options-object `shell:` whose value is anything except the
// bare boolean false — EXACTLY false, terminated by `,` or `}` (review
// 2026-09-11: `shell: false || true` used to pass as a prefix match) — or the
// shorthand `{ shell }` form of a variable that is not provably false. On
// masked text only bare tokens can appear — string contents are blanked — so
// every string-valued shell: (including shell: "false", which is a truthy
// executable spec, not the boolean) flags. Quoted keys ("shell": true) are
// invisible on masked text (the key blanks with its string) and are detected
// on the raw span by QUOTED_SHELL_KEY below.
const SHELL_OPTION_PATTERN =
  /(?:^|[{,(\s])(?:shell\s*:\s*(?!\s*false\s*[,}])(?:"[^"]*"|'[^']*'|true\b|[^,})\s][^,})]*)|shell\s*(?=[},]))/;
const QUOTED_SHELL_KEY = /["']shell["']\s*:\s*(?!\s*false\s*[,}])/;

// Provenance tracking (review 2026-09-11 blocker 2): this repo aliases the
// child_process APIs (`spawnImpl = spawn`, bridge-tls.mjs) and binds the
// module itself (`require("node:child_process")`), and those call sites were
// invisible to the bare/member patterns. Collected from RAW source (module
// names live inside strings, which masking blanks):
//   aliases:  import { exec as runIt } / const { spawn: s } = require(...) /
//             const spawnImpl = spawn           -> bare calls of the alias match
//   receivers: import cp from / import * as cp / const cp = require(...)
//             -> member calls receiver.exec(...) flag
// Known limit: provenance is textual — a string literal containing an
// import-shaped text could register a phantom alias (over-matching,
// allowlist relief applies).
const CHILD_PROCESS_API_NAMES = [...STRING_API_NAMES, ...SPAWN_FAMILY_NAMES].join("|");
const PROVENANCE_PATTERNS = [
  // import { a, b as c } from "node:child_process"
  [/import\s*\{([^}]+)\}\s*from\s*["']node:child_process["']/g, "names"],
  // const { a, b as c } = require("node:child_process")
  [/const\s*\{([^}]+)\}\s*=\s*require\(\s*["']node:child_process["']\s*\)/g, "names"],
  // const x = spawn  (bare alias of a tracked API)
  [new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(${CHILD_PROCESS_API_NAMES})\\b`, "g"), "alias"],
  // import cp from / import * as cp from / const cp = require(...)
  [/import\s+([A-Za-z_$][\w$]*)\s+from\s*["']node:child_process["']/g, "receiver"],
  [/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']node:child_process["']/g, "receiver"],
  [/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']node:child_process["']\s*\)/g, "receiver"],
];

function collectProvenance(rawSource) {
  const aliases = new Map();
  const receivers = new Set();
  for (const [pattern, kind] of PROVENANCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(rawSource)) !== null) {
      if (kind === "names") {
        for (const piece of match[1].split(",")) {
          const binding = piece.trim().split(/\s+as\s+/);
          const original = binding[0]?.trim();
          const bound = (binding[1] ?? binding[0])?.trim();
          if (original && bound && CHILD_PROCESS_API_NAMES.includes(original)) {
            aliases.set(bound, original);
          }
        }
      } else if (kind === "alias") {
        aliases.set(match[1], match[2]);
      } else {
        receivers.add(match[1]);
      }
    }
  }
  return { aliases, receivers };
}

function isSourceFile(fileName) {
  return SOURCE_EXTENSIONS.has(path.extname(fileName));
}

// Replace comment and string/template-literal/regex-literal contents with
// spaces (newlines preserved) so the result has identical length and line
// structure to the input, but only real code positions remain for call
// matching.
//
// Regex-literal handling is positional (not a JS parser): a `/` that follows
// one of `( , = : ? ; ! [ { & | >` (the `>` covers arrow-body regexes) or a
// keyword like `return` (or the start of the file) opens a regex literal
// whose body, character classes, and flags are masked. A `/` after an
// identifier, `)`, `]`, or a digit stays division. Single- and double-quote
// state resets at newline (non-template strings cannot span lines), so a
// quote inside a regex or a truncated string can only invert masking until
// the end of its line, never the rest of the file. prevCode/prevWord are
// deliberately stale across comment/string/regex spans — the last code
// context before a literal is the relevant one for the next `/`.
export function maskCode(text) {
  const out = text.split("");
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  let prevCode = "";
  let prevWord = "";
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      else out[index] = " ";
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { out[index] = " "; out[index + 1] = " "; blockComment = false; index += 1; }
      else if (ch !== "\n") out[index] = " ";
      continue;
    }
    if (regex) {
      if (ch === "\\") { out[index] = " "; out[index + 1] = " "; index += 1; continue; }
      if (ch === "\n") { regex = false; regexClass = false; continue; }
      if (regexClass) {
        if (ch === "]") regexClass = false;
        out[index] = " ";
        continue;
      }
      if (ch === "[") { regexClass = true; out[index] = " "; continue; }
      if (ch === "/") {
        regex = false;
        out[index] = " ";
        let flagsEnd = index + 1;
        while (flagsEnd < text.length && /[a-z]/i.test(text[flagsEnd])) { out[flagsEnd] = " "; flagsEnd += 1; }
        index = flagsEnd - 1;
        continue;
      }
      out[index] = " ";
      continue;
    }
    if (quote) {
      if (ch === "\\") { out[index] = " "; out[index + 1] = " "; index += 1; continue; }
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\n" && quote !== "`") {
        quote = null;
        continue;
      }
      out[index] = ch === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === "/" && next === "/") { out[index] = " "; out[index + 1] = " "; lineComment = true; index += 1; continue; }
    if (ch === "/" && next === "*") { out[index] = " "; out[index + 1] = " "; blockComment = true; index += 1; continue; }
    if (ch === "/" && regexStartContext(prevCode, prevWord)) {
      regex = true;
      out[index] = " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      prevCode = ch;
      prevWord = "";
      continue;
    }
    if (/\S/.test(ch)) {
      prevCode = ch;
      if (/[A-Za-z0-9_$]/.test(ch)) prevWord += ch;
      else prevWord = "";
    }
  }
  return out.join("");
}

// Positions after which a `/` unambiguously starts a regex literal (review
// 2026-09-08: quotes inside regex literals used to open phantom strings and
// invert masking for the rest of the file, hiding real violations). `>` covers
// arrow-body regexes (`(x) => /re/.test(x)`), this codebase's most common
// regex position; division can never follow `>` directly because its left
// operand (identifier, digit, `)`, `]`) is the immediately preceding char.
const REGEX_CONTEXT_CHARS = new Set(["(", ",", "=", ":", "?", ";", "!", "[", "{", "&", "|", ">"]);
const REGEX_CONTEXT_WORDS = new Set(["return", "case", "typeof", "in", "of", "new", "void", "delete", "await", "yield"]);

function regexStartContext(prevCode, prevWord) {
  return prevCode === "" || REGEX_CONTEXT_CHARS.has(prevCode) || REGEX_CONTEXT_WORDS.has(prevWord);
}

// Tracked-sources enumeration (review 2026-09-08, the #365 pattern from
// validate-docs): in a git checkout, `git ls-files --cached --others
// --exclude-standard` covers exactly tracked files plus visible untracked
// work, and never enters gitignored scratch or nested worktrees — a plain
// filesystem walk scanned both and could fail a clean checkout. The argv
// form (no shell) is the pattern this check mandates. Outside a git checkout
// the walk fallback applies.
async function listGitVisibleFiles(rootDir) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => !file.split("/").some((segment) => segment.startsWith(".") || SKIPPED_DIRECTORIES.has(segment)))
      .filter((file) => isSourceFile(file) && existsSync(path.join(rootDir, file)));
  } catch {
    return null;
  }
}

export async function listSourceFiles(rootDir, current = rootDir) {
  const gitFiles = await listGitVisibleFiles(rootDir);
  if (gitFiles) return gitFiles.sort();
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      files.push(...await listSourceFiles(rootDir, path.join(current, entry.name)));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      files.push(path.relative(rootDir, path.join(current, entry.name)));
    }
  }
  return files.sort();
}

// Index of the ')' matching the '(' at openParenIndex, quote-aware.
export function findCallSpanEnd(text, openParenIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openParenIndex; index < text.length; index += 1) {
    if (index - openParenIndex > MAX_CALL_SPAN_CHARS) return -1;
    const ch = text[index];
    if (quote) {
      if (ch === "\\") { index += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Text of the first argument (after `(`), up to the first top-level comma.
export function firstArgumentText(text, openParenIndex, closeParenIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openParenIndex + 1; index < closeParenIndex; index += 1) {
    const ch = text[index];
    if (quote) {
      if (ch === "\\") { index += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return text.slice(openParenIndex + 1, index).trim();
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      return text.slice(openParenIndex + 1, index).trim();
    }
  }
  return text.slice(openParenIndex + 1, closeParenIndex).trim();
}

export function scanSource(fileName, source) {
  const masked = maskCode(source);
  const lines = source.split("\n");
  const { aliases, receivers } = collectProvenance(source);
  const findings = [];
  const callPattern = buildCallPattern([...aliases.keys()]);
  let match;
  while ((match = callPattern.exec(masked)) !== null) {
    const bareName = match[1];
    const memberName = match[2] ?? match[4];
    const receiver = match[3];
    let name = bareName ?? memberName;
    if (bareName) {
      name = aliases.get(bareName) ?? bareName;
    } else if (memberName === "exec" && !receivers.has(receiver)) {
      // Member .exec( flags only on a tracked child_process receiver;
      // RegExp.prototype.exec and domain .exec methods stay exempt.
      continue;
    }
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findCallSpanEnd(masked, openParenIndex);
    const lineNumber = masked.slice(0, match.index).split("\n").length;
    if (closeParenIndex === -1) {
      // Review 2026-09-08: a call span past MAX_CALL_SPAN_CHARS used to be
      // skipped silently, so a huge inline options object could hide a
      // `shell: true`. Unparseable spans surface as findings instead.
      const snippet = (lines[lineNumber - 1] ?? "").trim();
      findings.push({ file: fileName, line: lineNumber, rule: "unparseable-call-span", snippet });
      continue;
    }
    const span = masked.slice(openParenIndex, closeParenIndex + 1);
    // Review 2026-09-11: fingerprint the whole call (multi-line included), so
    // an allowlisted site re-flags when ANY of its later lines is edited, not
    // just the opening one.
    const spanLines = source.slice(
      source.lastIndexOf("\n", match.index) + 1,
      source.indexOf("\n", closeParenIndex) === -1 ? source.length : source.indexOf("\n", closeParenIndex),
    ).trim();
    const snippet = spanLines;

    if (STRING_API_NAMES.has(name)) {
      findings.push({ file: fileName, line: lineNumber, rule: "exec-string-api", snippet });
      continue;
    }
    if (!SPAWN_FAMILY_NAMES.has(name)) continue;

    if (SHELL_OPTION_PATTERN.test(span) || QUOTED_SHELL_KEY.test(source.slice(match.index, closeParenIndex + 1))) {
      findings.push({ file: fileName, line: lineNumber, rule: "shell-true-option", snippet });
      continue;
    }
    const firstArgument = firstArgumentText(masked, openParenIndex, closeParenIndex);
    if (firstArgument.startsWith("`")) {
      findings.push({ file: fileName, line: lineNumber, rule: "template-command-arg", snippet });
    }
  }
  return findings;
}

function allowlisted(finding) {
  return ALLOWLIST.some((entry) =>
    entry.file === finding.file &&
    entry.rule === finding.rule &&
    entry.snippet === finding.snippet
  );
}

export async function run({ check, repoRoot }) {
  const registrySurfaces = Array.isArray(check?.surfaces) ? check.surfaces : null;
  const registryAllowlist = Array.isArray(check?.allowlist) ? check.allowlist : [];
  let files = await listSourceFiles(repoRoot);
  if (registrySurfaces) {
    // Registry `surfaces` scopes the scan (the convention the other checks
    // follow — review 2026-09-11 minor): a surface is a repo-relative prefix.
    files = files.filter((file) =>
      registrySurfaces.some((surface) => surface === "." || file === surface || file.startsWith(`${surface}/`)),
    );
  }
  if (files.length === 0) {
    return {
      status: "skipped",
      summary: "subprocess-no-shell-string: no JS/TS sources found; nothing to scan.",
      evidence: [],
    };
  }

  const violations = [];
  let allowlistedCount = 0;
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    for (const finding of scanSource(file, source)) {
      if (allowlisted(finding)) {
        allowlistedCount += 1;
        continue;
      }
      // Registry allowlist (checks.yml `allowlist: [{path, reason}]`) — the
      // exception convention the other checks use; internal ALLOWLIST entries
      // stay the primary, fingerprinted mechanism.
      if (registryAllowlist.some((entry) => entry.path === finding.file && entry.reason)) {
        allowlistedCount += 1;
        continue;
      }
      violations.push(finding);
    }
  }

  if (violations.length > 0) {
    return {
      status: "fail",
      summary:
        `subprocess-no-shell-string: ${violations.length} string-to-shell construction(s) found ` +
        `(${allowlistedCount} allowlisted site(s) skipped). ` +
        "Execute commands as argv arrays with shell:false (see PR #333).",
      evidence: violations.map((violation) => ({
        path: violation.file,
        line: violation.line,
        rule: violation.rule,
        snippet: violation.snippet,
      })),
    };
  }

  return {
    status: "pass",
    summary:
      `subprocess-no-shell-string: no string-to-shell constructions in ${files.length} source file(s) ` +
      `(${allowlistedCount} allowlisted site(s), data-flow safe).`,
    evidence: [],
  };
}
