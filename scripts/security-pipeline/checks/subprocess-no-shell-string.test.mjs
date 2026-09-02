import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCallSpanEnd,
  firstArgumentText,
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

test("unbalanced call span is skipped without throwing", () => {
  assert.equal(findCallSpanEnd("spawn(\"a\", { shell: true }", 5), -1);
  const text = "spawn(process.execPath, files)";
  assert.equal(findCallSpanEnd(text, 5), text.length - 1);
  assert.equal(firstArgumentText(text, 5, text.length - 1), "process.execPath");
});
