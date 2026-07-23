import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createOpencodeServerLifecycle,
  readOpencodeServerBaseUrl,
} from "../host/opencode-client.mjs";
import { opencodeRuntimeDiagnostics } from "../host/opencode-runtime.mjs";
import { createOpencodeSessionHandlers } from "../host/opencode-session-host-service.mjs";

const EXPECTED_VERSION = "1.18.4";
const MODEL = "minimax/MiniMax-M3";
const PUBLIC_WORKSPACE = "live-contract-workspace";
const EVENT_TIMEOUT_MS = 12_000;

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function bridgeIsUnreachable(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`${baseUrl}/doc`, { signal: controller.signal });
    await response.body?.cancel();
    return false;
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForAttributableEvent(handlers, sessionId) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await handlers.executeOpenCodeSessionEvents({
      sessionId,
      after: 0,
    });
    const matched = result.events.find((event) => (
      event?.data?.sessionID === sessionId
    ));
    if (matched) return matched;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("OpenCode live contract did not receive an attributable session event.");
}

const runtime = opencodeRuntimeDiagnostics();
assert.equal(runtime.installed, true, "a fixed-root OpenCode runtime is required");
assert.equal(runtime.resolution?.source.startsWith("fixed-"), true);

const versionResult = spawnSync(runtime.command, ["--version"], {
  encoding: "utf8",
  shell: false,
});
assert.equal(versionResult.status, 0, "OpenCode --version must succeed");
assert.equal(String(versionResult.stdout).trim(), EXPECTED_VERSION);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-opencode-live-contract-"));
const workspace = path.join(tempRoot, "workspace");
const isolatedHome = path.join(tempRoot, "home");
await mkdir(workspace);
await mkdir(isolatedHome);

let capturedBaseUrl = "";
let generatedPassword = "";
let ownedPid = 0;
let sessionId = "";

const lifecycle = createOpencodeServerLifecycle({
  randomPassword() {
    generatedPassword = randomBytes(32).toString("base64url");
    return generatedPassword;
  },
  async readServerAddress(child, options) {
    capturedBaseUrl = await readOpencodeServerBaseUrl(child, options);
    return capturedBaseUrl;
  },
  spawnImpl(command, args, options) {
    const child = spawn(command, args, options);
    ownedPid = child.pid;
    return child;
  },
});

const handlers = createOpencodeSessionHandlers({
  async preflight() {
    return {
      allowed: true,
      childEnvironment: {
        HOME: isolatedHome,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      model: MODEL,
      workspace,
    };
  },
  redactWorkspace() {
    return PUBLIC_WORKSPACE;
  },
  startLifecycle({ preflight, workspace: ownedWorkspace }) {
    return lifecycle.start({
      command: runtime.command,
      cwd: ownedWorkspace,
      env: preflight.childEnvironment,
    });
  },
  createClient({ lifecycle: handle }) {
    return lifecycle.createClient(handle);
  },
  stopLifecycle(handle) {
    return lifecycle.stop(handle);
  },
});

try {
  const publicResult = await handlers.executeOpenCodeSessionStart();
  sessionId = publicResult.sessionId;

  assert.match(capturedBaseUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  assert.match(sessionId, /^ses_/);
  assert.deepEqual(publicResult, {
    sessionId,
    workspace: PUBLIC_WORKSPACE,
  });

  const serializedPublicResult = JSON.stringify(publicResult);
  assert.equal(serializedPublicResult.includes(capturedBaseUrl), false);
  assert.equal(serializedPublicResult.includes(generatedPassword), false);
  assert.equal(serializedPublicResult.includes(workspace), false);

  const unauthenticated = await fetch(`${capturedBaseUrl}/doc`);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();

  const event = await waitForAttributableEvent(handlers, sessionId);
  assert.equal(event.data.sessionID, sessionId);

  await handlers.executeOpenCodeSessionStop({ sessionId });
  sessionId = "";

  assert.deepEqual(lifecycle.status(), { state: "stopped" });
  assert.equal(processExists(ownedPid), false);
  assert.equal(await bridgeIsUnreachable(capturedBaseUrl), true);

  console.log(JSON.stringify({
    attributableEvent: true,
    childExited: true,
    childUnreachableAfterStop: true,
    controllerResultRedacted: true,
    runtimeVersion: EXPECTED_VERSION,
    sdkSessionCreated: true,
    unauthenticatedStatus: unauthenticated.status,
    workspaceLabel: PUBLIC_WORKSPACE,
  }, null, 2));
} finally {
  if (sessionId) {
    await handlers.executeOpenCodeSessionStop({ sessionId }).catch(() => undefined);
  }
  await handlers.shutdownOpenCodeSession().catch(() => undefined);
  await lifecycle.shutdown().catch(() => undefined);
  generatedPassword = "";
  await rm(tempRoot, { force: true, recursive: true });
}
