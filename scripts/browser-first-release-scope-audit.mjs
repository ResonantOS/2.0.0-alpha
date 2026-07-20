#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/dev";
const DEFAULT_HEAD = "HEAD";

const canonicalRootFiles = new Set([
  ".gitignore",
  ".nvmrc",
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "INSTALL.md",
  "SUPPORT.md",
]);

const includeDocs = new Set([
  "docs/README.md",
  "docs/STATUS.md",
  "docs/ROADMAP.md",
  "docs/PROJECT_GOVERNANCE.md",
  "docs/architecture/README.md",
  "docs/architecture/ALPHA_RUNTIME_BOUNDARY.md",
  "docs/architecture/MODULE_MAP.md",
  "docs/architecture/MODULE-OWNERSHIP.md",
  "docs/product/PRODUCT_GUIDE.md",
  "docs/reference/CAPABILITY_MATRIX.md",
  "docs/reference/COMMANDS.md",
  "docs/release/ALPHA_DISTRIBUTION.md",
  "docs/architecture/addon-skills/living-archive/SOURCE_TO_WIKI_INTAKE.md",
  "docs/browser-first-bridge-setup-runbook.md",
  "docs/augmentor-future-list-acceptance-matrix.md",
  "docs/augmentor-tester-runbook.md",
]);

function readOptionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a ref value`);
  }
  return value;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    base: env.RESONANTOS_SCOPE_BASE || DEFAULT_BASE,
    head: env.RESONANTOS_SCOPE_HEAD || DEFAULT_HEAD,
    includePathsOnly: false,
    mode: "worktree",
    nullSeparated: false,
    strict: false,
  };
  let rangeConfigured = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") {
      options.strict = true;
    } else if (argument === "--staged") {
      if (options.mode === "committed") {
        throw new Error("--staged cannot be combined with --committed");
      }
      options.mode = "staged";
    } else if (argument === "--committed") {
      if (options.mode === "staged") {
        throw new Error("--committed cannot be combined with --staged");
      }
      options.mode = "committed";
    } else if (argument === "--include-paths") {
      options.includePathsOnly = true;
    } else if (argument === "--null") {
      options.nullSeparated = true;
    } else if (argument === "--base") {
      options.base = readOptionValue(argv, index, "--base");
      rangeConfigured = true;
      index += 1;
    } else if (argument.startsWith("--base=")) {
      options.base = argument.slice("--base=".length);
      if (!options.base) throw new Error("--base requires a ref value");
      rangeConfigured = true;
    } else if (argument === "--head") {
      options.head = readOptionValue(argv, index, "--head");
      rangeConfigured = true;
      index += 1;
    } else if (argument.startsWith("--head=")) {
      options.head = argument.slice("--head=".length);
      if (!options.head) throw new Error("--head requires a ref value");
      rangeConfigured = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (rangeConfigured && options.mode !== "committed") {
    throw new Error("--base and --head require --committed");
  }
  return options;
}

export function createGitRunner({
  cwd = REPO_ROOT,
  execFileSyncImpl = execFileSync,
} = {}) {
  return (args) => execFileSyncImpl("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
}

function splitGitPaths(value) {
  return String(value).split("\0").filter(Boolean);
}

function committedState(status) {
  switch (status[0]) {
    case "A": return "added";
    case "C": return "copied";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "T": return "type-changed";
    case "U": return "unmerged";
    default: return "unknown";
  }
}

function parseGitNameStatus(value) {
  const tokens = String(value).split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const entries = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index];
    index += 1;
    if (!status) throw new Error("Git returned an empty committed change status");

    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = tokens[index];
      const changedPath = tokens[index + 1];
      if (!previousPath || !changedPath) {
        throw new Error(`Git returned an incomplete ${status} committed path record`);
      }
      entries.push({
        path: changedPath,
        previousPath,
        state: committedState(status),
      });
      index += 2;
      continue;
    }

    const changedPath = tokens[index];
    if (!changedPath) {
      throw new Error(`Git returned an incomplete ${status} committed path record`);
    }
    entries.push({ path: changedPath, state: committedState(status) });
    index += 1;
  }
  return entries;
}

function resolveCommit(runGit, label, ref) {
  try {
    const commit = String(runGit([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ])).trim();
    if (commit) return commit;
  } catch {
    // The public error below avoids leaking Git internals while naming the bad ref.
  }
  throw new Error(`Committed range ${label} is unavailable: ${ref}. Fetch it or pass --${label} <ref>.`);
}

export function collectChangedPaths(options, runGit) {
  if (options.mode === "staged") {
    return parseGitNameStatus(runGit([
      "diff",
      "--cached",
      "--name-status",
      "--no-renames",
      "-z",
      "--",
    ]));
  }

  if (options.mode === "committed") {
    const baseCommit = resolveCommit(runGit, "base", options.base);
    const headCommit = resolveCommit(runGit, "head", options.head);
    const range = `${baseCommit}...${headCommit}`;
    return parseGitNameStatus(runGit([
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      range,
      "--",
    ]));
  }

  return [
    ...splitGitPaths(runGit(["diff", "--name-only", "-z", "--"]))
      .map((changedPath) => ({ path: changedPath, state: "modified" })),
    ...splitGitPaths(runGit(["ls-files", "--others", "--exclude-standard", "-z", "--"]))
      .map((changedPath) => ({ path: changedPath, state: "untracked" })),
  ];
}

function classify(changedPath, state) {
  if (changedPath.startsWith("browser-first/")) {
    return {
      bucket: "include",
      reason: "Chrome extension, Node bridge host, or browser-first tests/docs",
    };
  }
  if (changedPath.startsWith("development/")) {
    return {
      bucket: "defer",
      reason: "Arcanum or local run package; keep out of product PRs unless explicitly promoted",
    };
  }
  if (changedPath.startsWith("disciplines/")) {
    return {
      bucket: "include",
      reason: "local ResonantOS governance discipline",
    };
  }
  if (includeDocs.has(changedPath)) {
    return {
      bucket: "include",
      reason: "browser-first release documentation",
    };
  }
  if (canonicalRootFiles.has(changedPath) || changedPath === "public/icons/README.md") {
    return {
      bucket: "include",
      reason: "canonical browser-first governance or release documentation",
    };
  }
  if (/^docs\/architecture\/ADR-\d{3}[^/]*\.md$/.test(changedPath)) {
    return {
      bucket: "include",
      reason: "architecture decision record metadata",
    };
  }
  if (changedPath.startsWith("addons/resonant-browser-host/")) {
    return {
      bucket: "include",
      reason: "pure Node browser host support package",
    };
  }
  if (
    changedPath.startsWith("src/") ||
    changedPath.startsWith("public/addons/") ||
    changedPath.startsWith("scripts/") ||
    changedPath.startsWith(".github/")
  ) {
    return {
      bucket: "include",
      reason: "shared alpha code, addon registry, release script, or CI",
    };
  }
  if (
    changedPath === "package.json" ||
    changedPath === "package-lock.json" ||
    changedPath === "README.md" ||
    changedPath === "SECURITY.md" ||
    changedPath === "LICENSE.txt" ||
    changedPath === "run-bridge-minimal.mjs" ||
    changedPath === "vite.config.ts"
  ) {
    return {
      bucket: "include",
      reason: "alpha package metadata or release-facing documentation",
    };
  }
  if (/^(AUDIT-.*\.md|SECURITY-RED-TEAM-REPORT\.md)$/.test(changedPath)) {
    return {
      bucket: "include",
      reason: "internal audit artifact removed from the public alpha surface",
    };
  }
  if (
    changedPath.startsWith("electron-host/") ||
    changedPath.startsWith("src-tauri/") ||
    changedPath.startsWith("addons/resonant-browser-native/") ||
    changedPath.startsWith("build/native-browser/") ||
    changedPath === "rust-toolchain.toml"
  ) {
    return {
      bucket: "include",
      reason: "desktop/native host removal required for the Chrome extension alpha",
    };
  }
  if (changedPath.startsWith("public/icons/custom/audio2tol") || changedPath === "public/icons/icon-preview.html") {
    return {
      bucket: "include",
      reason: "alpha icon catalog cleanup for removed workspaces",
    };
  }
  if (changedPath.startsWith("examples/living-archive-")) {
    return {
      bucket: "defer",
      reason: "Living Archive MCP/example bridge scope needs separate release decision",
    };
  }
  if (
    state === "deleted" &&
    (changedPath.startsWith("docs/") || /^[^/]+\.md$/i.test(changedPath))
  ) {
    return {
      bucket: "include",
      reason: "deleted documentation cleanup from the browser-first release surface",
    };
  }
  if (changedPath.startsWith("docs/")) {
    return {
      bucket: "review",
      reason: "documentation changed outside the approved browser-first docs list",
    };
  }
  return {
    bucket: "review",
    reason: "path is outside known browser-first release scope",
  };
}

function modeLabel(options) {
  if (options.mode === "staged") return "staged index";
  if (options.mode === "committed") return `committed range ${options.base}...${options.head}`;
  return "worktree";
}

function writeLine(stream, line = "") {
  stream.write(`${line}\n`);
}

export function main({
  argv = process.argv.slice(2),
  gitRunner = createGitRunner(),
  processRef = process,
  repoRoot = REPO_ROOT,
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) {
  let options;
  let changedPaths;
  try {
    options = parseArgs(argv);
    changedPaths = collectChangedPaths(options, gitRunner);
  } catch (error) {
    writeLine(stderr, `Browser-first release scope audit failed: ${error.message}`);
    processRef.exitCode = 2;
    return 2;
  }

  const groups = new Map([
    ["include", []],
    ["defer", []],
    ["review", []],
  ]);
  for (const entry of changedPaths) {
    const decision = classify(entry.path, entry.state);
    groups.get(decision.bucket).push({ ...entry, ...decision });
  }

  if (options.includePathsOnly) {
    const paths = groups.get("include").map((entry) => entry.path);
    stdout.write(options.nullSeparated
      ? `${paths.join("\0")}${paths.length ? "\0" : ""}`
      : `${paths.join("\n")}${paths.length ? "\n" : ""}`);
    return 0;
  }

  const printGroup = (label, rows) => {
    writeLine(stdout);
    writeLine(stdout, `${label}: ${rows.length}`);
    for (const row of rows) {
      writeLine(stdout, `- ${row.state.padEnd(9)} ${row.path} :: ${row.reason}`);
    }
  };

  writeLine(stdout, "Browser-first release scope audit");
  writeLine(stdout, `Mode: ${modeLabel(options)}`);
  writeLine(stdout, `Changed paths: ${changedPaths.length}`);
  printGroup("Include with browser-first", groups.get("include"));
  printGroup("Defer to separate commit/release", groups.get("defer"));
  printGroup("Needs manual review", groups.get("review"));

  const missing = [...includeDocs]
    .filter((expectedPath) => !existsSync(path.join(repoRoot, expectedPath)));
  if (missing.length > 0) {
    writeLine(stdout, "\nMissing expected release-scope files:");
    for (const missingPath of missing) writeLine(stdout, `- ${missingPath}`);
  }

  const largeIncluded = groups.get("include")
    .map((entry) => ({ ...entry, absolute: path.join(repoRoot, entry.path) }))
    .filter((entry) => existsSync(entry.absolute) && statSync(entry.absolute).isFile())
    .map((entry) => ({ ...entry, size: statSync(entry.absolute).size }))
    .filter((entry) => entry.size > 1_000_000);
  if (largeIncluded.length > 0) {
    writeLine(stdout, "\nLarge included files require review:");
    for (const entry of largeIncluded) {
      writeLine(stdout, `- ${entry.path} (${entry.size} bytes)`);
    }
  }

  const hasBlockingScope = groups.get("review").length > 0 ||
    groups.get("defer").length > 0 ||
    missing.length > 0 ||
    largeIncluded.length > 0;

  if (options.strict && hasBlockingScope) {
    writeLine(stderr, "\nStrict mode failed: deferred/review/missing/large paths are present. Split or re-scope changes before release.");
    processRef.exitCode = 1;
    return 1;
  }
  if (hasBlockingScope) {
    writeLine(stdout, "\nNon-strict audit complete: deferred or review paths exist. Do not push a mixed release without splitting or documenting them.");
  }
  return 0;
}

export function isDirectExecution(moduleUrl, argvEntry) {
  return Boolean(
    argvEntry && pathToFileURL(path.resolve(argvEntry)).href === moduleUrl,
  );
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main();
}
