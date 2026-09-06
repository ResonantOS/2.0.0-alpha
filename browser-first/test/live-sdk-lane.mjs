#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  { id: "opencode-credential-server", run: opencodeCredentialServerScenario },
  { id: "execution-settings-gate", run: executionSettingsGateScenario },
  { id: "opencode-cli-delegation", run: opencodeCliDelegationScenario },
  { id: "opencode-version-pin", run: opencodeVersionPinScenario },
  { id: "public-manifests-validate", run: publicManifestsValidateScenario },
  { id: "extension-status-cards", run: extensionStatusCardsScenario },
  { id: "teardown", run: teardownScenario },
  { id: "checkout-config-untouched", run: checkoutConfigUntouchedScenario },
];

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
    bridgeLogs += sanitizeEvidenceText(chunk, { roots: [repoRoot, userRoot] });
  });
  bridge.stderr.on("data", (chunk) => {
    bridgeLogs += sanitizeEvidenceText(chunk, { roots: [repoRoot, userRoot] });
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

async function opencodeCredentialServerScenario() {
  const runtime = currentOpenCodeRuntime();
  if (!runtime.command) {
    // Locally a missing binary is a documented exclusion; in CI the runner installs the pinned binary into an
    // allowlisted root, so absence means the install or the pinned-roots discovery is broken → FAIL, never exclude.
    if (mode === "ci") throw new Error(`OpenCode binary unavailable in CI mode (install/pinned-roots regression). ${opencodeInstallHint()}`);
    excluded(`OpenCode binary unavailable. ${opencodeInstallHint()}`);
  }
  const started = await bridgeJson("/opencode/session/start", { method: "POST" });
  assert(started.status === 200 && started.payload.sessionId, `session start failed: HTTP ${started.status} ${started.payload.error ?? ""}`);
  assert(started.payload.eventAuthorization, "session start did not return eventAuthorization");
  const baseUrl = new URL(started.payload.baseUrl);
  const port = Number(baseUrl.port);
  assert(port >= 1024 && port !== 4096 && port !== 4231, `OpenCode server port ${port} is not an allowed ephemeral port.`);

  for (const route of ["/doc", "/session", "/event"]) {
    const unauth = await fetch(`${baseUrl.origin}${route}`).catch((error) => ({ status: 0, error }));
    assert(unauth.status === 401, `${route} without credential returned ${unauth.status}, expected 401`);
  }
  const doc = await fetch(`${baseUrl.origin}/doc`, { headers: { Authorization: started.payload.eventAuthorization } });
  assert(doc.status === 200, `/doc with credential returned ${doc.status}`);
  const eventController = new AbortController();
  const event = await fetch(`${baseUrl.origin}/event`, {
    headers: { Authorization: started.payload.eventAuthorization },
    signal: eventController.signal,
  });
  assert(event.status === 200, `/event with credential returned ${event.status}`);
  eventController.abort();

  const record = JSON.parse(await readFile(path.join(userRoot, "BrowserFirst", "opencode-server.json"), "utf8"));
  opencodePid = Number(record.pid ?? 0);
  assert(record.port === port, `PID record port ${record.port} did not match ${port}`);
  assert(pidAlive(opencodePid), `OpenCode PID ${opencodePid} is not live`);
  return `OpenCode session ${started.payload.sessionId} served on port ${port} with credential enforcement.`;
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
