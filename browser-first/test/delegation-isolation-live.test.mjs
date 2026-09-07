import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { buildSandboxProfile, ensureRealpath } from "../host/delegation-isolation.mjs";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ code: null, error, stdout, stderr }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("sandbox-exec confines delegation writes and secret reads on macOS", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("delegation isolation live test skipped: sandbox-exec is macOS-only.");
    return;
  }
  try {
    await access("/usr/bin/sandbox-exec");
  } catch (error) {
    t.skip(`delegation isolation live test skipped: /usr/bin/sandbox-exec unavailable (${error.code ?? error.message}).`);
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "ros-isolation-live-"));
  try {
    const workspace = await ensureRealpath(path.join(root, "workspace"));
    const outside = await ensureRealpath(path.join(root, "outside"));
    const denyRoot = await ensureRealpath(path.join(workspace, "deny"));
    await writeFile(path.join(denyRoot, "secret.txt"), "secret");
    await symlink(outside, path.join(workspace, "outside-link"));
    const profilePath = path.join(root, "profile.sb");
    await writeFile(profilePath, buildSandboxProfile({
      writableRoots: [workspace],
      readDenyRoots: [denyRoot],
      readDenyFiles: [],
    }), { mode: 0o600 });
    const script = `
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
      const workspace = process.argv[1];
      const outside = process.argv[2];
      const denyRoot = process.argv[3];
      function attempt(label, fn) {
        try { fn(); console.log(label + ":OK"); }
        catch (err) { console.log(label + ":" + (err && err.code || err.message)); }
      }
      attempt("insideWrite", () => fs.writeFileSync(workspace + "/inside.txt", "ok"));
      attempt("outsideWrite", () => fs.writeFileSync(outside + "/outside.txt", "no"));
      attempt("devNullWrite", () => fs.writeFileSync("/dev/null", "ok"));
      attempt("denyRead", () => fs.readFileSync(denyRoot + "/secret.txt", "utf8"));
      const child = spawnSync("/bin/sh", ["-c", "echo no > " + JSON.stringify(outside + "/grandchild.txt")], { encoding: "utf8" });
      console.log("grandchildWrite:" + (child.status === 0 ? "OK" : "EPERM"));
      attempt("symlinkWrite", () => fs.writeFileSync(workspace + "/outside-link/symlink.txt", "no"));
    `;
    const result = await run("/usr/bin/sandbox-exec", ["-f", profilePath, process.execPath, "-e", script, workspace, outside, denyRoot]);
    if (result.stderr.includes("sandbox_apply") || result.stderr.includes("Operation not permitted")) {
      t.skip(`delegation isolation live test skipped: nested sandbox-exec unavailable (${result.stderr.trim() || "Operation not permitted"}).`);
      return;
    }
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /insideWrite:OK/);
    assert.match(result.stdout, /outsideWrite:EPERM/);
    assert.match(result.stdout, /devNullWrite:OK/);
    assert.match(result.stdout, /denyRead:EPERM/);
    assert.match(result.stdout, /grandchildWrite:EPERM/);
    assert.match(result.stdout, /symlinkWrite:EPERM/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
