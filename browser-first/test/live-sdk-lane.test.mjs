import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import { opencodeRuntimeDiagnostics } from "../host/opencode-runtime.mjs";
import {
  createRawBridgeLogSink,
  createRevocationWatcher,
  drainEnvelopes,
  envelopeRawText,
  readEnvelope,
} from "./live-sdk-lane.mjs";

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
  "opencode-proxy-capability": () => (opencodeAvailable() ? null : "pinned opencode binary not found in a trusted root"),
  "opencode-proxy-scope": () => (opencodeAvailable() ? null : "pinned opencode binary not found in a trusted root"),
  "opencode-proxy-revocation": () => (opencodeAvailable() ? null : "pinned opencode binary not found in a trusted root"),
  "opencode-proxy-raw-log": () => (opencodeAvailable() ? null : "pinned opencode binary not found in a trusted root"),
  "extension-status-cards": () => (chromeAvailable() ? null : "no launchable Chrome (set RESONANTOS_LIVE_CHROME_PATH or install Playwright Chromium)"),
};

const prerequisiteSkipsForbidden = Boolean(process.env.OPENCODE_COMMAND)
  && (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true");

function skipOrFailPrerequisite(t, skipMessage) {
  if (prerequisiteSkipsForbidden) {
    assert.fail(`prerequisite missing in CI live-sdk certification: ${skipMessage}`);
  }
  t.skip(skipMessage);
}

const faultScenarios = [
  "opencode-credential-server",
  "execution-settings-gate",
  "opencode-version-pin",
  "opencode-proxy-capability",
  "opencode-proxy-scope",
  "opencode-proxy-revocation",
  "opencode-proxy-raw-log",
  "extension-status-cards",
];

const faultExpectedDetail = {
  "opencode-version-pin": /OpenCode version mismatch/i,
  "opencode-proxy-capability": /fault expected the capability-omitted SSE control to be accepted/,
  "opencode-proxy-scope": /required upstream session\.updated events were not observed/,
  "opencode-proxy-revocation": /typed OPENCODE_REVOKED close missing on a live stream/,
  "opencode-proxy-raw-log": /OPENCODE_RAW_LOG_CREDENTIAL_DETECTED/,
  "extension-status-cards": /403 bridge response outside the loopback probe/,
};

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
      skipOrFailPrerequisite(t, `prerequisite missing on this runner: ${missing}`);
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
      if (faultExpectedDetail[scenarioId]) {
        assert.match(scenario.detail, faultExpectedDetail[scenarioId]);
      }
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
        skipOrFailPrerequisite(t, `loopback listen is denied by this sandbox: ${error.message.split("\n")[0]}`);
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

test("SSE reader yields every frame from a batched chunk", async () => {
  const frames = [
    { version: 1, sessionId: "A", source: "governed", event: { type: "bridge.ready", properties: {} } },
    { version: 1, sessionId: "A", source: "governed", event: { type: "bridge.operation", properties: { operation: "rename" } } },
  ];
  const chunk = Buffer.from(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
  let sent = false;
  const reader = {
    async read() {
      if (sent) return { done: true, value: undefined };
      sent = true;
      return { done: false, value: chunk };
    },
  };
  const first = await readEnvelope(reader);
  const second = await readEnvelope(reader);
  assert.deepEqual([first, second], frames);
});

test("raw sink clear empties captured bytes", () => {
  const sink = createRawBridgeLogSink();
  sink.captureBridgeLog("stdout", Buffer.from("hello\n"));
  sink.clear();
  assert.equal(sink.joinRaw(), "");
  assert.equal(sink.getEvidence(), "");
});

test("raw sink retains canary the sanitizer removes", () => {
  const sink = createRawBridgeLogSink();
  const canary = `Basic ${randomBytes(18).toString("base64")}`;
  sink.captureBridgeLog("stdout", Buffer.from(`probe ${canary}\n`));
  assert.deepEqual(
    [sink.joinRaw().includes(canary), sink.getEvidence().includes(canary)],
    [true, false],
  );
});

test("raw log overflow fails certification", () => {
  const sink = createRawBridgeLogSink({ limit: 8 * 1024 * 1024 });
  sink.captureBridgeLog("stdout", Buffer.alloc(8 * 1024 * 1024));
  assert.throws(
    () => sink.captureBridgeLog("stderr", Buffer.from("x")),
    (error) => error.code === "OPENCODE_RAW_LOG_LIMIT" || error.message === "OPENCODE_RAW_LOG_LIMIT",
  );
});

test("raw-log fault fails at credential scan", { concurrency: false }, async (t) => {
  const missing = faultPrerequisites["opencode-proxy-raw-log"]?.();
  if (missing) {
    skipOrFailPrerequisite(t, `prerequisite missing on this runner: ${missing}`);
    return;
  }
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "resonantos-live-sdk-raw-log-"));
  try {
    const result = await runLaneFault("opencode-proxy-raw-log", artifactDir);
    const payload = JSON.parse(await readFile(path.join(artifactDir, "scenario-matrix.json"), "utf8"));
    const scenario = payload.scenarios.find((entry) => entry.id === "opencode-proxy-raw-log");
    assert.equal(result.code, 0);
    assert.match(scenario?.detail ?? "", /OPENCODE_RAW_LOG_CREDENTIAL_DETECTED/);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

function sseData(frame) {
  return Buffer.from(`data: ${JSON.stringify(frame)}\n\n`);
}

function timedSseReader(events, { hangWhenEmpty = true } = {}) {
  let index = 0;
  const startedAt = Date.now();
  return new ReadableStream({
    async pull(controller) {
      if (index >= events.length) {
        if (hangWhenEmpty) await new Promise(() => {});
        else controller.close();
        return;
      }
      const event = events[index++];
      const wait = Math.max(0, (event.atMs ?? 0) - (Date.now() - startedAt));
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (event.close) {
        controller.close();
        return;
      }
      controller.enqueue(event.bytes ?? sseData(event.frame));
    },
  }).getReader();
}

test("observation drain captures a late foreign frame while the other stream idles", async () => {
  const canary = `foreign-canary-${randomBytes(4).toString("hex")}`;
  const readerA = timedSseReader([
    { atMs: 10, frame: { version: 1, sessionId: "A", source: "governed", event: { type: "bridge.ready", properties: {} } } },
    { atMs: 30, frame: { version: 1, sessionId: "A", source: "external", event: { type: "session.updated", properties: { title: canary } } } },
  ]);
  const readerB = timedSseReader([]);
  const observeUntil = Date.now() + 1000;
  await Promise.all([
    drainEnvelopes(readerA, observeUntil),
    drainEnvelopes(readerB, observeUntil),
  ]);
  assert.match(envelopeRawText(readerA), new RegExp(canary));
});

test("readEnvelope timeout does not drop the in-flight chunk", async () => {
  const frame = { version: 1, sessionId: "late", source: "governed", event: { type: "bridge.ready", properties: {} } };
  const reader = timedSseReader([{ atMs: 150, frame }]);
  await assert.rejects(() => readEnvelope(reader, 40), /envelope timeout/);
  const received = await readEnvelope(reader, 1000);
  assert.deepEqual(received, frame);
  assert.match(envelopeRawText(reader), /"sessionId":"late"/);
});

test("revocation watcher distinguishes EOF from malformed data", async () => {
  const revoked = {
    version: 1,
    sessionId: "A",
    source: "governed",
    event: { type: "bridge.closed", properties: { code: "OPENCODE_REVOKED", error: "revoked" } },
  };
  const watchRevocation = createRevocationWatcher();
  const malformed = timedSseReader([
    { atMs: 0, frame: revoked },
    { atMs: 5, bytes: Buffer.from("data: {not-json}\n\n") },
  ]);
  const malformedResult = await watchRevocation(malformed, 500);
  assert.equal(malformedResult.eofAt, 0);
  assert.ok(malformedResult.error, "malformed JSON must be recorded as error, not EOF");
  assert.equal(malformedResult.sawClose, true);

  const ending = timedSseReader([
    { atMs: 0, frame: revoked },
    { atMs: 5, close: true },
  ], { hangWhenEmpty: false });
  const eofResult = await watchRevocation(ending, 500);
  assert.ok(eofResult.eofAt > 0, "stream end must record eofAt");
  assert.equal(eofResult.error, "");
  assert.equal(eofResult.sawClose, true);
});
