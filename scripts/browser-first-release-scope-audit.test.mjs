import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const auditModule = await import("./browser-first-release-scope-audit.mjs");

function requireExport(name) {
  assert.equal(typeof auditModule[name], "function", `${name} must be exported`);
  return auditModule[name];
}

async function withTempRepository(run) {
  const root = await mkdtemp(join(tmpdir(), "release-scope-audit-"));
  const git = (args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  try {
    git(["init", "--quiet"]);
    git(["config", "user.email", "audit-test@example.invalid"]);
    git(["config", "user.name", "Release Scope Audit Test"]);
    await writeFile(join(root, "README.md"), "base\n");
    git(["add", "README.md"]);
    git(["commit", "--quiet", "-m", "base"]);
    await run({ git, root });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function writeFixture(root, path, content = "fixture\n") {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

test("parses committed ranges with local and CI defaults and configurable refs", () => {
  const parseArgs = requireExport("parseArgs");

  assert.deepEqual(parseArgs(["--committed"], {}), {
    base: "origin/dev",
    head: "HEAD",
    includePathsOnly: false,
    mode: "committed",
    nullSeparated: false,
    strict: false,
  });
  assert.deepEqual(
    parseArgs(["--committed", "--base", "upstream/dev", "--head=topic"]),
    {
      base: "upstream/dev",
      head: "topic",
      includePathsOnly: false,
      mode: "committed",
      nullSeparated: false,
      strict: false,
    },
  );

  assert.deepEqual(
    parseArgs(["--committed"], {
      RESONANTOS_SCOPE_BASE: "base-sha",
      RESONANTOS_SCOPE_HEAD: "head-sha",
    }),
    {
      base: "base-sha",
      head: "head-sha",
      includePathsOnly: false,
      mode: "committed",
      nullSeparated: false,
      strict: false,
    },
  );
  assert.deepEqual(
    parseArgs(
      ["--committed", "--base=cli-base", "--head", "cli-head"],
      {
        RESONANTOS_SCOPE_BASE: "environment-base",
        RESONANTOS_SCOPE_HEAD: "environment-head",
      },
    ),
    {
      base: "cli-base",
      head: "cli-head",
      includePathsOnly: false,
      mode: "committed",
      nullSeparated: false,
      strict: false,
    },
  );
});

test("alpha workflow fetches history and supplies event-specific audit refs", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/alpha-build.yml", import.meta.url),
    "utf8",
  );
  const parsed = parse(workflow);

  assert.match(workflow, /uses: actions\/checkout@[a-f0-9]+[^\n]*\n\s+with:\n\s+fetch-depth: 0/);
  assert.match(
    workflow,
    /RESONANTOS_SCOPE_BASE: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.event_name == 'push' && github\.event\.before \|\| 'origin\/dev' \}\}/,
  );
  assert.match(workflow, /RESONANTOS_SCOPE_HEAD: \$\{\{ github\.sha \}\}/);
  assert.equal(parsed.on.pull_request.paths, undefined);
  assert.equal(parsed.on.push.paths, undefined);
});

test("project sync executes pull-request events only from trusted base code", async () => {
  const workflowText = await readFile(
    new URL("../.github/workflows/project-issue-sync.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(workflowText);
  const job = workflow.jobs.sync;
  const checkout = job.steps.find((step) => step.name === "Checkout");
  const captureSnapshot = job.steps.find((step) => step.name === "Capture Project 2 scope snapshot");
  const syncStep = job.steps.find((step) => step.name === "Sync project and labels");

  assert.equal(workflow.on.pull_request, undefined);
  assert.ok(workflow.on.pull_request_target);
  assert.equal(job.if, undefined);
  assert.equal(
    checkout.with.ref,
    "${{ github.event.repository.default_branch }}",
  );
  assert.doesNotMatch(workflowText, /pull_request\.base\.(?:sha|ref)/);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions.issues, undefined);
  assert.equal(workflow.permissions["pull-requests"], undefined);
  // Token gating: the snapshot step runs only when the token is configured, and
  // the sync steps run only when the snapshot succeeded (snapshot-ok) — so the
  // sync is transitively gated on a working token. A missing/underscoped token
  // warns and skips rather than failing the workflow on every trigger (#260).
  assert.equal(captureSnapshot.if, "steps.project-token.outputs.configured == 'true'");
  assert.equal(syncStep.if, "steps.snapshot.outputs.snapshot-ok == 'true'");
});

test("committed mode preserves added and deleted branch paths in a clean worktree", async () => {
  const collectChangedPaths = requireExport("collectChangedPaths");
  const createGitRunner = requireExport("createGitRunner");
  const parseArgs = requireExport("parseArgs");

  await withTempRepository(async ({ git, root }) => {
    await writeFixture(root, "docs/removed.md");
    git(["add", "docs/removed.md"]);
    git(["commit", "--quiet", "-m", "add documentation to remove"]);
    const base = git(["rev-parse", "HEAD"]);
    await rm(join(root, "docs/removed.md"));
    await writeFixture(root, "docs/branch-change.md");
    git(["add", "--all"]);
    git(["commit", "--quiet", "-m", "branch change"]);

    assert.equal(git(["status", "--porcelain"]), "");
    const changedPaths = collectChangedPaths(
      parseArgs(["--committed", "--base", base, "--head", "HEAD"]),
      createGitRunner({ cwd: root }),
    );

    assert.deepEqual(changedPaths, [
      { path: "docs/branch-change.md", state: "added" },
      { path: "docs/removed.md", state: "deleted" },
    ]);
  });
});

test("fails clearly when the committed range base is unavailable", () => {
  const collectChangedPaths = requireExport("collectChangedPaths");
  const parseArgs = requireExport("parseArgs");
  const options = parseArgs(["--committed", "--base", "missing-base"]);

  assert.throws(
    () => collectChangedPaths(options, () => {
      throw new Error("ambiguous argument with internal git details");
    }),
    /committed range base is unavailable: missing-base/i,
  );
});

test("passes refs as literal Git arguments without invoking a shell", () => {
  const collectChangedPaths = requireExport("collectChangedPaths");
  const createGitRunner = requireExport("createGitRunner");
  const parseArgs = requireExport("parseArgs");
  const maliciousBase = "origin/dev; touch /tmp/release-scope-injection";
  const calls = [];
  const runner = createGitRunner({
    cwd: "/repo",
    execFileSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes(`${maliciousBase}^{commit}`)) return "a".repeat(40);
      if (args.includes("HEAD^{commit}")) return "b".repeat(40);
      return "M\0scripts/safe\nname.mjs\0";
    },
  });

  const changedPaths = collectChangedPaths(
    parseArgs(["--committed", "--base", maliciousBase], {}),
    runner,
  );

  assert.deepEqual(changedPaths, [{ path: "scripts/safe\nname.mjs", state: "modified" }]);
  assert.deepEqual(calls[0].args, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${maliciousBase}^{commit}`,
  ]);
  assert.deepEqual(calls[2].args, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    `${"a".repeat(40)}...${"b".repeat(40)}`,
    "--",
  ]);
  assert.ok(calls.every(({ command, options }) => command === "git" && options.shell === false));
});

test("preserves worktree and staged path collection modes", () => {
  const collectChangedPaths = requireExport("collectChangedPaths");
  const parseArgs = requireExport("parseArgs");
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[1] === "--cached") {
      return "M\0scripts/staged.mjs\0D\0docs/retired-slide.png\0";
    }
    if (args[0] === "diff") return "scripts/modified.mjs\0";
    return "scripts/untracked.mjs\0";
  };

  assert.deepEqual(collectChangedPaths(parseArgs([]), runner), [
    { path: "scripts/modified.mjs", state: "modified" },
    { path: "scripts/untracked.mjs", state: "untracked" },
  ]);
  assert.deepEqual(collectChangedPaths(parseArgs(["--staged"]), runner), [
    { path: "scripts/staged.mjs", state: "modified" },
    { path: "docs/retired-slide.png", state: "deleted" },
  ]);
  assert.deepEqual(calls, [
    ["diff", "--name-only", "-z", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    ["diff", "--cached", "--name-status", "--no-renames", "-z", "--"],
  ]);
});

test("preserves include-path filtering and NUL-separated output", () => {
  const main = requireExport("main");
  let stdout = "";
  let stderr = "";
  const processRef = { exitCode: undefined };

  const result = main({
    argv: ["--include-paths", "--null"],
    gitRunner: (args) => {
      if (args[0] === "diff") return "scripts/included.mjs\0docs/unapproved.md\0";
      return "";
    },
    processRef,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  });

  assert.equal(result, 0);
  assert.equal(processRef.exitCode, undefined);
  assert.equal(stdout, "scripts/included.mjs\0");
  assert.equal(stderr, "");
});

test("unknown modified documentation still fails strict committed audit", () => {
  const main = requireExport("main");
  let stderr = "";
  const processRef = { exitCode: undefined };
  const hashes = ["a".repeat(40), "b".repeat(40)];

  const result = main({
    argv: ["--committed", "--strict"],
    gitRunner: (args) => args[0] === "rev-parse"
      ? `${hashes.shift()}\n`
      : "M\0docs/unapproved.md\0",
    processRef,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: () => {} },
  });

  assert.equal(result, 1);
  assert.equal(processRef.exitCode, 1);
  assert.match(stderr, /strict mode failed/i);
});

test("known canonical, ADR, icon, and deleted documentation pass strict audit", () => {
  const main = requireExport("main");
  let stdout = "";
  let stderr = "";
  const processRef = { exitCode: undefined };
  const hashes = ["a".repeat(40), "b".repeat(40)];
  const canonicalPaths = [
    ".gitignore",
    ".nvmrc",
    "AGENTS.md",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "INSTALL.md",
    "SUPPORT.md",
    "docs/architecture/ADR-999-release-metadata.md",
    "docs/reference/COMMANDS.md",
    "public/icons/README.md",
  ];
  const nameStatus = [
    ...canonicalPaths.flatMap((path) => ["M", path]),
    "D",
    "docs/retired/legacy-release-notes.html",
    "D",
    "CODEBASE-EVALUATION-OLD.md",
    "",
  ].join("\0");

  const result = main({
    argv: ["--committed", "--strict"],
    gitRunner: (args) => args[0] === "rev-parse"
      ? `${hashes.shift()}\n`
      : nameStatus,
    processRef,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  });

  assert.equal(result, 0);
  assert.equal(processRef.exitCode, undefined);
  assert.equal(stderr, "");
  assert.match(stdout, /Needs manual review: 0/);
  assert.match(stdout, /deleted\s+docs\/retired\/legacy-release-notes\.html/);
  assert.match(stdout, /deleted\s+CODEBASE-EVALUATION-OLD\.md/);
});
