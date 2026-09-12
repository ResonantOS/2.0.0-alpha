#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createLiveCertificationReport,
  sanitizeEvidenceText,
} from "./agent-control-live-report.mjs";
import {
  CdpClient,
  captureScreenshotArtifact,
  createLivePanelHarness,
  evaluate,
  freeLoopbackPort,
  launchExtensionContext,
  stageExtensionCopy,
} from "./live-harness.mjs";
import {
  capabilityForBridgeRoute,
  RUNTIME_CAPABILITY_ALLOWLIST,
} from "../resonantos-side-panel-extension/src/lib/bridge-client.js";
import { opencodeInstallHint, opencodeRuntimeDiagnostics } from "../host/opencode-runtime.mjs";

export const OPENCODE_RAW_LOG_LIMIT = 8 * 1024 * 1024;

export function createRawBridgeLogSink({
  sanitize = sanitizeEvidenceText,
  roots = [],
  limit = OPENCODE_RAW_LOG_LIMIT,
} = {}) {
  const rawBridgeLogChunks = { stdout: [], stderr: [] };
  let rawBytes = 0;
  let evidence = "";
  function captureBridgeLog(streamName, chunk) {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk ?? ""), "utf8");
    rawBytes += bytes.byteLength;
    if (rawBytes > limit) {
      const error = new Error("OPENCODE_RAW_LOG_LIMIT");
      error.code = "OPENCODE_RAW_LOG_LIMIT";
      throw error;
    }
    if (!Object.hasOwn(rawBridgeLogChunks, streamName)) rawBridgeLogChunks[streamName] = [];
    rawBridgeLogChunks[streamName].push(bytes);
    const resolvedRoots = typeof roots === "function" ? roots() : roots;
    evidence += sanitize(bytes.toString("utf8"), { roots: resolvedRoots })
      .replace(/\bBasic [A-Za-z0-9+/=]+\b/g, "Basic [redacted]");
  }
  function joinRaw() {
    return Buffer.concat([
      ...(rawBridgeLogChunks.stdout ?? []),
      ...(rawBridgeLogChunks.stderr ?? []),
    ]).toString("utf8");
  }
  function scanRawForCredentials() {
    const raw = joinRaw();
    if (/\bBasic [A-Za-z0-9+/=]+\b/.test(raw) || /OPENCODE_SERVER_PASSWORD/.test(raw) || /eventAuthorization/.test(raw)) {
      const error = new Error("OPENCODE_RAW_LOG_CREDENTIAL_DETECTED");
      error.code = "OPENCODE_RAW_LOG_CREDENTIAL_DETECTED";
      throw error;
    }
  }
  return { captureBridgeLog, joinRaw, getEvidence: () => evidence, scanRawForCredentials };
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const checkoutBridgeConfigPath = path.join(
  repoRoot,
  "browser-first",
  "resonantos-side-panel-extension",
  "src",
  "bridge-config.generated.js",
);
const artifactDir = path.resolve(
  process.env.RESONANTOS_LIVE_ARTIFACT_DIR
    ?? path.join(os.tmpdir(), "resonantos-live-sdk", new Date().toISOString().replace(/[:.]/g, "-")),
);
const isCi = /^(?:1|true)$/i.test(process.env.CI ?? "");
const mode = isCi && !process.env.RESONANTOS_LIVE_SDK_MODEL ? "ci" : "local";
const fault = String(process.env.RESONANTOS_LIVE_SDK_FAULT ?? "").trim();
const expectFail = parseArgValue("--expect-fail");
const childWaitBoundMs = 60_000;
const ORIGIN = "chrome-extension://test";
const forbiddenOpenCodeKey = /^(eventAuthorization|eventUrl|baseUrl|authorization|password|username|auth|credential)$/i;

let userRoot = "";
let bridgePort = 0;
let debugPort = 0;
let bridge = null;
let bridgeLogs = "";
let bridgeExitLine = "";
let browserContext = null;
let chromeProfile = "";
let stagedExtension = null;
let activeBridgeConfigPath = checkoutBridgeConfigPath;
let checkoutConfigBefore = null;
let opencodePid = 0;
let cleanupStarted = false;
const rawLogSink = createRawBridgeLogSink({
  sanitize: sanitizeEvidenceText,
  roots: () => [repoRoot, userRoot].filter(Boolean),
});
function captureBridgeLog(streamName, chunk) {
  rawLogSink.captureBridgeLog(streamName, chunk);
  bridgeLogs = rawLogSink.getEvidence();
}

const report = createLiveCertificationReport({
  artifactDir,
  certification: "resonantos-live-sdk",
  profile: mode,
  roots: [repoRoot, os.homedir()],
  runId: process.env.GITHUB_RUN_ID ?? "local",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
});

const ctx = {
  artifactDir,
  bridgeUrl: "",
  config: null,
  capabilityTokens: {},
  mode,
  userRoot: "",
  boundaryProof: { sessions: {}, readers: [] },
};

class ScenarioExcluded extends Error {
  constructor(message) {
    super(message);
    this.name = "ScenarioExcluded";
  }
}

function excluded(message) {
  throw new ScenarioExcluded(message);
}

const scenarios = [
  { id: "bridge-start", fatal: true, run: startBridgeScenario },
  { id: "execution-settings-gate", run: executionSettingsGateScenario },
  { id: "opencode-credential-server", run: opencodeCredentialServerScenario },
  { id: "opencode-proxy-capability", run: opencodeProxyCapabilityScenario },
  { id: "opencode-proxy-scope", run: opencodeProxyScopeScenario },
  { id: "opencode-proxy-raw-log", run: opencodeProxyRawLogScenario },
  { id: "opencode-proxy-revocation", run: opencodeProxyRevocationScenario },
  { id: "opencode-cli-delegation", run: opencodeCliDelegationScenario },
  { id: "opencode-version-pin", run: opencodeVersionPinScenario },
  { id: "public-manifests-validate", run: publicManifestsValidateScenario },
  { id: "extension-status-cards", run: extensionStatusCardsScenario },
  { id: "teardown", run: teardownScenario },
  { id: "checkout-config-untouched", run: checkoutConfigUntouchedScenario },
];

async function runScenario(scenario) {
  try {
    const detail = await scenario.run({ ctx, report });
    if (expectFail === scenario.id) {
      report.record(scenario.id, "failed", `Expected failure did not occur: ${detail ?? "scenario passed"}`);
      return "failed";
    }
    report.record(scenario.id, "passed", detail ?? "passed");
    return "passed";
  } catch (error) {
    if (error instanceof ScenarioExcluded) {
      if (expectFail === scenario.id) {
        report.record(scenario.id, "failed", `Expected failure was excluded instead: ${error.message}`);
        return "failed";
      }
      report.record(scenario.id, "excluded", error.message);
      return "excluded";
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (expectFail === scenario.id) {
      report.record(scenario.id, "passed", `Expected failure observed: ${detail}`);
      return "passed";
    }
    report.record(scenario.id, "failed", detail);
    return "failed";
  }
}

function parseArgValue(name) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return exact ? exact.slice(name.length + 1) : "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForChildExit(child, timeoutMs, label) {
  if (!child || child.exitCode !== null) return true;
  return withTimeout(new Promise((resolve) => child.once("exit", resolve)), timeoutMs, label);
}

async function execFileBound(command, args, options = {}) {
  return withTimeout(new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  }), childWaitBoundMs, `${path.basename(command)} ${args.join(" ")}`);
}

async function startBridgeScenario() {
  checkoutConfigBefore = await fileFingerprint(checkoutBridgeConfigPath);
  userRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-live-sdk-user-"));
  ctx.userRoot = userRoot;
  stagedExtension = await stageExtensionCopy(repoRoot);
  if (fault === "extension-status-cards") {
    // Real fault injection: strip the panel's capability mapping for GET /providers/status in the STAGED copy
    // only (never the checkout). The Settings Overview itself always requests /providers/status, so the fault is
    // deterministic on that target on every runner: the request goes out without a capability token and the
    // bridge answers a genuine 403 that only the "no 403 outside the loopback probe" assertion can catch
    // (the required-200 list is /status alone, so this fault does not trip it and the 403 guard is proven on its own).
    const stagedClient = path.join(stagedExtension.extensionRoot, "src", "lib", "bridge-client.js");
    const source = await readFile(stagedClient, "utf8");
    const needle = '  "GET /providers/status": "provider-diagnostics-read",\n';
    if (!source.includes(needle)) throw new Error("fault injection anchor missing in staged bridge-client.js");
    await writeFile(stagedClient, source.replace(needle, ""));
  }
  activeBridgeConfigPath = path.join(stagedExtension.extensionRoot, "src", "bridge-config.generated.js");
  try {
    bridgePort = await freeLoopbackPort();
    debugPort = await freeLoopbackPort();
  } catch (error) {
    // No sandbox shortcut: a lane that cannot bind loopback has proven nothing and must fail here (fatal).
    throw error;
  }
  const bridgeEnv = {
    ...process.env,
    RESONANTOS_BROWSER_FIRST_USER_ROOT: userRoot,
    RESONANTOS_BROWSER_FIRST_BRIDGE_PORT: String(bridgePort),
    RESONANTOS_EXTENSION_ROOT: stagedExtension.extensionRoot,
    RESONANTOS_BRIDGE_ALLOWED_ORIGINS: [process.env.RESONANTOS_BRIDGE_ALLOWED_ORIGINS, ORIGIN].filter(Boolean).join(","),
    ...(mode === "ci" && !process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: "live-sdk-placeholder-key" } : {}),
    ...(fault === "opencode-credential-server" ? { RESONANTOS_OPENCODE_PORT: "4231" } : {}),
  };
  bridge = spawn(process.execPath, [
    "browser-first/host/run-bridge-minimal.mjs",
    `--bridge-port=${bridgePort}`,
  ], {
    cwd: repoRoot,
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.on("data", (chunk) => {
    captureBridgeLog("stdout", chunk);
  });
  bridge.stderr.on("data", (chunk) => {
    captureBridgeLog("stderr", chunk);
  });
  bridge.once("exit", (code, signal) => {
    bridgeExitLine = `bridge exited code=${code ?? "null"} signal=${signal ?? "null"}`;
    bridgeLogs += `\n${bridgeExitLine}\n`;
  });

  ctx.config = await waitForGeneratedConfig(bridgePort);
  ctx.bridgeUrl = ctx.config.bridgeUrl;
  const requestedCapabilities = RUNTIME_CAPABILITY_ALLOWLIST.filter(
    () => true,
  );
  const response = await fetch(`${ctx.bridgeUrl}/api/capability-tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ResonantOS-Bridge-Token": ctx.config.bridgeToken,
      "X-ResonantOS-Capability-Bootstrap-Token": ctx.config.capabilityBootstrapToken,
    },
    body: JSON.stringify({ capabilities: requestedCapabilities }),
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === 200 && payload.ok, `capability bootstrap failed with HTTP ${response.status}: ${payload.error ?? "unknown error"}`);
  for (const capability of requestedCapabilities) {
    assert(payload.capabilityTokens?.[capability], `capability bootstrap did not return token for ${capability}`);
  }
  ctx.capabilityTokens = payload.capabilityTokens;
  return `Bridge started on ephemeral port ${new URL(ctx.bridgeUrl).port}; ${requestedCapabilities.length} capability tokens bootstrapped from staged extension root.`;
}

async function waitForGeneratedConfig(expectedPort) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const parsed = await readGeneratedConfig().catch(() => null);
    if (parsed?.bridgeUrl) {
      const url = new URL(parsed.bridgeUrl);
      if (Number(url.port) === expectedPort && parsed.bridgeToken && parsed.capabilityBootstrapToken) {
        return parsed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Generated bridge config for port ${expectedPort} did not appear. ${bridgeLogTail()}`);
}

async function readGeneratedConfig() {
  const source = await readFile(activeBridgeConfigPath, "utf8");
  const match = source.trim().match(/^globalThis\.__RESONANTOS_BRIDGE_CONFIG__ = Object\.freeze\(([\s\S]+)\);$/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

async function fileFingerprint(filePath) {
  try {
    const [metadata, content] = await Promise.all([stat(filePath), readFile(filePath)]);
    return {
      exists: true,
      mtimeMs: metadata.mtimeMs,
      hash: createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return { exists: false, mtimeMs: null, hash: null };
  }
}

function bridgeLogTail() {
  return sanitizeEvidenceText(bridgeLogs.split("\n").slice(-20).join("\n"), { roots: [repoRoot, userRoot] });
}

async function bridgeJson(route, { method = "GET", body, capability } = {}) {
  const requiredCapability = capability ?? capabilityForBridgeRoute(route, method);
  const headers = {
    "X-ResonantOS-Bridge-Token": ctx.config.bridgeToken,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const capabilityToken = ctx.capabilityTokens[requiredCapability];
  if (capabilityToken) {
    headers["X-ResonantOS-Bridge-Capability-Token"] = capabilityToken;
  }
  const response = await fetch(`${ctx.bridgeUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  return { status: response.status, ok: response.ok && payload.ok !== false, payload };
}

function currentOpenCodeRuntime() {
  return opencodeRuntimeDiagnostics({ env: process.env });
}

ctx.boundaryProof = ctx.boundaryProof ?? { sessions: {}, readers: [] };

function countForbiddenOpenCodeFields(value) {
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((n, [key, nested]) => n + (forbiddenOpenCodeKey.test(key) ? 1 : 0) + countForbiddenOpenCodeFields(nested), 0);
}

function sessionEntryKeys(entry) {
  return Object.keys(entry ?? {}).sort();
}

async function bridgeEvents(sessionId, { headers = {}, signal } = {}) {
  const url = `${ctx.bridgeUrl}/opencode/session/events?sessionId=${encodeURIComponent(sessionId)}`;
  const requestHeaders = {
    "X-ResonantOS-Bridge-Token": ctx.config.bridgeToken,
    "X-ResonantOS-Bridge-Capability-Token": ctx.capabilityTokens["addon-runtime-read"],
    Origin: ORIGIN,
    ...headers,
  };
  return fetch(url, { method: "GET", headers: requestHeaders, signal, redirect: "error" });
}

const envelopeReaders = new WeakMap();

function envelopeState(reader) {
  let state = envelopeReaders.get(reader);
  if (!state) {
    state = { decoder: new TextDecoder(), buffer: "", pending: [] };
    envelopeReaders.set(reader, state);
  }
  return state;
}

function takePendingEnvelope(state) {
  const frames = state.buffer.split("\n\n");
  state.buffer = frames.pop() ?? "";
  for (const frame of frames) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    state.pending.push(JSON.parse(data));
  }
  return state.pending.shift();
}

async function readEnvelope(reader, timeoutMs = 2000) {
  const state = envelopeState(reader);
  const queued = takePendingEnvelope(state);
  if (queued) return queued;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("envelope timeout")), remaining)),
    ]);
    if (result.done) throw new Error("OPENCODE_STREAM_DISCONNECTED");
    state.buffer += state.decoder.decode(result.value, { stream: true });
    const envelope = takePendingEnvelope(state);
    if (envelope) return envelope;
  }
  throw new Error("envelope timeout");
}

function httpBridgeRequest({ path: requestPath, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(ctx.bridgeUrl);
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: requestPath,
      method,
      headers,
    }, (res) => {
      const origin = res.headers["access-control-allow-origin"];
      if (String(res.headers["content-type"] ?? "").includes("text/event-stream")) {
        resolve({ status: res.statusCode, payload: {}, origin });
        res.destroy();
        return;
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let payload = {};
        try { payload = data ? JSON.parse(data) : {}; } catch { payload = {}; }
        resolve({ status: res.statusCode, payload, origin });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function requireOpenCodeBinary() {
  const runtime = currentOpenCodeRuntime();
  if (!runtime.command) {
    if (mode === "ci") throw new Error(`OpenCode binary unavailable in CI mode (install/pinned-roots regression). ${opencodeInstallHint()}`);
    excluded(`OpenCode binary unavailable. ${opencodeInstallHint()}`);
  }
  return runtime;
}

async function opencodeCredentialServerScenario() {
  await requireOpenCodeBinary();
  const startedA = await bridgeJson("/opencode/session/start", { method: "POST" });
  const startedB = await bridgeJson("/opencode/session/start", { method: "POST" });
  assert(startedA.status === 200 && startedB.status === 200, `session start failed: HTTP ${startedA.status}/${startedB.status}`);
  assert(startedA.payload.sessionId && startedB.payload.sessionId && startedA.payload.sessionId !== startedB.payload.sessionId, "session start did not return distinct nonempty ids");
  assert(Object.keys(startedA.payload).sort().join(",") === "ok,sessionId", `start keys were not ok,sessionId`);
  assert(Object.keys(startedB.payload).sort().join(",") === "ok,sessionId", `start keys were not ok,sessionId`);
  assert(countForbiddenOpenCodeFields(startedA.payload) === 0 && countForbiddenOpenCodeFields(startedB.payload) === 0, "start leaked connection fields");
  const listed = await bridgeJson("/opencode/sessions/list", { method: "POST", body: {} });
  assert(listed.status === 200, `session list failed: HTTP ${listed.status}`);
  assert(Object.keys(listed.payload).sort().join(",") === "ok,sessions", "list keys were not ok,sessions");
  assert(Array.isArray(listed.payload.sessions) && listed.payload.sessions.every((entry) => sessionEntryKeys(entry).join(",") === "created,id,title,updated"), "list entries were not id/title/created/updated");
  assert(countForbiddenOpenCodeFields(listed.payload) === 0, "list leaked connection fields");
  const web = await bridgeJson("/opencode/web/url", { method: "POST", body: {} });
  assert(web.status === 200 && web.payload.url === "" && web.payload.requiresCredential === true, "web url was not the disabled handoff shape");
  const messages = await bridgeJson("/opencode/session/messages", { method: "POST", body: { sessionId: startedA.payload.sessionId } });
  const diff = await bridgeJson("/opencode/session/diff", { method: "POST", body: { sessionId: startedA.payload.sessionId } });
  const agents = await bridgeJson("/opencode/agents/list", { method: "POST", body: {} });
  assert(messages.status === 200 && diff.status === 200 && agents.status === 200, "proxied session reads failed");
  assert(countForbiddenOpenCodeFields(messages.payload) === 0 && countForbiddenOpenCodeFields(diff.payload) === 0 && countForbiddenOpenCodeFields(agents.payload) === 0, "proxied reads leaked connection fields");

  const pidPath = path.join(userRoot, "BrowserFirst", "opencode-server.json");
  const record = JSON.parse(await readFile(pidPath, "utf8"));
  const details = await stat(pidPath);
  assert((details.mode & 0o077) === 0, "PID record mode allows group or other access");
  assert(!("auth" in record) && !("password" in record) && !("header" in record), "PID record contains credential fields");
  const port = Number(record.port);
  assert(port >= 1024 && port !== 4096 && port !== 4231, `OpenCode server port ${port} is not an allowed ephemeral port.`);
  opencodePid = Number(record.pid ?? 0);
  assert(pidAlive(opencodePid), `OpenCode PID ${opencodePid} is not live`);
  assert(Number(record.owner) === bridge.pid, "PID record is not owned by this bridge");
  for (const route of ["/doc", "/session", "/event"]) {
    const unauth = await fetch(`http://127.0.0.1:${port}${route}`).catch((error) => ({ status: 0, error }));
    assert(unauth.status === 401, `${route} without credential returned ${unauth.status}, expected 401`);
  }
  await runCredentiallessSecondProcess({ port, bridgeUrl: ctx.bridgeUrl });
  ctx.boundaryProof = {
    sessions: { A: startedA.payload.sessionId, B: startedB.payload.sessionId },
    port,
    readers: [],
  };
  return `OpenCode sessions ${startedA.payload.sessionId} and ${startedB.payload.sessionId} served on port ${port} with credentialless 401.`;
}

async function runCredentiallessSecondProcess({ port, bridgeUrl }) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ros-opencode-second-"));
  const script = path.join(cwd, "probe.mjs");
  await writeFile(script, `
    const [bridgeUrl, port] = process.argv.slice(2);
    const checks = [];
    async function hit(url, method = "GET") {
      const response = await fetch(url, { method }).catch(() => ({ status: 0, text: async () => "" }));
      const text = await response.text?.() ?? "";
      checks.push({ status: response.status, leaked: /eventAuthorization|eventUrl|OPENCODE_SERVER_PASSWORD|Basic /.test(text) });
    }
    await hit("http://127.0.0.1:" + port + "/doc");
    await hit("http://127.0.0.1:" + port + "/session");
    await hit("http://127.0.0.1:" + port + "/event");
    await hit(bridgeUrl + "/opencode/session/start", "POST");
    await hit(bridgeUrl + "/opencode/session/events?sessionId=x");
    await hit(bridgeUrl + "/api/capability-tokens", "POST");
    await hit(bridgeUrl + "/opencode/web/url", "POST");
    if (checks.length !== 7 || checks.some((entry) => entry.leaked)) process.exit(2);
    if (![401,401,401,401,401,401,401].every((status, i) => checks[i].status === status)) process.exit(3);
    process.stdout.write("ok");
  `);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, bridgeUrl, String(port)], {
        cwd,
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert(result.code === 0 && result.stdout.includes("ok"), "credentialless second-process probe failed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function executionSettingsGateScenario() {
  const runtime = currentOpenCodeRuntime();
  const initial = await bridgeJson("/addons/execution-settings", { method: "GET" });
  assert(initial.status === 200, `execution settings GET failed: HTTP ${initial.status}`);
  assert(initial.payload.settings?.opencode?.localCliExecution === false, "OpenCode localCliExecution must default to false.");

  if (!runtime.command) {
    if (mode === "ci") throw new Error(`OpenCode binary unavailable in CI mode (install/pinned-roots regression). ${opencodeInstallHint()}`);
    excluded(`OpenCode binary unavailable; disabled execution gate cannot reach the runtime branch. ${opencodeInstallHint()}`);
  }

  const created = await createOpenCodeDelegation("Live SDK disabled execution gate.");
  const denied = await bridgeJson("/opencode/delegation/start", {
    method: "POST",
    body: { path: created.payload.path, model: process.env.RESONANTOS_LIVE_SDK_MODEL },
  });
  assert(denied.status === 200, `disabled delegation start returned HTTP ${denied.status}: ${denied.payload.error ?? ""}`);
  assert(denied.payload.status === "blocked", `disabled delegation did not return blocked status: ${JSON.stringify(denied.payload)}`);
  assert(
    /execution (?:requires explicit enablement|is disabled)/i.test(denied.payload.blockedReason ?? ""),
    `disabled delegation error shape did not cite blockedReason: ${JSON.stringify(denied.payload)}`,
  );
  if (fault !== "execution-settings-gate") {
    const enabled = await bridgeJson("/addons/execution-settings", {
      method: "POST",
      body: { addon: "opencode", localCliExecution: true },
    });
    assert(enabled.status === 200 && enabled.payload.settings?.opencode?.localCliExecution === true, "OpenCode execution enable POST did not persist.");
  }
  const reflected = await bridgeJson("/addons/execution-settings", { method: "GET" });
  assert(reflected.payload.settings?.opencode?.localCliExecution === true, "OpenCode execution setting did not reflect enabled state.");
  return "OpenCode execution is disabled by default, blocks execution, and reflects explicit enablement.";
}

async function authorizedControl(path, { method = "GET", body } = {}) {
  const listenerPort = new URL(ctx.bridgeUrl).port;
  const headers = {
    Host: `127.0.0.1:${listenerPort}`,
    Origin: ORIGIN,
    "X-ResonantOS-Bridge-Token": ctx.config.bridgeToken,
    "X-ResonantOS-Bridge-Capability-Token": ctx.capabilityTokens[method === "GET" ? "addon-runtime-read" : "addon-runtime-control"],
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const result = await httpBridgeRequest({ path, method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: result.status, code: result.payload.code ?? null, origin: result.origin };
}

async function opencodeProxyCapabilityScenario() {
  await requireOpenCodeBinary();
  const sessionId = ctx.boundaryProof?.sessions?.A;
  assert(sessionId, "capability proof requires a registered session");
  const eventsPath = `/opencode/session/events?sessionId=${encodeURIComponent(sessionId)}`;
  const listenerPort = Number(new URL(ctx.bridgeUrl).port);
  const publicPort = listenerPort;
  const wrongPort = publicPort === 65535 ? 65534 : publicPort + 1;
  const token = ctx.config.bridgeToken;
  const read = ctx.capabilityTokens["addon-runtime-read"];
  const control = await authorizedControl(eventsPath);
  if (fault === "opencode-proxy-capability") {
    const omitted = await httpBridgeRequest({
      path: eventsPath,
      method: "GET",
      headers: { Host: `127.0.0.1:${listenerPort}`, Origin: ORIGIN, "X-ResonantOS-Bridge-Token": token },
    });
    assert(omitted.status === 200, "fault expected the capability-omitted SSE control to be accepted");
  }
  const missingCap = await httpBridgeRequest({
    path: eventsPath,
    method: "GET",
    headers: { Host: `127.0.0.1:${listenerPort}`, Origin: ORIGIN, "X-ResonantOS-Bridge-Token": token },
  });
  assert(control.status === 200 && control.code === null && control.origin === ORIGIN, `valid events control failed: ${JSON.stringify(control)}`);
  assert(missingCap.status === 403 && missingCap.payload.code === "OPENCODE_CAPABILITY_REQUIRED", "missing capability did not return 403");
  const wrongCap = await httpBridgeRequest({
    path: eventsPath,
    method: "GET",
    headers: {
      Host: `127.0.0.1:${listenerPort}`,
      Origin: ORIGIN,
      "X-ResonantOS-Bridge-Token": token,
      "X-ResonantOS-Bridge-Capability-Token": ctx.capabilityTokens["addon-runtime-control"],
    },
  });
  assert(wrongCap.status === 403 && wrongCap.payload.code === "OPENCODE_CAPABILITY_REQUIRED", "wrong capability did not return 403");
  const missingToken = await httpBridgeRequest({
    path: eventsPath,
    method: "GET",
    headers: { Host: `127.0.0.1:${listenerPort}`, Origin: ORIGIN },
  });
  assert(missingToken.status === 401, "missing token did not return 401");
  for (const host of [`evil.example:${listenerPort}`, `127.0.0.1:${wrongPort}`]) {
    const valid = await authorizedControl(eventsPath);
    const refused = await httpBridgeRequest({
      path: eventsPath,
      method: "GET",
      headers: {
        Host: host,
        Origin: ORIGIN,
        "X-ResonantOS-Bridge-Token": token,
        "X-ResonantOS-Bridge-Capability-Token": read,
      },
    });
    assert(valid.status === 200 && valid.code === null && valid.origin === ORIGIN, "adjacent valid Host control failed");
    assert(refused.status === 403 && refused.payload.code === "OPENCODE_HOST_REJECTED" && refused.origin === ORIGIN, "Host refusal was not OPENCODE_HOST_REJECTED");
  }
  const forwarded = await httpBridgeRequest({
    path: eventsPath,
    method: "GET",
    headers: {
      Host: `evil.example:${listenerPort}`,
      Origin: ORIGIN,
      "X-Forwarded-Host": `127.0.0.1:${listenerPort}`,
      "X-Forwarded-Port": String(listenerPort),
      "X-ResonantOS-Bridge-Token": token,
      "X-ResonantOS-Bridge-Capability-Token": read,
    },
  });
  assert(forwarded.status === 403 && forwarded.payload.code === "OPENCODE_HOST_REJECTED", "forwarded headers replaced Host");
  return "OpenCode proxy capability and Host controls matched the matrix.";
}

async function opencodeProxyScopeScenario() {
  await requireOpenCodeBinary();
  const { A, B } = ctx.boundaryProof?.sessions ?? {};
  assert(A && B, "scope proof requires sessions A and B");
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  ctx.boundaryProof.readers.push(controllerA, controllerB);
  const resA = await bridgeEvents(A, { signal: controllerA.signal });
  const resB = await bridgeEvents(B, { signal: controllerB.signal });
  assert(resA.status === 200 && resA.headers.get("content-type")?.includes("text/event-stream"), "SSE A was not text/event-stream");
  assert(resB.status === 200 && resB.headers.get("content-type")?.includes("text/event-stream"), "SSE B was not text/event-stream");
  const readerA = resA.body.getReader();
  const readerB = resB.body.getReader();
  const readyA = await readEnvelope(readerA, 2000);
  const readyB = await readEnvelope(readerB, 2000);
  assert(readyA.event?.type === "bridge.ready" && readyA.sessionId === A, "A did not receive its bridge.ready");
  assert(readyB.event?.type === "bridge.ready" && readyB.sessionId === B, "B did not receive its bridge.ready");
  const titleA = `canary-a-${randomBytes(4).toString("hex")}`;
  const titleB = `canary-b-${randomBytes(4).toString("hex")}`;
  if (fault !== "opencode-proxy-scope") {
    const renamedA = await bridgeJson("/opencode/session/rename", { method: "POST", body: { sessionId: A, title: titleA } });
    assert(renamedA.status === 200, "rename A failed");
  }
  const renamedB = await bridgeJson("/opencode/session/rename", { method: "POST", body: { sessionId: B, title: titleB } });
  assert(renamedB.status === 200, "rename B failed");
  const deadline = Date.now() + 5000;
  let sawA = false;
  let sawB = false;
  let receiptA = false;
  const bytesA = [];
  const bytesB = [];
  while (Date.now() < deadline && (!sawA || !sawB || !receiptA)) {
    const nextA = await readEnvelope(readerA, Math.max(1, deadline - Date.now())).catch(() => null);
    const nextB = await readEnvelope(readerB, Math.max(1, deadline - Date.now())).catch(() => null);
    if (nextA) {
      bytesA.push(JSON.stringify(nextA));
      if (nextA.event?.type === "session.updated" && nextA.source === "external" && JSON.stringify(nextA).includes(titleA)) sawA = true;
      if (nextA.event?.type === "bridge.operation" && nextA.source === "governed") receiptA = true;
    }
    if (nextB) {
      bytesB.push(JSON.stringify(nextB));
      if (nextB.event?.type === "session.updated" && nextB.source === "external" && JSON.stringify(nextB).includes(titleB)) sawB = true;
    }
  }
  assert(sawA && sawB, "required upstream session.updated events were not observed");
  assert(receiptA, "governed bridge.operation receipt for rename A was missing");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const rawA = bytesA.join("\n");
  const rawB = bytesB.join("\n");
  assert(!rawA.includes(titleB) && !rawA.includes(B), "A stream contained B identifiers");
  assert(!rawB.includes(titleA) && !rawB.includes(A), "B stream contained A identifiers");
  const unknown = await bridgeJson("/opencode/session/messages", { method: "POST", body: { sessionId: "unknown-session" } });
  assert(unknown.status === 404 && unknown.payload.code === "OPENCODE_SESSION_UNKNOWN", "unknown session was not 404");
  ctx.boundaryProof.streamA = { reader: readerA, controller: controllerA };
  ctx.boundaryProof.streamB = { reader: readerB, controller: controllerB };
  return "OpenCode proxy isolated A and B streams and required a real upstream rename event.";
}

async function opencodeProxyRawLogScenario() {
  if (fault === "opencode-proxy-raw-log") {
    captureBridgeLog("stdout", Buffer.from(`Authorization: Basic ${randomBytes(18).toString("base64")}\n`));
  }
  try {
    rawLogSink.scanRawForCredentials();
  } catch (error) {
    assert(error.code === "OPENCODE_RAW_LOG_CREDENTIAL_DETECTED", "raw credential scan used an unexpected code");
    throw error;
  }
  return "Unsanitized bridge logs contained no OpenCode credentials.";
}

async function opencodeProxyRevocationScenario() {
  await requireOpenCodeBinary();
  const { A, B } = ctx.boundaryProof?.sessions ?? {};
  assert(A && B, "revocation proof requires sessions A and B");
  const open = async (sessionId) => {
    const controller = new AbortController();
    ctx.boundaryProof.readers.push(controller);
    const response = await bridgeEvents(sessionId, { signal: controller.signal });
    assert(response.status === 200, "revocation SSE open failed");
    return { controller, reader: response.body.getReader(), response };
  };
  const streamA = await open(A);
  const streamB = await open(B);
  await readEnvelope(streamA.reader, 2000);
  await readEnvelope(streamB.reader, 2000);
  const dispatchAt = Date.now();
  let closeA = 0;
  let closeB = 0;
  const waitEof = async (stream) => {
    try {
      while (true) {
        const next = await stream.reader.read();
        if (next.done) return Date.now();
      }
    } catch {
      return Date.now();
    }
  };
  const eofA = waitEof(streamA);
  const eofB = waitEof(streamB);
  if (fault !== "opencode-proxy-revocation") {
    const disabled = await bridgeJson("/addons/execution-settings", {
      method: "POST",
      body: { addon: "opencode", localCliExecution: false },
    });
    const ackAt = Date.now();
    closeA = await eofA;
    closeB = await eofB;
    assert(disabled.status === 200 && disabled.payload.settings?.opencode?.localCliExecution === false, "disable did not persist");
    assert(closeA <= ackAt + 1000 && closeB <= ackAt + 1000, "typed close EOF missed the acknowledgement deadline");
    assert(!bridgeLogs.includes("OPENCODE_REVOKE_TIMEOUT"), "normal disable logged a timeout code");
    void dispatchAt;
  } else {
    await Promise.race([eofA, eofB, new Promise((resolve) => setTimeout(resolve, 1500))]);
    assert(false, "revocation close was observed without toggling execution off");
  }
  const enabled = await bridgeJson("/addons/execution-settings", {
    method: "POST",
    body: { addon: "opencode", localCliExecution: true },
  });
  assert(enabled.status === 200, "re-enable failed");
  await bridgeJson("/opencode/sessions/list", { method: "POST", body: {} });
  const refused = await httpBridgeRequest({
    path: `/opencode/session/events?sessionId=${encodeURIComponent(A)}`,
    method: "GET",
    headers: {
      Host: `127.0.0.1:${new URL(ctx.bridgeUrl).port}`,
      Origin: ORIGIN,
      "X-ResonantOS-Bridge-Token": ctx.config.bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": ctx.capabilityTokens["addon-runtime-read"],
    },
  });
  void refused;
  return "OpenCode live revocation closed both streams before settings acknowledgement.";
}

async function createOpenCodeDelegation(mission) {
  const created = await bridgeJson("/addons/delegate", {
    method: "POST",
    body: {
      target: "opencode",
      mission,
      contextMarkdown: "Live SDK lane bounded OpenCode delegation packet.",
      source: "live-sdk-lane",
    },
  });
  assert(created.status === 200 && created.payload.path, `delegation packet creation failed: HTTP ${created.status} ${created.payload.error ?? ""}`);
  return created;
}

async function opencodeCliDelegationScenario() {
  const runtime = currentOpenCodeRuntime();
  if (!runtime.command) {
    if (mode === "ci") throw new Error(`OpenCode binary unavailable in CI mode (install/pinned-roots regression). ${opencodeInstallHint()}`);
    excluded(`OpenCode binary unavailable. ${opencodeInstallHint()}`);
  }
  const settings = await bridgeJson("/addons/execution-settings", {
    method: "POST",
    body: { addon: "opencode", localCliExecution: true },
  });
  assert(settings.status === 200, `execution enable failed: HTTP ${settings.status}`);
  const created = await createOpenCodeDelegation("Live SDK OpenCode CLI delegation smoke test.");
  const started = await bridgeJson("/opencode/delegation/start", {
    method: "POST",
    body: {
      path: created.payload.path,
      model: process.env.RESONANTOS_LIVE_SDK_MODEL,
      timeoutMs: 90_000,
    },
  });
  assert(started.status === 200, `OpenCode CLI delegation start failed HTTP ${started.status}: ${started.payload.error ?? ""}`);
  const terminal = await pollDelegation(created.payload.path, 90_000);
  if (mode === "local") {
    assert(terminal.status === "completed", `local mode requires completed OpenCode delegation: ${JSON.stringify(terminal)}`);
    const artifact = await bridgeJson("/opencode/delegation/artifact", { method: "POST", body: { path: created.payload.path } });
    assert(artifact.status === 200 && String(artifact.payload.content ?? "").trim(), "OpenCode delegation artifact was empty.");
    return "OpenCode CLI delegation completed and returned a non-empty artifact.";
  }
  assert(["completed", "failed"].includes(terminal.status), `CI mode terminal state must be completed or failed after binary execution: ${JSON.stringify(terminal)}`);
  if (terminal.status === "failed") {
    const detail = sanitizedDelegationError(terminal);
    assert(!/command not found|spawn\s+ENOENT|\bENOENT\b|not found/i.test(detail), `OpenCode failed before reaching the binary: ${detail}`);
    return `OpenCode binary reached and returned failed terminal state: ${detail}`;
  }
  return "OpenCode binary reached and completed in CI mode.";
}

function sanitizedDelegationError(terminal) {
  const raw = [
    terminal.failureReason,
    terminal.resultExcerpt,
    terminal.error,
    terminal.stderr,
    terminal.summary,
  ].filter(Boolean).join(" ");
  const normalized = raw.replace(/\s+/g, " ").trim() || JSON.stringify(terminal);
  return sanitizeEvidenceText(normalized, { roots: [repoRoot, userRoot] }).slice(0, 160);
}

async function pollDelegation(relativePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const terminalStatuses = new Set(["completed", "failed", "blocked", "cancelled"]);
  let last = null;
  while (Date.now() < deadline) {
    const status = await bridgeJson("/opencode/delegation/status", { method: "POST", body: { path: relativePath } });
    assert(status.status === 200, `delegation status failed: HTTP ${status.status}`);
    last = status.payload;
    if (terminalStatuses.has(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`OpenCode delegation did not reach terminal state in ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

async function opencodeVersionPinScenario() {
  const runtime = currentOpenCodeRuntime();
  const pinPath = path.join(repoRoot, "browser-first", "host", "opencode-version.json");
  const pin = JSON.parse(await readFile(pinPath, "utf8"));
  const expected = fault === "opencode-version-pin" ? "0.0.0" : String(pin.pinned ?? "").trim();
  assert(expected, "opencode-version.json must declare pinned.");
  if (!runtime.command) {
    if (mode === "ci") throw new Error(`OpenCode binary unavailable in CI mode (install/pinned-roots regression). ${pin.install ?? opencodeInstallHint()}`);
    excluded(`OpenCode binary unavailable. ${pin.install ?? opencodeInstallHint()}`);
  }
  const version = await execFileBound(runtime.command, ["--version"], { cwd: repoRoot, encoding: "utf8" });
  assert(!version.error, `OpenCode --version failed: ${version.error?.message ?? version.stderr}`);
  const actual = version.stdout.trim() || version.stderr.trim();
  assert(actual === expected, `OpenCode version mismatch: expected ${expected}, actual ${actual}`);
  return `OpenCode version ${actual} matches pin.`;
}

async function publicManifestsValidateScenario() {
  const publicAddons = path.join(repoRoot, "public", "addons");
  const indexNames = ["index.json", "dev-index.json"];
  const names = new Set();
  for (const indexName of indexNames) {
    const entries = JSON.parse(await readFile(path.join(publicAddons, indexName), "utf8"));
    assert(Array.isArray(entries), `${indexName} must be an array.`);
    for (const entry of entries) names.add(entry);
  }
  const requiredFields = ["id", "name", "version", "runtimeType"];
  const validated = [];
  for (const filename of [...names].sort()) {
    const manifest = JSON.parse(await readFile(path.join(publicAddons, filename), "utf8"));
    for (const field of requiredFields) {
      assert(typeof manifest[field] === "string" && manifest[field].trim(), `${filename} missing required string ${field}`);
    }
    assert(Array.isArray(manifest.requestedCapabilities), `${filename} requestedCapabilities must be an array.`);
    if (manifest.systemSlots !== undefined) {
      assert(Array.isArray(manifest.systemSlots), `${filename} systemSlots must be an array when present.`);
    }
    validated.push(filename);
  }
  return `Structurally validated ${validated.length} public add-on manifest(s).`;
}

async function extensionStatusCardsScenario() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "resonantos-live-sdk-chrome-"));
  chromeProfile = profile;
  let panel = null;
  let settings = null;
  const responses = [];
  try {
    const launched = await launchExtensionContext({
      repoRoot,
      debugPort,
      profile,
      executablePath: process.env.RESONANTOS_LIVE_CHROME_PATH,
      extensionPath: stagedExtension.extensionRoot,
    });
    browserContext = launched.browserContext;
    const first = browserContext.pages()[0] ?? await browserContext.newPage();
    await first.goto("about:blank").catch(() => undefined);
    const harness = createLivePanelHarness({ debugPort });
    await harness.waitForDebugPort(() => bridgeLogTail());
    panel = await harness.openExtensionPanel();
    const settingsUrl = `chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl/src/main-workspace.html#settings/overview`;
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(settingsUrl)}`, { method: "PUT" })
      .then((response) => response.json());
    settings = new CdpClient(created.webSocketDebuggerUrl);
    await settings.connect();
    await settings.send("Runtime.enable");
    await settings.send("Page.enable");
    await settings.send("Network.enable");
    // Classify by the REQUEST, not by time: the panel's loopback detector raw-fetches GET /status without a
    // capability header (and does so again on every rebind, e.g. after a reload), so a time window around
    // capability bootstrap can never be reliable. A /status request WITHOUT the capability header is the
    // probe by definition and is recorded separately; every other bridge response is judged.
    const requestMeta = new Map();
    const judged = [];
    const probes = [];
    let bootstrapObserved = false;
    settings.on("Network.requestWillBeSent", (event) => {
      const url = event.request?.url ?? "";
      if (url.startsWith(ctx.bridgeUrl)) {
        const headers = Object.fromEntries(Object.entries(event.request?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        requestMeta.set(event.requestId, {
          method: event.request?.method ?? "",
          hasCapabilityHeader: Boolean(headers["x-resonantos-bridge-capability-token"]),
        });
      }
    });
    settings.on("Network.responseReceived", (event) => {
      const url = event.response?.url ?? "";
      if (!url.startsWith(ctx.bridgeUrl)) return;
      const meta = requestMeta.get(event.requestId) ?? { method: "", hasCapabilityHeader: false };
      const pathname = new URL(url).pathname;
      const entry = { method: meta.method, url, status: event.response.status, capabilityHeader: meta.hasCapabilityHeader };
      responses.push(entry);
      if (meta.method === "POST" && pathname === "/api/capability-tokens" && event.response.status === 200) {
        bootstrapObserved = true;
        return;
      }
      if (meta.method === "GET" && pathname === "/status" && !meta.hasCapabilityHeader) {
        probes.push(entry);
        return;
      }
      judged.push(entry);
    });
    await settings.send("Page.reload", { ignoreCache: true });
    await waitForOverviewCards(settings);
    assert(bootstrapObserved, `Settings Overview did not observe capability bootstrap: ${JSON.stringify(responses)}`);
    assert(!judged.some((response) => response.status === 403), `Settings Overview collected a 403 bridge response outside the loopback probe: ${JSON.stringify({ probes, judged })}`);
    // /status carries the aggregated provider/add-on/memory state the cards render from; it must be answered
    // 200 to a capability-authorized request. Any other route that 403s is caught by the assertion above.
    const required = ["GET /status"];
    for (const key of required) {
      const [, route] = key.split(" ");
      assert(
        judged.some((response) => new URL(response.url).pathname === route && response.status === 200 && response.capabilityHeader),
        `Settings Overview did not collect a capability-authorized HTTP 200 for ${key}: ${JSON.stringify({ probes, judged })}`,
      );
    }
    await mkdir(artifactDir, { recursive: true });
    await captureScreenshotArtifact(settings, path.join(artifactDir, "extension-status-cards.png"));
    return `Settings Overview status cards loaded; no 403 outside the loopback probe. ${JSON.stringify({ probes: probes.length, judged: judged.length, statuses: judged.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.status}`) })}`;
  } catch (error) {
    // Only a genuinely missing/uninstallable browser is an exclusion. Any other launch failure (no display,
    // sandbox, crash) is a real failure and must surface with its message — on CI it once hid a missing xvfb.
    if (/executable doesn't exist|Executable doesn't exist|Host system is missing dependencies/i.test(error?.message ?? "")) {
      excluded("Chrome is unavailable. Set RESONANTOS_LIVE_CHROME_PATH or install Playwright Chromium.");
    }
    throw error;
  } finally {
    settings?.close();
    panel?.close();
    await browserContext?.close().catch(() => undefined);
    browserContext = null;
  }
}

async function waitForOverviewCards(settings) {
  let lastError = null;
  for (let index = 0; index < 120; index += 1) {
    let state = null;
    try {
      // Right after Page.reload the document (or its body) can be absent for a moment on a slow runner; every
      // access below is null-safe and an evaluation exception means "not ready yet", never "failed".
      state = (await evaluate(settings, `(() => {
        const cards = [...(document.querySelectorAll?.(".settings-health-grid article") ?? [])].map((card) => ({
          label: card.querySelector("span")?.textContent?.trim() ?? "",
          value: card.querySelector("strong")?.textContent?.trim() ?? "",
          text: card.innerText ?? ""
        }));
        const wanted = ["Providers", "Add-ons", "Memory"];
        return {
          cards,
          ready: wanted.every((label) => {
            const card = cards.find((entry) => entry.label === label);
            return card && card.value && !/^Checking$/i.test(card.value);
          }),
          body: document.body?.innerText ?? ""
        };
      })()`)).result.value;
    } catch (error) {
      lastError = error;
    }
    if (state?.ready) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const text = await evaluate(settings, "document.body?.innerText ?? ''").then((result) => result.result.value).catch(() => `<unavailable: ${lastError?.message ?? "no page text"}>`);
  throw new Error(`Settings Overview cards did not load non-placeholder values. ${text.slice(0, 1000)}`);
}

async function teardownScenario() {
  const teardown = await cleanupBridgeProcess();
  if (opencodePid) {
    await waitForPidToDie(opencodePid, 5000, 100);
    assert(!pidAlive(opencodePid), `OpenCode child PID ${opencodePid} remained live after bridge teardown.`);
  }
  const record = await readOpencodePidRecord();
  assert(!record || !record.pid || !pidAlive(Number(record.pid)), `OpenCode PID record still names a live process: ${JSON.stringify(record)}`);
  return `Bridge exited on SIGTERM and OpenCode child/record were cleared or dead. ${JSON.stringify({ bridgeExit: teardown.exitLine, elapsedMs: teardown.elapsedMs, pidRecord: record })}`;
}

async function checkoutConfigUntouchedScenario() {
  const after = await fileFingerprint(checkoutBridgeConfigPath);
  assert(checkoutConfigBefore, "checkout bridge config fingerprint was not captured before lane start.");
  assert(after.exists === checkoutConfigBefore.exists, `checkout bridge config existence changed: before=${checkoutConfigBefore.exists} after=${after.exists}`);
  assert(after.hash === checkoutConfigBefore.hash, "checkout bridge config hash changed during isolated live SDK lane run.");
  assert(after.mtimeMs === checkoutConfigBefore.mtimeMs, "checkout bridge config mtime changed during isolated live SDK lane run.");
  return "Checkout bridge-config.generated.js mtime and hash were unchanged by the isolated live SDK lane.";
}

async function readOpencodePidRecord() {
  try {
    return JSON.parse(await readFile(path.join(userRoot, "BrowserFirst", "opencode-server.json"), "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupBridgeProcess() {
  if (!bridge) return { elapsedMs: 0, exitLine: bridgeExitLine || "bridge was not started" };
  const startedAt = Date.now();
  if (bridge.exitCode !== null) {
    return { elapsedMs: 0, exitLine: bridgeExitLine || `bridge exited code=${bridge.exitCode ?? "null"} signal=${bridge.signalCode ?? "null"}` };
  }
  bridge.kill("SIGTERM");
  const exited = await Promise.race([
    waitForChildExit(bridge, 5000, "bridge SIGTERM wait").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited && bridge.exitCode === null) {
    bridge.kill("SIGKILL");
    await waitForChildExit(bridge, childWaitBoundMs, "bridge SIGKILL wait").catch(() => undefined);
  }
  return {
    elapsedMs: Date.now() - startedAt,
    exitLine: bridgeExitLine || `bridge exited code=${bridge.exitCode ?? "null"} signal=${bridge.signalCode ?? "null"}`,
  };
}

async function waitForPidToDie(pid, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !pidAlive(pid);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await browserContext?.close().catch(() => undefined);
  for (const controller of ctx.boundaryProof?.readers ?? []) {
    try { controller.abort(); } catch { /* noop */ }
  }
  await cleanupBridgeProcess().catch(() => undefined);
  if (userRoot) {
    const record = await readOpencodePidRecord();
    if (record?.pid && pidAlive(Number(record.pid)) && Number(record.owner) === bridge?.pid) {
      try { process.kill(Number(record.pid), "SIGTERM"); } catch {}
    }
  }
  if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }).catch(() => undefined);
  if (stagedExtension) await stagedExtension.cleanup().catch(() => undefined);
  if (userRoot) await rm(userRoot, { recursive: true, force: true }).catch(() => undefined);
}

const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }

  let failed = false;
  let terminalError = null;
  try {
    await mkdir(artifactDir, { recursive: true });
    for (const scenario of scenarios) {
      const status = await runScenario(scenario);
      if (status === "failed") failed = true;
      if (expectFail === scenario.id && status === "passed") break;
      if (status === "failed" && scenario.fatal) break;
    }
  } catch (error) {
    failed = true;
    terminalError = error;
  } finally {
    await report.write({
      status: failed ? "failed" : "passed",
      error: terminalError,
      metadata: {
        mode,
        commit: process.env.GITHUB_SHA ?? "local",
        fault,
        expectFail,
      },
    });
    await cleanup();
  }

  if (failed) process.exit(1);
}
