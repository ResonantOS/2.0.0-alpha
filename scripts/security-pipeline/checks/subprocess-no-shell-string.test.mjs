import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCallSpanEnd,
  firstArgumentText,
  maskCode,
  run,
  scanSource,
} from "./subprocess-no-shell-string.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

// The real gate: current dev must be clean (only allowlisted sites may exist).
test("repo scan passes on the checkout", async () => {
  const result = await run({ check: {}, repoRoot: REPO_ROOT });
  assert.equal(result.status, "pass");
});

test("exec() string API -> exec-string-api", () => {
  const findings = scanSource(
    "fixture.mjs",
    `import { exec } from "node:child_process";\nexec(\`ls \${dir}\`, () => {});\n`
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "exec-string-api");
  assert.equal(findings[0].line, 2);
});

test("execSync() literal -> exec-string-api", () => {
  const findings = scanSource("fixture.mjs", `execSync("git status");\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "exec-string-api");
});

test("shell: true in a multi-line spawn call -> shell-true-option", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      "const child = spawn(\"npm\", [\"run\", \"dev\"], {",
      "  cwd: process.cwd(),",
      "  shell: true,",
      "});",
    ].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("shell: false spawn -> no findings", () => {
  const findings = scanSource(
    "fixture.mjs",
    `spawnSync(argv[0], argv.slice(1), { shell: false, encoding: "utf-8" });\n`
  );
  assert.deepEqual(findings, []);
});

test("default-shell spawn (argv form) -> no findings", () => {
  const findings = scanSource(
    "fixture.mjs",
    `const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"] });\n`
  );
  assert.deepEqual(findings, []);
});

test("template-literal command argument -> template-command-arg", () => {
  const findings = scanSource(
    "fixture.mjs",
    "const child = spawn(`/usr/bin/${tool} --scan`, { cwd });\n"
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "template-command-arg");
});

test("call-shaped text inside strings and comments is masked out", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      "// spawn(\"x\", { shell: true }) in a comment",
      "const doc = `use spawnSync(cmd, { shell: true }) here`;",
      'const note = "exec(formatCommand(input))";',
      "spawn(process.execPath, files);",
    ].join("\n")
  );
  assert.deepEqual(findings, []);
});

test("RegExp .exec() is not a child_process call", () => {
  const findings = scanSource(
    "fixture.mjs",
    `const match = /^#\\s+(.+)$/m.exec(content);\nconst other = text.exec(value);\n`
  );
  assert.deepEqual(findings, []);
});

test("execFileAsync wrapper name is not matched", () => {
  const findings = scanSource(
    "fixture.mjs",
    `const { stdout } = await execFileAsync("git", ["ls-files"]);\n`
  );
  assert.deepEqual(findings, []);
});

test("shell option nested in a call argument is found within the call span", () => {
  const findings = scanSource(
    "fixture.mjs",
    `wrap(spawn("npm", ["run", "dev"], { shell: true }), opts);\n`
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("allowlisted constant-argv site passes (ensure-dev-server shape)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spnssh-allowlist-"));
  try {
    const dir = path.join(root, "scripts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "ensure-dev-server.mjs"),
      [
        "const child = spawn(\"npm\", [\"run\", \"dev\"], {",
        "  cwd: process.cwd(),",
        "  stdio: \"ignore\",",
        "  detached: true,",
        "  shell: true,",
        "});",
        "",
      ].join("\n")
    );
    const result = await run({ check: {}, repoRoot: root });
    assert.equal(result.status, "pass");
    assert.match(result.summary, /1 allowlisted site/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edited allowlisted site re-flags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spnssh-edited-"));
  try {
    const dir = path.join(root, "scripts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "ensure-dev-server.mjs"),
      [
        "const command = readConfig();",
        "const child = spawn(command, [\"run\", \"dev\"], {",
        "  shell: true,",
        "});",
        "",
      ].join("\n")
    );
    const result = await run({ check: {}, repoRoot: root });
    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].rule, "shell-true-option");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Review 2026-09-11 blockers: the safe shell value must be EXACTLY false,
// quoted keys must flag, and aliased/module-bound call sites must scan.
test("shell: false || true flags (exactly-false requirement)", () => {
  const findings = scanSource("fixture.mjs", "spawn(cmd, args, { shell: false || true });\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("bare shell: false stays safe at value and object end", () => {
  assert.deepEqual(scanSource("fixture.mjs", "spawn(cmd, args, { shell: false });\n"), []);
  assert.deepEqual(scanSource("fixture.mjs", "spawn(cmd, args, { shell: false, cwd });\n"), []);
});

test("quoted shell keys flag when truthy and pass when exactly false", () => {
  const truthy = scanSource("fixture.mjs", 'spawn(cmd, args, { "shell": true });\n');
  assert.equal(truthy.length, 1);
  assert.equal(truthy[0].rule, "shell-true-option");
  assert.deepEqual(scanSource("fixture.mjs", "spawn(cmd, args, { 'shell': false });\n"), []);
});

test("injected alias of spawn scans under spawn semantics", () => {
  const flagged = scanSource(
    "fixture.mjs",
    'import { spawn as spawnImpl } from "node:child_process";\nspawnImpl(userCmd, { shell: true });\n'
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].rule, "shell-true-option");

  const clean = scanSource(
    "fixture.mjs",
    'const spawnImpl = spawn;\nspawnImpl(command, args, { stdio: ["ignore"] });\n'
  );
  assert.deepEqual(clean, []);
});

test("renamed exec import scans as the string API", () => {
  const findings = scanSource(
    "fixture.mjs",
    'import { exec as runShell } from "node:child_process";\nrunShell(command);\n'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "exec-string-api");
});

test("member .exec( flags on a tracked child_process receiver only", () => {
  const tracked = scanSource(
    "fixture.mjs",
    'const cp = require("node:child_process");\ncp.exec(command);\n'
  );
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].rule, "exec-string-api");

  assert.deepEqual(scanSource("fixture.mjs", 'const m = /^#(.+)$/m;\nm.exec(content);\n'), []);
});

test("registry surfaces scope the scan and registry allowlist exempts paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spnssh-registry-"));
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "browser-first"), { recursive: true });
    await writeFile(path.join(root, "scripts", "a.mjs"), "execSync('ls');\n");
    await writeFile(path.join(root, "browser-first", "b.mjs"), "execSync('ls');\n");
    const scoped = await run({ check: { surfaces: ["browser-first"] }, repoRoot: root });
    assert.equal(scoped.status, "fail");
    assert.deepEqual(scoped.evidence.map((item) => item.path), ["browser-first/b.mjs"]);

    // trailing slashes must not turn the prefix into "scripts//"
    const slashScoped = await run({ check: { surfaces: ["scripts/"] }, repoRoot: root });
    assert.equal(slashScoped.status, "fail");
    assert.deepEqual(slashScoped.evidence.map((item) => item.path), ["scripts/a.mjs"]);

    const exempt = await run({
      check: { allowlist: [{ path: "browser-first/b.mjs", reason: "documented fixture" }] },
      repoRoot: root,
    });
    assert.equal(exempt.status, "fail");
    assert.deepEqual(exempt.evidence.map((item) => item.path), ["scripts/a.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Review 2026-09-11 round 3: the cited alias sites are parameter defaults,
// not const declarations.
test("parameter-default alias of spawn scans (bridge-tls shape)", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      'import { spawn } from "node:child_process";',
      "async function run(cmd, args, opts = {}, spawnImpl = spawn) {",
      "  const child = spawnImpl(cmd, { shell: true });",
      "}",
    ].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

// Review 2026-09-11 round 3 major: a comment must not be able to overwrite a
// real import mapping and flip the scan to a false negative.
test("comment-shaped alias cannot overwrite an import binding", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      'import { exec } from "node:child_process";',
      "// const exec = spawn;",
      "exec(command);",
    ].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "exec-string-api");
});

// Review 2026-09-11 round 3 minor b: string ARGUMENTS must not fake a quoted
// shell key.
test("quoted shell-like text inside a string argument does not flag", () => {
  const findings = scanSource(
    "fixture.mjs",
    'spawn("printf", [\'{"shell": true}\'], { shell: false });\n'
  );
  assert.deepEqual(findings, []);
});

// Review 2026-09-11 round 3 minor a: destructuring renames use `:`, not `as`.
test("colon-rename destructured require registers the alias", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      'const { spawn: s } = require("node:child_process");',
      "s(userCmd, { shell: true });",
    ].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

// Same hostile classes, self-found before submission: alias chains and
// template-literal keys.
test("alias-of-alias chains resolve to the original API", () => {
  const findings = scanSource(
    "fixture.mjs",
    'import { spawn } from "node:child_process";\nconst a = spawn;\nconst b = a;\nb(cmd, { shell: true });\n'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("template-literal shell key flags", () => {
  const findings = scanSource("fixture.mjs", "spawn(cmd, args, { `shell`: true });\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

// Comorbidity sweep 2026-09-11 (predicted from the first-wins mechanism,
// confirmed by probe): rebinding a name to a child_process API later in the
// file must register.
test("late rebinding to spawn scans", () => {
  const findings = scanSource(
    "fixture.mjs",
    "let s = argv;\ns = spawn;\ns(cmd, { shell: true });\n"
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("unbalanced call span is skipped without throwing", () => {
  assert.equal(findCallSpanEnd("spawn(\"a\", { shell: true }", 5), -1);
  const text = "spawn(process.execPath, files)";
  assert.equal(findCallSpanEnd(text, 5), text.length - 1);
  assert.equal(firstArgumentText(text, 5, text.length - 1), "process.execPath");
});

// Review 2026-09-08 hardening: a quote inside a regex literal used to open a
// phantom string and invert masking for the rest of the file, hiding real
// violations that followed.
test("quote characters inside regex literals do not invert masking", () => {
  const masked = maskCode('const parts = text.split(/["\'();\\n]/);\n');
  // the regex body must be masked (spaces), the split( call must stay code
  assert.match(masked, /split\(\s+\)/);
  assert.doesNotMatch(masked, /\["\'/);

  const findings = scanSource(
    "fixture.mjs",
    [
      'const parts = text.split(/["\'();\\n]/);',
      'const child = spawnSync(userInput, { shell: true });',
    ].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
  assert.equal(findings[0].line, 2);
});

test("regex literals after return and in argument positions are masked", () => {
  const masked = maskCode(
    ['return /["\\\\]/.test(line);', 'wrap(/["x]/, value);', 'const map = { key: /[\'y]/ };'].join("\n")
  );
  // no quote state may survive any of the three regex literals
  assert.equal(masked.match(/"/g), null);
  assert.equal(masked.match(/'/g), null);
});

test("division after identifiers, digits, and parens stays code", () => {
  const masked = maskCode("const rate = total / count / 2;\nconst w = (a + b) / c;\n");
  assert.match(masked, /total \/ count \/ 2/);
  assert.match(masked, /\(a \+ b\) \/ c/);
});

// Arrow-body regexes are this codebase's most common regex position, and one
// tracked file has an apostrophe inside one — the combination that used to
// walk the phantom-string path (code review finding, 2026-09-10).
test("arrow-body regex with an apostrophe does not invert masking", () => {
  const masked = maskCode('const keep = msgs.filter((m) => /\\b(ok|don\'t)\\b/i.test(m));\n');
  // the regex body is masked; no quote state survives the line
  assert.doesNotMatch(masked, /don/);

  const findings = scanSource(
    "fixture.mjs",
    [
      'const keep = msgs.filter((m) => /\\b(ok|don\'t)\\b/i.test(m));',
      'spawnSync(userCmd, { shell: true });',
    ].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
  assert.equal(findings[0].line, 2);
});

test("arrow-body regex followed by a violation on the same line still flags", () => {
  const findings = scanSource(
    "fixture.mjs",
    'const bad = (s) => /don\'t/.test(s) || spawnSync(cmd, { shell: true });\n'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("division after a greater-than comparison stays code", () => {
  const masked = maskCode("const half = a > b ? total / 2 : total / count;\n");
  assert.match(masked, /total \/ 2/);
  assert.match(masked, /total \/ count/);
});

// The newline quote reset is one of the maintainer's explicit asks; pin it
// directly, including the backtick exception.
test("unterminated quote resets at newline; backtick templates span lines", () => {
  const masked = maskCode("const s = it's;\nexec(real);\nconst t = `a\nb`;\nexec(next);\n");
  // line 2's exec( survives as code despite the apostrophe on line 1
  assert.match(masked.slice(0, masked.indexOf("\n", masked.indexOf("exec(real)"))), /exec\(real\)/);
  // the template body across lines 3-4 is masked, the call after it is code
  const afterTemplate = masked.slice(masked.indexOf("`"));
  assert.match(afterTemplate, /exec\(next\)/);
  assert.doesNotMatch(masked, /`a\nb`/);
});

// R2 headline claims, previously untested: string-valued shell: flags, and
// shell: "false" is a truthy executable spec (not the boolean exemption).
test("string-valued shell options flag, including shell: \"false\"", () => {
  const bashFindings = scanSource("fixture.mjs", 'spawn(cmd, args, { shell: "bash" });\n');
  assert.equal(bashFindings.length, 1);
  assert.equal(bashFindings[0].rule, "shell-true-option");

  const falseStringFindings = scanSource("fixture.mjs", 'spawn(cmd, args, { shell: "false" });\n');
  assert.equal(falseStringFindings.length, 1);
  assert.equal(falseStringFindings[0].rule, "shell-true-option");

  const bareFalse = scanSource("fixture.mjs", "spawn(cmd, args, { shell: false });\n");
  assert.deepEqual(bareFalse, []);
});

// Review 2026-09-08 hardening: member calls (cp.spawnSync, child_process
// .execSync) were never scanned because the lookbehind excluded every
// member call; only `.exec(` keeps the carve-out.
test("member spawn-family calls are scanned", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      'import cp from "node:child_process";',
      "cp.spawnSync(userInput, { shell: true });",
      'child_process.execSync("ls -la " + dir);',
      "cp.spawn(argv[0], argv.slice(1), { stdio: 'ignore' });",
    ].join("\n")
  );
  assert.equal(findings.length, 2);
  assert.equal(findings[0].rule, "shell-true-option");
  assert.equal(findings[0].line, 2);
  assert.equal(findings[1].rule, "exec-string-api");
  assert.equal(findings[1].line, 3);
});

test("member .exec( keeps the RegExp carve-out", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      "const m = /^#\\s+(.+)$/m.exec(content);",
      "const other = registry.exec(record);",
    ].join("\n")
  );
  assert.deepEqual(findings, []);
});

// Review 2026-09-08 hardening: the shorthand `{ shell }` options form was
// not matched by the shell: pattern.
test("shorthand { shell } option flags", () => {
  const findings = scanSource(
    "fixture.mjs",
    ["const shell = true;", "spawn(command, args, { shell });"].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("unrelated shorthand identifiers do not flag", () => {
  const findings = scanSource(
    "fixture.mjs",
    'spawn(command, args, { cwd, env: pick(["PATH"]) });\n'
  );
  assert.deepEqual(findings, []);
});

// Review 2026-09-08 hardening: an over-long call span was skipped silently;
// now it surfaces as a finding instead of hiding a possible shell: true.
test("call spans beyond MAX_CALL_SPAN_CHARS report as unparseable", () => {
  const padding = "x".repeat(9000);
  const findings = scanSource(
    "fixture.mjs",
    `spawn("cmd", { padding: "${padding}" });\n`
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "unparseable-call-span");
});

// Review 2026-09-08 hardening (#365 pattern): enumeration must use
// git-tracked + visible untracked files, never a plain filesystem walk, so
// gitignored scratch never reaches the scan.
test("listSourceFiles excludes gitignored scratch but keeps visible untracked work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spnssh-gitvisible-"));
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    git(["init", "--quiet"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Subprocess Check Test"]);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "scratch-rig/\n");
    await writeFile(
      path.join(root, "scripts", "tracked.mjs"),
      'import { spawn } from "node:child_process";\nspawn(argv[0], argv.slice(1));\n'
    );
    await writeFile(
      path.join(root, "scripts", "untracked-visible.mjs"),
      'spawn(command, args, { shell: true });\n'
    );
    await mkdir(path.join(root, "scratch-rig"), { recursive: true });
    await writeFile(
      path.join(root, "scratch-rig", "live.mjs"),
      'execSync("ls");\n'
    );
    git(["add", ".gitignore", "scripts/tracked.mjs"]);
    git(["commit", "--quiet", "-m", "base"]);

    const result = await run({ check: {}, repoRoot: root });
    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].path, "scripts/untracked-visible.mjs");
    assert.equal(result.evidence[0].rule, "shell-true-option");
    // gitignored scratch-rig/live.mjs must not appear anywhere in evidence
    assert.ok(!result.evidence.some((item) => item.path.includes("scratch-rig")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Pre-push adversarial review round (2026-09-11) — every finding pinned.
test("property assignment cannot overwrite an import binding (F1)", () => {
  const findings = scanSource(
    "fixture.mjs",
    [
      'import { exec, execFileSync } from "node:child_process";',
      "const adapters = {};",
      "adapters.exec = execFileSync;",
      "exec(userInput);",
    ].join("\n")
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "exec-string-api");
});

test("unprefixed child_process registers renamed imports and receivers (F2)", () => {
  const renamed = scanSource(
    "fixture.mjs",
    'import { exec as run } from "child_process";\nrun(userInput);\n'
  );
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].rule, "exec-string-api");

  const receiver = scanSource(
    "fixture.mjs",
    'const cp = require("child_process");\ncp.exec(userInput);\n'
  );
  assert.equal(receiver.length, 1);
  assert.equal(receiver[0].rule, "exec-string-api");
});

test("quote-bearing regex after an operator does not hide a same-line violation (F3)", () => {
  const findings = scanSource(
    "fixture.mjs",
    'const parts = a + /["\']/g.test(s); spawn(cmd, { shell: true });\n'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");

  // ++/-- stay division contexts
  assert.deepEqual(
    scanSource("fixture.mjs", "i++; const r = total / count; spawn(f, a);\n"),
    []
  );
});

test("computed quoted key flags (F4)", () => {
  const findings = scanSource("fixture.mjs", 'spawn(cmd, args, { ["shell"]: true });\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shell-true-option");
});

test("mixed default+named import and await import() renames register (F6)", () => {
  const mixed = scanSource(
    "fixture.mjs",
    'import cp, { exec } from "node:child_process";\ncp.exec(cmd);\n'
  );
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].rule, "exec-string-api");

  const dynamic = scanSource(
    "fixture.mjs",
    'const { exec: run } = await import("node:child_process");\nrun(cmd);\n'
  );
  assert.equal(dynamic.length, 1);
  assert.equal(dynamic[0].rule, "exec-string-api");
});

test("comment-shaped provenance registers nothing (self-scan catch)", () => {
  assert.deepEqual(
    scanSource(
      "fixture.mjs",
      '// const { exec: run } = await import("child_process");\nrun(cmd, args);\n'
    ),
    []
  );
});

test("surfaces scoped to zero files fails loudly; leading ./ is stripped (F7)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spnssh-zero-"));
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "scripts", "a.mjs"), "spawn(f, a);\n");
    const typo = await run({ check: { surfaces: ["./docs"] }, repoRoot: root });
    assert.equal(typo.status, "fail");
    assert.match(typo.summary, /matched no source files/);

    const stripped = await run({ check: { surfaces: ["./scripts"] }, repoRoot: root });
    assert.equal(stripped.status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
