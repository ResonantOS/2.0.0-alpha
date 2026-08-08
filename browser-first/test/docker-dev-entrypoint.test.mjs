import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const entrypoint = path.join(repoRoot, "scripts", "docker-dev-entrypoint.sh");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("docker dev entrypoint stages working files without local secrets or browser state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resonantos-docker-entrypoint-"));
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  await mkdir(source, { recursive: true });
  const fixtureEnvironment = { ...process.env };
  delete fixtureEnvironment.GIT_DIR;
  delete fixtureEnvironment.GIT_WORK_TREE;

  try {
    assert.equal((await run("git", ["init", "--quiet"], { cwd: source, env: fixtureEnvironment })).code, 0);
    await writeFile(path.join(source, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(source, "deleted.txt"), "deleted working-tree file\n");
    await writeFile(path.join(source, "tracked.txt"), "initial\n");
    assert.equal((await run("git", ["add", ".gitignore", "deleted.txt", "tracked.txt"], { cwd: source, env: fixtureEnvironment })).code, 0);
    await unlink(path.join(source, "deleted.txt"));
    await writeFile(path.join(source, "tracked.txt"), "modified\n");
    await writeFile(path.join(source, "new-source.txt"), "untracked source\n");
    await writeFile(path.join(source, "ignored.log"), "ignored\n");

    const rejectedFiles = [
      [".env.local", "secret"],
      ["ResonantOS_User/Secrets/provider.key", "private"],
      [".codex/state.json", "agent state"],
      ["profile/Cookies", "browser cookies"],
      ["artifacts/report.json", "evidence"],
      ["browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js", "bridge token"],
    ];
    for (const [relativePath, contents] of rejectedFiles) {
      const target = path.join(source, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }

    await chmod(entrypoint, 0o755);
    const result = await run(entrypoint, [
      process.execPath,
      "-e",
      "const fs = require('node:fs'); const cp = require('node:child_process'); fs.writeFileSync('command-output.txt', `${process.cwd()}\\n${cp.execFileSync('git', ['ls-files'], { encoding: 'utf8' })}`)",
    ], {
      env: {
        ...fixtureEnvironment,
        RESONANTOS_DEV_SOURCE_DIR: source,
        RESONANTOS_DEV_WORKSPACE_DIR: workspace,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(workspace, "tracked.txt"), "utf8"), "modified\n");
    assert.equal(await readFile(path.join(workspace, "new-source.txt"), "utf8"), "untracked source\n");
    const commandOutput = await readFile(path.join(workspace, "command-output.txt"), "utf8");
    assert.match(commandOutput, new RegExp(`^${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(commandOutput, /tracked\.txt/);
    assert.equal(
      await readFile(path.join(workspace, ".git"), "utf8"),
      `gitdir: ${path.join(source, ".git")}\n`,
    );

    for (const [relativePath] of rejectedFiles) {
      await assert.rejects(readFile(path.join(workspace, relativePath)));
    }
    await assert.rejects(readFile(path.join(workspace, "ignored.log")));
    await assert.rejects(readFile(path.join(workspace, "deleted.txt")));
    await assert.rejects(readFile(path.join(workspace, ".git", "config")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docker dev entrypoint rejects symbolic links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resonantos-docker-entrypoint-link-"));
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const fixtureEnvironment = { ...process.env };
  delete fixtureEnvironment.GIT_DIR;
  delete fixtureEnvironment.GIT_WORK_TREE;
  await mkdir(source, { recursive: true });

  try {
    assert.equal((await run("git", ["init", "--quiet"], { cwd: source, env: fixtureEnvironment })).code, 0);
    await writeFile(path.join(root, "outside.txt"), "outside state\n");
    await symlink(path.join(root, "outside.txt"), path.join(source, "source-link.txt"));

    const result = await run(entrypoint, ["true"], {
      env: {
        ...fixtureEnvironment,
        RESONANTOS_DEV_SOURCE_DIR: source,
        RESONANTOS_DEV_WORKSPACE_DIR: workspace,
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /rejected symbolic link: source-link\.txt/);
    await assert.rejects(readFile(path.join(workspace, "source-link.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
