import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import { opencodeRuntimeDiagnostics } from "../host/opencode-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const lanePath = path.join(repoRoot, "browser-first", "test", "live-sdk-lane.mjs");
const bridgePath = path.join(repoRoot, "browser-first", "host", "run-bridge-minimal.mjs");
const checkoutConfigPath = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension", "src", "bridge-config.generated.js");

// Prerequisites per fault: the three OpenCode faults need the pinned binary in a trusted root; the status-card fault
// needs a Chrome the harness can launch. Where a prerequisite is missing the self-test SKIPS with the reason (the
// live-sdk CI job runs these with both present); it never reports a pass it did not earn.
function chromeAvailable() {
  const override = process.env.RESONANTOS_LIVE_CHROME_PATH;
  if (override) return existsSync(override);
  try { return existsSync(chromium.executablePath()); } catch { return false; }
}
function opencodeAvailable() {
  try { return Boolean(opencodeRuntimeDiagnostics({ env: process.env }).command); } catch { return false; }
}
const faultPrerequisites = {
  "opencode-credential-server": () => (opencodeAvailable() ? null : "pinned opencode binary not found in a trusted root"),
  "execution-settings-gate": () => (opencodeAvailable() ? null : "pinned opencode binary not found in a trusted root"),
  "opencode-version-pin": () => (opencodeAvailable() ? null : "pinned opencode binary not found in a trusted root"),
  "extension-status-cards": () => (chromeAvailable() ? null : "no launchable Chrome (set RESONANTOS_LIVE_CHROME_PATH or install Playwright Chromium)"),
};

const faultScenarios = [
  "opencode-credential-server",
  "execution-settings-gate",
  "opencode-version-pin",
  "extension-status-cards",
];

function runLaneFault(scenarioId, artifactDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [lanePath, `--expect-fail=${scenarioId}`],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "1",
          RESONANTOS_LIVE_ARTIFACT_DIR: artifactDir,
          RESONANTOS_LIVE_SDK_FAULT: scenarioId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${scenarioId} fault run timed out.\n${stdout}\n${stderr}`));
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function fileFingerprint(filePath) {
  try {
    const [metadata, content] = await Promise.all([stat(filePath), readFile(filePath)]);
    return {
      exists: true,
      mtimeMs: metadata.mtimeMs,
      hash: createHash("sha256").update(content).digest("hex"),
      content,
    };
  } catch {
    return { exists: false, mtimeMs: null, hash: null, content: null };
  }
}

async function restoreFile(filePath, fingerprint) {
  if (fingerprint.exists) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fingerprint.content);
  } else {
    await rm(filePath, { force: true });
  }
}

function waitForBridgeStarted(child, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bridge_started did not appear within ${timeoutMs}ms.\n${stdout}\n${stderr}`));
    }, timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (/"browser\.first\.bridge_started"/.test(stdout)) finish({ stdout, stderr });
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (/"browser\.first\.bridge_started"/.test(stdout)) return;
      clearTimeout(timer);
      reject(new Error(`bridge exited before bridge_started code=${code ?? "null"} signal=${signal ?? "null"}.\n${stdout}\n${stderr}`));
    });
  });
}

for (const scenarioId of faultScenarios) {
  test(`live SDK lane detects injected ${scenarioId} fault`, { concurrency: false }, async (t) => {
    const missing = faultPrerequisites[scenarioId]?.();
    if (missing) {
      t.skip(`prerequisite missing on this runner: ${missing}`);
      return;
    }
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), `resonantos-live-sdk-${scenarioId}-`));
    try {
      const result = await runLaneFault(scenarioId, artifactDir);
      const payload = JSON.parse(await readFile(path.join(artifactDir, "scenario-matrix.json"), "utf8"));
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}\n${JSON.stringify(payload, null, 2)}`);
      const scenario = payload.scenarios.find((entry) => entry.id === scenarioId);
      assert.equal(payload.certification, "resonantos-live-sdk");
      assert.equal(scenario?.status, "passed", JSON.stringify(payload.scenarios, null, 2));
      assert.match(scenario.detail, /Expected failure observed/i);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });
}

test("run-bridge-minimal honors RESONANTOS_EXTENSION_ROOT without writing checkout bridge config", { concurrency: false }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-extension-root-test-"));
  const tempExtension = path.join(tempRoot, "extension");
  const tempUserRoot = path.join(tempRoot, "user");
  const before = await fileFingerprint(checkoutConfigPath);
  let child = null;
  try {
    await mkdir(path.join(tempExtension, "src"), { recursive: true });
    await writeFile(path.join(tempExtension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Temp ResonantOS", version: "0.0.0" }));
    child = spawn(process.execPath, [bridgePath, "--bridge-port=0"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RESONANTOS_BROWSER_FIRST_USER_ROOT: tempUserRoot,
        RESONANTOS_EXTENSION_ROOT: tempExtension,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = await waitForBridgeStarted(child).catch((error) => {
      if (/EPERM|EACCES|operation not permitted/i.test(error.message)) {
        t.skip(`loopback listen is denied by this sandbox: ${error.message.split("\n")[0]}`);
        return null;
      }
      throw error;
    });
    if (!started) return;
    const tempConfigPath = path.join(tempExtension, "src", "bridge-config.generated.js");
    assert.equal(existsSync(tempConfigPath), true, "bridge config must be written under RESONANTOS_EXTENSION_ROOT");
    const after = await fileFingerprint(checkoutConfigPath);
    assert.equal(after.exists, before.exists, "checkout bridge config existence changed");
    assert.equal(after.hash, before.hash, "checkout bridge config content changed");
    assert.equal(after.mtimeMs, before.mtimeMs, "checkout bridge config mtime changed");
    // The bridge logs the realpath-resolved root (macOS: /var/folders → /private/var/folders).
    const loggedRoot = realpathSync.native(tempExtension);
    assert.match(started.stdout, new RegExp(JSON.stringify(loggedRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await restoreFile(checkoutConfigPath, before);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
