import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSandboxProfile,
  diffTrees,
  ensureRealpath,
  parseSandboxDenialLines,
  readDenyRootsFor,
  realpathExisting,
  resolveDelegationIsolation,
  snapshotTree,
  wrapCommandForIsolation,
  writableRootsFor,
} from "../host/delegation-isolation.mjs";

const providerSecretsPath = () => path.join(os.homedir(), "ResonantOS_User", "Secrets", "provider-secrets.json");

test("buildSandboxProfile emits the exact ordered write deny and read deny forms", () => {
  const profile = buildSandboxProfile({
    writableRoots: ["/private/tmp/work", "/private/tmp/work", "/private/var/folders/t"],
    readDenyRoots: ["/Users/example/.ssh", "/Users/example/.ssh"],
    readDenyFiles: ["/repo/browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js"],
  });

  assert.equal(profile, [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (subpath "/private/tmp/work") (subpath "/private/var/folders/t"))',
    '(deny file-read* (subpath "/Users/example/.ssh") (literal "/repo/browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js"))',
    "",
  ].join("\n"));
  assert.ok(profile.indexOf("(deny file-write*)") < profile.indexOf("(allow file-write*"));
  assert.doesNotMatch(profile, /\(subpath "\/dev"\)/);
});

test("buildSandboxProfile rejects relative paths and sandbox syntax metacharacters", () => {
  for (const bad of [
    "relative/path",
    "/tmp/quote\"path",
    "/tmp/back\\slash",
    "/tmp/open(paren",
    "/tmp/close)paren",
    "/tmp/semi;colon",
    "/tmp/new\nline",
    "/tmp/control\u0001path",
    "/tmp/delete\u007fpath",
  ]) {
    assert.throws(
      () => buildSandboxProfile({ writableRoots: [bad], readDenyRoots: [], readDenyFiles: [] }),
      /Sandbox profile path must be absolute and contain no SBPL metacharacters/,
      bad,
    );
  }
});

test("ensureRealpath creates missing directories and realpathExisting drops missing paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-isolation-pure-"));
  try {
    const missing = path.join(root, "missing", "state");
    const ensured = await ensureRealpath(missing);
    assert.equal(ensured, await realpath(missing));

    const present = path.join(root, "present");
    const absent = path.join(root, "absent");
    await mkdir(present);
    assert.deepEqual(await realpathExisting([present, absent]), [await realpath(present)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveDelegationIsolation follows override, platform, and executable matrix", async () => {
  const executable = async () => true;
  const missing = async () => false;

  assert.deepEqual(await resolveDelegationIsolation({ platform: "darwin", override: " contract-only ", isExecutable: missing }), {
    mode: "contract-only",
    reason: "operator-override",
  });
  assert.deepEqual(await resolveDelegationIsolation({ platform: "linux", override: "CONTRACT-ONLY", isExecutable: executable }), {
    mode: "contract-only",
    reason: "operator-override",
  });
  await assert.rejects(
    () => resolveDelegationIsolation({ platform: "darwin", override: "sandbox", isExecutable: executable }),
    /Unknown RESONANTOS_DELEGATION_ISOLATION value "sandbox"; the only supported value is "contract-only"\./,
  );
  assert.deepEqual(await resolveDelegationIsolation({ platform: "darwin", sandboxExecPath: "/usr/bin/sandbox-exec", isExecutable: executable }), {
    mode: "sandbox-exec",
    reason: "darwin-sandbox-exec",
  });
  await assert.rejects(
    () => resolveDelegationIsolation({ platform: "darwin", sandboxExecPath: "/missing/sandbox-exec", isExecutable: missing }),
    /Delegation isolation unavailable: \/missing\/sandbox-exec is not executable\. Set RESONANTOS_DELEGATION_ISOLATION=contract-only to run delegations unconfined \(this is recorded in the governance audit\)\./,
  );
  assert.deepEqual(await resolveDelegationIsolation({ platform: "linux", isExecutable: missing }), {
    mode: "contract-only",
    reason: "no-os-primitive:linux",
  });
  assert.deepEqual(await resolveDelegationIsolation({ platform: "win32", isExecutable: missing }), {
    mode: "contract-only",
    reason: "no-os-primitive:win32",
  });
});

test("wrapCommandForIsolation wraps only sandbox-exec mode", () => {
  assert.deepEqual(wrapCommandForIsolation({
    mode: "sandbox-exec",
    sandboxExecPath: "/usr/bin/sandbox-exec",
    profilePath: "/tmp/profile.sb",
    command: "/bin/echo",
    args: ["hello"],
  }), {
    command: "/usr/bin/sandbox-exec",
    args: ["-f", "/tmp/profile.sb", "/bin/echo", "hello"],
  });
  assert.deepEqual(wrapCommandForIsolation({
    mode: "contract-only",
    sandboxExecPath: "/usr/bin/sandbox-exec",
    profilePath: "/tmp/profile.sb",
    command: "/bin/echo",
    args: ["hello"],
  }), {
    command: "/bin/echo",
    args: ["hello"],
  });
});

test("writableRootsFor captures OpenCode child-visible workspace, temp, XDG, and env roots", () => {
  const roots = writableRootsFor("opencode", {
    env: {
      HOME: "/Users/example",
      TMPDIR: "/var/folders/example/T",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
      XDG_CONFIG_HOME: "/xdg/config",
      OPENCODE_DATA: "/override/data",
      OPENCODE_CACHE: "/override/cache",
      OPENCODE_CONFIG: "/override/config",
    },
    pathExists: (candidate) => candidate === "/Users/example/.opencode",
    promptTempDir: "/tmp/opencode-prompt",
    tmpdir: "/fallback/tmp",
    workspacePath: "/repo/workspace",
  });

  assert.deepEqual(roots, [
    "/repo/workspace",
    "/tmp/opencode-prompt",
    "/var/folders/example/T",
    "/tmp",
    "/xdg/data/opencode",
    "/xdg/cache/opencode",
    "/xdg/config/opencode",
    "/Users/example/.local/state/opencode",
    "/override/data",
    "/override/cache",
    "/override/config",
    "/Users/example/.opencode",
  ]);
});

test("writableRootsFor captures Hermes profile, result temp, tmp, and narrowed cache roots", () => {
  assert.deepEqual(writableRootsFor("hermes", {
    env: {
      HOME: "/Users/example",
      TMPDIR: "/var/folders/example/T",
      XDG_CACHE_HOME: "/xdg/cache",
    },
    profileHome: "/Users/example/.hermes",
    tempDir: "/tmp/hermes-prompt",
    tmpdir: "/fallback/tmp",
  }), [
    "/Users/example/.hermes",
    "/tmp/hermes-prompt",
    "/var/folders/example/T",
    "/tmp",
    "/xdg/cache/pip",
    "/xdg/cache/hermes",
  ]);
});

test("readDenyRootsFor includes provider secret stores and generated bridge config literal", () => {
  const { roots, files } = readDenyRootsFor({
    env: { HOME: "/Users/example" },
    repoRoot: "/repo",
    userRoot: "/custom/ResonantOS_User",
  });

  assert.ok(roots.includes("/Users/example/.ssh"));
  assert.ok(roots.includes(path.dirname(providerSecretsPath())));
  assert.ok(roots.includes("/custom/ResonantOS_User/Secrets"));
  assert.ok(files.includes("/repo/browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js"));
});

test("snapshotTree and diffTrees report bounded changes and skip ignored directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-isolation-snapshot-"));
  try {
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "keep.txt"), "one");
    await writeFile(path.join(root, "remove.txt"), "gone");
    await writeFile(path.join(root, "node_modules", "skip.txt"), "ignored");
    const before = await snapshotTree(root);

    await writeFile(path.join(root, "keep.txt"), "two");
    await writeFile(path.join(root, "add.txt"), "new");
    await rm(path.join(root, "remove.txt"));
    const after = await snapshotTree(root);
    const diff = diffTrees(before, after);

    assert.equal(diff.added, 1);
    assert.equal(diff.modified, 1);
    assert.equal(diff.removed, 1);
    assert.deepEqual(diff.sample.added, ["add.txt"]);
    assert.deepEqual(diff.sample.modified, ["keep.txt"]);
    assert.deepEqual(diff.sample.removed, ["remove.txt"]);
    assert.equal(before.truncated, false);

    const truncated = await snapshotTree(root, { maxEntries: 1 });
    assert.equal(truncated.truncated, true);
    assert.equal([...truncated.entries.keys()].includes("node_modules/skip.txt"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseSandboxDenialLines extracts matching process denials only", () => {
  const parsed = parseSandboxDenialLines([
    "2026-09-07 12:00:00 Sandbox: bash(79128) deny(1) file-write-create /private/tmp/outside.txt",
    "2026-09-07 12:00:01 Sandbox: node(79129) deny(1) file-read-data /Users/example/.ssh/id_ed25519",
    "2026-09-07 12:00:02 Sandbox: zsh(79130) deny(1) file-write-create /tmp/not-matching",
    "malformed Sandbox: bash deny file-write-create /tmp/nope",
  ].join("\n"), ["bash", "node"]);

  assert.deepEqual(parsed, [
    { operation: "file-write-create", path: "/private/tmp/outside.txt" },
    { operation: "file-read-data", path: "/Users/example/.ssh/id_ed25519" },
  ]);
});
