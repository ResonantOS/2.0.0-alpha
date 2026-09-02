// subprocess-no-shell-string adapter.
//
// Static scanner for the string-to-shell process-construction class fixed in
// PR #333 (engineer-runner runCommand used spawnSync(command, {shell:true})
// with contract-file strings). Flags, in tracked JS/TS sources:
//   R1 exec-string-api         exec()/execSync() calls (shell-interpreted by design)
//   R2 shell-true-option       spawn-family calls with a shell: option that is not false
//   R3 template-command-arg    spawn-family calls whose command argument is a
//                              template literal (dynamic command construction)
// Argv-form spawns (array args, shell:false or default) are the sanctioned pattern
// and pass. Allowlist entries below carry the data-flow rationale for each
// known-safe site. Wraps into the run-check.mjs contract:
//   run({ check, repoRoot }) -> { status, summary, evidence[] }
//
// Known blind spots (by design, documented): string- and comment-literal
// contents are masked before matching, so call-shaped text inside strings or
// comments never flags (and code inside template ${...} interpolation is
// masked with the template); a shell: option whose value is a string literal
// (e.g. shell: "bash") is masked with the string and not flagged.
//
// Verdict mapping: clean -> pass, violation(s) -> fail, no sources -> skipped.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

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

// Longest names first so execFileSync is not matched as exec.
const CALL_PATTERN = /(?<![.\w$])(execFileSync|execFile|execSync|exec|spawnSync|spawn)\s*\(/g;
const STRING_API_NAMES = new Set(["exec", "execSync"]);
const SPAWN_FAMILY_NAMES = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
const SHELL_OPTION_PATTERN = /(?:^|[{,(\s])shell\s*:\s*(?!"false"|'false'|false\b)(?:"[^"]*"|'[^']*'|true\b|[^,})\s][^,})]*)/;

function isSourceFile(fileName) {
  return SOURCE_EXTENSIONS.has(path.extname(fileName));
}

// Replace comment and string/template-literal contents with spaces (newlines
// preserved) so the result has identical length and line structure to the
// input, but only real code positions remain for call matching.
export function maskCode(text) {
  const out = text.split("");
  let quote = null;
  let lineComment = false;
  let blockComment = false;
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
    if (quote) {
      if (ch === "\\") { out[index] = " "; out[index + 1] = " "; index += 1; continue; }
      if (ch === quote) {
        quote = null;
        continue;
      }
      out[index] = ch === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === "/" && next === "/") { out[index] = " "; out[index + 1] = " "; lineComment = true; index += 1; continue; }
    if (ch === "/" && next === "*") { out[index] = " "; out[index + 1] = " "; blockComment = true; index += 1; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
  }
  return out.join("");
}

export async function listSourceFiles(rootDir, current = rootDir) {
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
    const name = match[1];
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findCallSpanEnd(masked, openParenIndex);
    if (closeParenIndex === -1) continue;
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
