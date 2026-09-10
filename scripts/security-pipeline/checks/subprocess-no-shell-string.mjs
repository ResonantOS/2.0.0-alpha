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
// with a reason if the data flow is provably safe.
//
// Scope: in a git checkout the scan enumerates git-tracked and visible
// untracked files (git ls-files --cached --others --exclude-standard), so
// gitignored scratch and nested worktrees are never scanned; outside a git
// checkout it walks the tree skipping node_modules/.git/dist/coverage.
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
    snippet: `const child = spawn("npm", ["run", "dev"], {`,
    reason: "constant argv (\"npm\", [\"run\", \"dev\"]); no untrusted content; known follow-up of PR #333",
  },
];

// Two alternatives (review 2026-09-08): bare calls of any name, plus member
// calls such as cp.spawnSync(...) or child_process.execSync(...) — only
// `.exec(` stays excluded, because member exec is overwhelmingly
// RegExp.prototype.exec or a domain method, not the child_process string API.
// Longest names first within each group so execFileSync is not matched as exec.
const CALL_PATTERN =
  /(?<![.\w$])(execFileSync|execFile|execSync|exec|spawnSync|spawn)\s*\(|(?<=\.)(execFileSync|execFile|execSync|spawnSync|spawn)\s*\(/g;
const STRING_API_NAMES = new Set(["exec", "execSync"]);
const SPAWN_FAMILY_NAMES = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
// R2 match: an options-object `shell:` whose value is anything except false
// (including string values like "bash"), or the shorthand `{ shell }` form of
// a variable that is not provably false.
const SHELL_OPTION_PATTERN =
  /(?:^|[{,(\s])(?:shell\s*:\s*(?!"false"|'false'|false\b)(?:"[^"]*"|'[^']*'|true\b|[^,})\s][^,})]*)|shell\s*(?=[},]))/;

function isSourceFile(fileName) {
  return SOURCE_EXTENSIONS.has(path.extname(fileName));
}

// Replace comment and string/template-literal/regex-literal contents with
// spaces (newlines preserved) so the result has identical length and line
// structure to the input, but only real code positions remain for call
// matching.
//
// Regex-literal handling is positional (not a JS parser): a `/` that follows
// one of `( , = : ? ; ! [ { & |` or the keyword `return` (or the start of the
// file) opens a regex literal whose body, character classes, and flags are
// masked. A `/` after an identifier, `)`, `]`, or a digit stays division.
// Single- and double-quote state resets at newline (non-template strings
// cannot span lines), so a quote inside a regex or a truncated string can
// only invert masking until the end of its line, never the rest of the file.
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
// invert masking for the rest of the file, hiding real violations).
const REGEX_CONTEXT_CHARS = new Set(["(", ",", "=", ":", "?", ";", "!", "[", "{", "&", "|"]);

function regexStartContext(prevCode, prevWord) {
  return prevCode === "" || REGEX_CONTEXT_CHARS.has(prevCode) || prevWord === "return";
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
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
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
  const findings = [];
  CALL_PATTERN.lastIndex = 0;
  let match;
  while ((match = CALL_PATTERN.exec(masked)) !== null) {
    const name = match[1] ?? match[2];
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findCallSpanEnd(masked, openParenIndex);
    if (closeParenIndex === -1) {
      // Review 2026-09-08: a call span past MAX_CALL_SPAN_CHARS used to be
      // skipped silently, so a huge inline options object could hide a
      // `shell: true`. Unparseable spans surface as findings instead.
      const lineNumber = masked.slice(0, match.index).split("\n").length;
      const snippet = (lines[lineNumber - 1] ?? "").trim();
      findings.push({ file: fileName, line: lineNumber, rule: "unparseable-call-span", snippet });
      continue;
    }
    const span = masked.slice(openParenIndex, closeParenIndex + 1);
    const lineNumber = masked.slice(0, match.index).split("\n").length;
    const snippet = (lines[lineNumber - 1] ?? "").trim();

    if (STRING_API_NAMES.has(name)) {
      findings.push({ file: fileName, line: lineNumber, rule: "exec-string-api", snippet });
      continue;
    }
    if (!SPAWN_FAMILY_NAMES.has(name)) continue;

    if (SHELL_OPTION_PATTERN.test(span)) {
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
  const files = await listSourceFiles(repoRoot);
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
