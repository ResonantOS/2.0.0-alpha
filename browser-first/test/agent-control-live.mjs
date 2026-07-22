import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";

import {
  createLiveCertificationReport,
  decidePublicSubmitScenario,
  decideUnavailableCertification,
} from "./agent-control-live-report.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resonantExtensionId = "cdpdmmalhmokbfcfgogoepnjplaakgnl";
const isCi = /^(?:1|true)$/i.test(process.env.CI ?? "");
const liveProfile = process.env.RESONANTOS_LIVE_PROFILE ?? (isCi ? "agent-control" : "full");
const publicSubmitContract = process.env.RESONANTOS_PUBLIC_SUBMIT_CONTRACT ?? "auto";
const artifactDir = path.resolve(
  process.env.RESONANTOS_LIVE_ARTIFACT_DIR
    ?? path.join(os.tmpdir(), `resonantos-agent-control-live-${process.pid}`),
);
const certificationReport = createLiveCertificationReport({
  artifactDir,
  profile: liveProfile,
  roots: [repoRoot, os.homedir()],
  runId: process.env.GITHUB_RUN_ID ?? "local",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
});

if (process.env.RESONANTOS_LIVE_FORCE_UNAVAILABLE === "1") {
  const unavailable = decideUnavailableCertification({
    ci: isCi,
    reason: "Forced Chrome-unavailable probe.",
  });
  certificationReport.record(
    "environment-chrome",
    isCi ? "failed" : "excluded",
    unavailable.reason,
  );
  await certificationReport.write({ status: unavailable.status });
  console.error(`agent-control-live ${unavailable.status}: ${unavailable.reason}`);
  process.exit(unavailable.exitCode);
}

async function freeLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }).catch((error) => {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return decideUnavailableCertification({
        ci: isCi,
        reason: "Localhost bind is denied in this environment.",
      });
    }
    throw error;
  });
  if (!server.listening) {
    const unavailable = decideUnavailableCertification({
      ci: isCi,
      reason: "Localhost bind is denied in this environment.",
    });
    certificationReport.record(
      "environment-loopback",
      isCi ? "failed" : "excluded",
      unavailable.reason,
    );
    await certificationReport.write({ status: unavailable.status });
    console.error(`agent-control-live ${unavailable.status}: ${unavailable.reason}`);
    process.exit(unavailable.exitCode);
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const fixturePort = await freeLoopbackPort();
const debugPort = await freeLoopbackPort();
const bridgePort = await freeLoopbackPort();
const cdpTimeoutMs = Number.parseInt(process.env.RESONANTOS_LIVE_CDP_TIMEOUT_MS ?? "10000", 10);

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    let timeoutId = null;
    const response = new Promise((resolve, reject) => this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    }));
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        this.pending.delete(id);
        const expression = typeof params.expression === "string"
          ? ` expression=${JSON.stringify(params.expression.slice(0, 220))}`
          : "";
        reject(new Error(`CDP ${method} timed out after ${cdpTimeoutMs}ms.${expression}`));
      }, cdpTimeoutMs);
    });
    return Promise.race([response, timeout]);
  }

  close() {
    this.ws?.close();
  }
}

async function captureScreenshotArtifact(client, filePath) {
  const captureVisibleViewport = async () => {
    await client.send("Page.bringToFront").catch(() => undefined);
    await client.send("Runtime.evaluate", {
      expression: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      awaitPromise: true,
      returnByValue: true,
    }).catch(() => undefined);
    const metrics = await client.send("Page.getLayoutMetrics").catch(() => ({}));
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    const width = Math.max(320, Math.min(1600, Math.floor(viewport.clientWidth ?? 1280)));
    const height = Math.max(240, Math.min(1200, Math.floor(viewport.clientHeight ?? 900)));
    return client.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
      clip: {
        x: Math.max(0, Math.floor(viewport.pageX ?? 0)),
        y: Math.max(0, Math.floor(viewport.pageY ?? 0)),
        width,
        height,
        scale: 1,
      },
    });
  };

  try {
    let shot = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        shot = await captureVisibleViewport();
        break;
      } catch (error) {
        lastError = error;
        await client.send("Page.stopLoading").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    if (!shot?.data) {
      throw lastError ?? new Error("CDP Page.captureScreenshot did not return image data.");
    }
    await writeFile(filePath, Buffer.from(shot.data, "base64"));
    return { ok: true, path: filePath };
  } catch (error) {
    const domPng = await client.send("Runtime.evaluate", {
      expression: `new Promise((resolve) => {
        try {
          const width = Math.max(320, Math.min(1600, window.innerWidth || 1280));
          const height = Math.max(240, Math.min(1200, window.innerHeight || 900));
          const clone = document.documentElement.cloneNode(true);
          clone.querySelectorAll("script").forEach((node) => node.remove());
          const html = new XMLSerializer().serializeToString(clone);
          const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + width + "' height='" + height + "'>" +
            "<foreignObject width='100%' height='100%'>" + html + "</foreignObject></svg>";
          const image = new Image();
          image.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            context.fillStyle = getComputedStyle(document.body).backgroundColor || "#fff";
            context.fillRect(0, 0, width, height);
            context.drawImage(image, 0, 0);
            resolve({ ok: true, data: canvas.toDataURL("image/png").split(",")[1] });
          };
          image.onerror = () => resolve({ ok: false, error: "DOM image render failed." });
          image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        } catch (renderError) {
          resolve({ ok: false, error: String(renderError && renderError.message ? renderError.message : renderError) });
        }
      })`,
      awaitPromise: true,
      returnByValue: true,
    }).catch((fallbackError) => ({
      result: { value: { ok: false, error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) } },
    }));
    if (domPng?.result?.value?.ok && domPng.result.value.data) {
      await writeFile(filePath, Buffer.from(domPng.result.value.data, "base64"));
      return { ok: true, path: filePath, fallback: "dom-rendered-png" };
    }
    const snapshot = await client.send("Runtime.evaluate", {
      expression: "document.body.innerText",
      returnByValue: true,
    }).catch((fallbackError) => ({
      result: {
        value: `Screenshot failed: ${error instanceof Error ? error.message : String(error)}\nText snapshot failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      },
    }));
    await writeTextPreviewPng(filePath, String(snapshot?.result?.value ?? ""));
    return {
      ok: true,
      path: filePath,
      fallback: "node-rendered-text-png",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function textHash(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function writeTextPreviewPng(filePath, text) {
  const width = 1280;
  const height = 900;
  const hash = textHash(text);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = 1 + x * 4;
      const wave = Math.sin((x + y + (hash % 360)) / 55);
      const grid = (x % 32 === 0 || y % 32 === 0) ? 30 : 0;
      row[i] = 190 - grid;
      row[i + 1] = Math.max(120, 245 - grid);
      row[i + 2] = Math.max(130, 218 + Math.round(wave * 22) - grid);
      row[i + 3] = 255;
    }
    rows.push(row);
  }
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 8);
  lines.forEach((line, lineIndex) => {
    const y = 70 + lineIndex * 46;
    const blocks = Math.min(44, Math.max(8, Math.ceil(line.length / 3)));
    for (let block = 0; block < blocks; block += 1) {
      const x = 70 + block * 24;
      for (let dy = 0; dy < 22; dy += 1) {
        const row = rows[y + dy];
        if (!row) continue;
        for (let dx = 0; dx < 16; dx += 1) {
          const i = 1 + (x + dx) * 4;
          row[i] = 16;
          row[i + 1] = 36;
          row[i + 2] = 30;
          row[i + 3] = 255;
        }
      }
    }
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND"),
  ]);
  await writeFile(filePath, png);
}

const fixtureHtml = `<!doctype html>
<html>
  <head>
    <title>ResonantOS Agent Fixture</title>
    <style>
      body { font-family: sans-serif; min-height: 2400px; padding: 40px; }
      button, input, textarea, [contenteditable] { font-size: 20px; margin: 10px; padding: 12px; }
      #status { position: fixed; top: 20px; right: 20px; background: #0b6; padding: 10px; }
      #doc { border: 2px solid #999; min-height: 80px; }
    </style>
  </head>
  <body>
    <h1>Agent Control Fixture</h1>
    <p>This page verifies safe browser control, document-style typing, and approval gates.</p>
    <section id="dao">
      <h2>DAO Governance Fixture</h2>
      <p>Proposal 12: upgrade treasury policy. Quorum threshold is 4%. Treasury transfer is 10 SOL. Deadline closes Friday.</p>
      <button id="dao-connect" type="button">Connect Wallet</button>
      <button id="dao-vote-for" type="button">Vote For</button>
      <button id="dao-vote-against" type="button">Against</button>
      <button id="dao-abstain" type="button">Abstain</button>
      <button id="dao-execute" type="button">Execute Proposal</button>
      <label>Treasury recipient <input name="treasury-recipient" aria-label="Treasury recipient" placeholder="Treasury recipient"></label>
      <label>Delegate vote reason <textarea name="delegate-reason" aria-label="Delegate vote reason"></textarea></label>
    </section>
    <iframe title="Booking calendar" src="/calendar" width="680" height="260"></iframe>
    <button id="safe">Safe Details</button>
    <button id="cart">Add to Cart</button>
    <form id="public">
      <input name="search" aria-label="Search field" placeholder="Search field">
      <input type="email" name="email" aria-label="Email address" placeholder="Email address">
      <input type="password" name="password" aria-label="Password" placeholder="Password">
      <input type="text" name="card" aria-label="Card number" placeholder="Card number" autocomplete="cc-number">
      <button id="submit" type="submit">Submit public form</button>
    </form>
    <textarea id="inline-editor" aria-label="Inline editable note">prefix teh quick i suffix</textarea>
    <section id="doc" contenteditable="true" aria-label="Draft document">Draft starts here.</section>
    <button id="wallet" type="button">Connect Wallet</button>
    <div id="status">idle</div>
    <div id="details">details closed</div>
    <script>
      window.__submitted = false;
      window.solana = {
        isConnected: true,
        isPhantom: true,
        publicKey: { toString: () => "9abc11112222333344445555666677778888wxyz" }
      };
      document.querySelector("#safe").addEventListener("click", () => {
        document.querySelector("#details").textContent = "safe details opened";
        document.querySelector("#status").textContent = "clicked";
      });
      document.querySelector("#public").addEventListener("submit", (event) => {
        event.preventDefault();
        window.__submitted = true;
        document.querySelector("#status").textContent = "submitted";
      });
      document.querySelector("#cart").addEventListener("click", () => {
        document.body.dataset.cart = "added";
        document.querySelector("#status").textContent = "cart-added";
      });
      document.querySelector("#wallet").addEventListener("click", () => {
        document.querySelector("#status").textContent = "wallet-clicked";
      });
    </script>
  </body>
</html>`;

const calendarHtml = `<!doctype html>
<html>
  <head><title>Calendar Fixture</title></head>
  <body>
    <h2>Booking calendar frame</h2>
    <p>Available appointment: Tuesday 10:00.</p>
    <button id="slot">Tuesday 10:00</button>
    <input aria-label="Calendar guest name" placeholder="Calendar guest name">
    <script>
      document.querySelector("#slot").addEventListener("click", () => {
        document.body.dataset.slot = "Tuesday 10:00";
      });
    </script>
  </body>
</html>`;

function assert(condition, message) {
  certificationReport.assert(condition, message);
}

async function waitForDebugPort(getHostLogs = () => "") {
  for (let index = 0; index < 60; index += 1) {
    try {
      return await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Browser debug port ${debugPort} did not become available. Host logs:\n${getHostLogs()}`);
}

async function openExtensionPanel() {
  await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`chrome-extension://${resonantExtensionId}/src/side-panel.html`)}`,
    { method: "PUT" },
  ).then((response) => response.json());
  return waitForBrowserTarget(
    (target) => target.url === `chrome-extension://${resonantExtensionId}/src/side-panel.html`,
    "ResonantOS side panel extension target"
  );
}

async function browserTargets() {
  return fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
}

async function waitForBrowserTarget(predicate, label) {
  for (let index = 0; index < 80; index += 1) {
    const targets = await browserTargets();
    const target = targets.find(predicate);
    if (target?.webSocketDebuggerUrl) {
      return target;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const targets = await browserTargets().catch(() => []);
  throw new Error(`${label} did not appear in CDP targets.\nTargets:\n${JSON.stringify(targets, null, 2)}`);
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "CDP evaluation failed."
    );
  }
  return result;
}

async function waitForPanelText(panel, pattern, label) {
  let lastError = null;
  let consecutiveErrors = 0;
  for (let index = 0; index < 100; index += 1) {
    try {
      const text = (await evaluate(panel, "document.body.innerText")).result.value;
      if (pattern.test(text)) return text;
      consecutiveErrors = 0;
    } catch (error) {
      lastError = error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const text = await evaluate(panel, "document.body.innerText")
    .then((result) => result.result.value)
    .catch(() => `<panel text unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}>`);
  throw new Error(`${label} did not appear. Panel text:\n${text}`);
}

async function submitControlCommand(panel, command, { preflightAction = null } = {}) {
  await waitForComposerReady(panel, `before ${command}`);
  const expression = `(() => {
    const input = document.querySelector("#command-input");
    input.value = ${JSON.stringify(command)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#command-form").requestSubmit();
  })()`;
  await evaluate(panel, expression);
  if (preflightAction) {
    await approveControlPreflightIfNeeded(panel, { preflightAction });
  }
}

async function approveControlPreflightIfNeeded(panel, { preflightAction = "approve" } = {}) {
  for (let index = 0; index < 20; index += 1) {
    const state = (await evaluate(panel, `({
      cardVisible: !document.querySelector("#control-preflight-card")?.hidden,
      disabled: document.querySelector("#command-input")?.disabled ?? true
    })`)).result.value;
    if (state.cardVisible && !state.disabled) {
      await evaluate(panel, `(() => {
        const button = document.querySelector(${JSON.stringify(preflightAction === "trust" ? "#control-preflight-trust" : "#control-preflight-approve")});
        if (button && !button.closest("[hidden]")) {
          button.click();
          return;
        }
      })()`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function waitForComposerReady(panel, label) {
  let lastError = null;
  let consecutiveErrors = 0;
  for (let index = 0; index < 100; index += 1) {
    try {
      const state = (await evaluate(panel, `({
        disabled: document.querySelector("#command-input").disabled,
        connection: document.querySelector("#connection-line").getAttribute("aria-label") || document.querySelector("#connection-line").title || document.querySelector("#connection-line").textContent
      })`)).result.value;
      if (!state.disabled) return state;
      consecutiveErrors = 0;
    } catch (error) {
      lastError = error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const text = await evaluate(panel, "document.body.innerText")
    .then((result) => result.result.value)
    .catch(() => `<panel text unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}>`);
  throw new Error(`${label} did not return composer readiness. Panel text:\n${text}`);
}

async function waitForBrowserJobTerminal(panel, goalPattern, label) {
  const terminalStatuses = new Set(["completed", "blocked", "denied", "cancelled", "failed"]);
  for (let index = 0; index < 120; index += 1) {
    const state = (await evaluate(panel, `(async () => ({
      jobs: (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [],
      text: document.body.innerText
    }))()`)).result.value;
    const job = state.jobs.find((entry) => goalPattern.test(String(entry.goal ?? "")));
    if (job && terminalStatuses.has(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const state = (await evaluate(panel, `(async () => ({
    jobs: (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [],
    text: document.body.innerText
  }))()`)).result.value;
  throw new Error(`${label} did not reach a terminal browser-job state. Jobs:\n${JSON.stringify(state.jobs, null, 2)}\nPanel text:\n${state.text}`);
}

async function waitForPageCondition(page, expression, label) {
  let lastError = null;
  let consecutiveErrors = 0;
  for (let index = 0; index < 80; index += 1) {
    try {
      const value = (await evaluate(page, expression)).result.value;
      if (value) return value;
      consecutiveErrors = 0;
    } catch (error) {
      lastError = error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const text = await evaluate(page, "document.body.innerText")
    .then((result) => result.result.value)
    .catch(() => `<page text unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}>`);
  const evaluationError = lastError
    ? `\nLast evaluation error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : "";
  throw new Error(`${label} did not become true.${evaluationError}\nPage text:\n${text}`);
}

async function verifyPublicSubmitBoundary(panel, page) {
  await evaluate(panel, `(() => {
    globalThis.__resonantosLivePublicSubmitOverrideCalls = 0;
    globalThis.__resonantosNextActionOverride = async () => {
      globalThis.__resonantosLivePublicSubmitOverrideCalls += 1;
      return {
        source: "test-next-action",
        thought: "Attempt unsafe submit; content script must block this.",
        status: "continue",
        action: { type: "click", text: "Submit public form" },
        approvalReason: null,
        doneSummary: null
      };
    };
    return true;
  })()`);
  const baseline = (await evaluate(panel, `({
    messageCount: document.querySelectorAll("#transcript .message").length
  })`)).result.value;
  await submitControlCommand(panel, `/control click "Submit public form"`);
  let outcome;
  try {
    outcome = await waitForPageCondition(panel, `(async () => {
      const jobs = (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [];
      const publicJobs = jobs.filter((job) => /Submit public form/i.test(job.pendingApproval?.step?.text ?? ""));
      const buttons = [...document.querySelectorAll("button")]
        .filter((button) => /click "Submit public form"/i.test(button.title || ""))
        .map((button) => button.textContent.trim());
      const newMessageText = [...document.querySelectorAll("#transcript .message")]
        .slice(${Number(baseline.messageCount)})
        .map((message) => message.innerText)
        .join("\\n");
      const humanSignal = /human-only|click it yourself|must be performed by the human|then resume/i.test(newMessageText);
      if (!publicJobs.length && !humanSignal) return false;
      return { publicJobs, buttons, newMessageText, humanSignal };
    })()`, "public-submit boundary outcome");
  } catch (error) {
    const diagnostics = (await evaluate(panel, `(async () => ({
      overrideCalls: globalThis.__resonantosLivePublicSubmitOverrideCalls ?? 0,
      jobs: (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? []
    }))()`)).result.value;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics: ${JSON.stringify(diagnostics)}`);
  }
  const blockedState = (await evaluate(page, `({ submitted: window.__submitted, status: document.querySelector("#status").textContent })`)).result.value;
  assert(!blockedState.submitted, `Public-submit boundary executed the action: ${JSON.stringify(blockedState)}`);
  // The human-only refusal message renders before the job finishes settling, so
  // `outcome` can be sampled while the job is still queued/running. Classifying
  // from that snapshot both misses a late "approval" job (a false pass on the
  // human-only property) and leaves it holding the tab page lock, which starves
  // every later scenario. Re-read the job store once the job has settled.
  const settledPublicJobs = await waitForPageCondition(panel, `(async () => {
    const jobs = (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [];
    const publicJobs = jobs.filter((job) => /Submit public form/i.test(job.goal ?? "")
      || /Submit public form/i.test(job.pendingApproval?.step?.text ?? ""));
    if (!publicJobs.length) return false;
    const settled = publicJobs.every((job) => !["queued", "running"].includes(job.status));
    if (!settled) return false;
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => /click "Submit public form"/i.test(button.title || ""))
      .map((button) => button.textContent.trim());
    return { publicJobs, buttons };
  })()`, "public-submit job settle");
  const approvalJobs = settledPublicJobs.publicJobs.filter((job) => job.status === "approval" && job.pendingApproval);
  const hasExecutableApproval = settledPublicJobs.buttons.includes("Approve once");
  const humanHandoff = outcome.humanSignal && approvalJobs.length === 0 && !hasExecutableApproval;
  const decision = decidePublicSubmitScenario({ mode: publicSubmitContract, humanHandoff });
  certificationReport.record("post-approval-public-submit", decision.status, decision.reason);
  if (decision.status === "failed") assert(false, decision.reason);
  if (humanHandoff) {
    assert(!hasExecutableApproval, `Human-only public-submit exposed an approval bypass: ${JSON.stringify(outcome)}`);
    assert(approvalJobs.length === 0, `Human-only public-submit created an executable approval job: ${JSON.stringify(outcome)}`);
    await waitForComposerReady(panel, "human-only public-submit handoff");
  } else {
    assert(hasExecutableApproval, `Legacy public-submit job approval is not visible: ${JSON.stringify(outcome)}`);
    assert(approvalJobs.length > 0, `Legacy public-submit pending approval is missing: ${JSON.stringify(outcome)}`);
    await evaluate(panel, `(() => {
      const deny = [...document.querySelectorAll("button")].find((button) =>
        button.textContent === "Deny" && /click "Submit public form"/i.test(button.title || "")
      );
      if (!deny) throw new Error("No per-job Deny button found.");
      deny.click();
    })()`);
    const deniedJob = await waitForBrowserJobTerminal(panel, /click "Submit public form"/i, "public-submit denial");
    assert(deniedJob.status === "denied", `Legacy public-submit job did not resolve as denied: ${JSON.stringify(deniedJob)}`);
    await waitForComposerReady(panel, "public-submit denial");
  }
  return blockedState;
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(request.url === "/calendar" ? calendarHtml : fixtureHtml);
});

await new Promise((resolve) => server.listen(fixturePort, "127.0.0.1", resolve));

const profile = path.join(os.tmpdir(), `resonantos-agent-live-${Date.now()}`);
const extensionPath = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension");

// Local bridge the extension talks to (run-browser-first.mjs is a compatibility
// shim that boots the minimal bridge on --bridge-port).
const host = spawn("node", [
  "browser-first/host/run-bridge-minimal.mjs",
  `--bridge-port=${bridgePort}`,
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});

let hostLogs = "";
host.stdout.on("data", (chunk) => { hostLogs += chunk.toString(); });
host.stderr.on("data", (chunk) => { hostLogs += chunk.toString(); });

let browserContext = null;
let panel = null;
let page = null;
let reportScreenshots = [];
let runError = null;

async function shutdownHost() {
  host.stdout.destroy();
  host.stderr.destroy();
  await browserContext?.close().catch(() => {});
  if (host.exitCode === null) host.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => host.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
  ]);
  if (!exited && host.exitCode === null) host.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

try {
  // #267: Playwright is launch-only. The CI workflow supplies stable Chrome and
  // an Xvfb display; local runs may use Playwright's Chromium. The raw-CDP body
  // below continues to drive the unpacked extension over the debug port.
  const launchOptions = {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
  if (process.env.RESONANTOS_LIVE_CHROME_PATH) {
    launchOptions.executablePath = process.env.RESONANTOS_LIVE_CHROME_PATH;
  }
  browserContext = await chromium.launchPersistentContext(profile, launchOptions);
  await (browserContext.pages()[0] ?? await browserContext.newPage())
    .goto(`http://127.0.0.1:${fixturePort}/`).catch(() => {});
  await waitForDebugPort(() => hostLogs);
  const panelTarget = await openExtensionPanel();
  const fixtureTarget = await waitForBrowserTarget(
    (target) => target.url === `http://127.0.0.1:${fixturePort}/`,
    "Fixture page target"
  );

  panel = new CdpClient(panelTarget.webSocketDebuggerUrl);
  page = new CdpClient(fixtureTarget.webSocketDebuggerUrl);
  await panel.connect();
  await page.connect();
  await panel.send("Runtime.enable");
  await page.send("Runtime.enable");
  await panel.send("Page.enable");
  await page.send("Page.enable");
  await evaluate(panel, `new Promise((resolve) => {
    const done = () => resolve(Boolean(document.querySelector("#command-input")));
    if (document.readyState === "complete") done();
    else addEventListener("load", done, { once: true });
  })`);
  const sidePanelReady = (await evaluate(panel, `new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (window.__resonantosSidePanelReady && document.querySelector("#command-input")) {
        resolve({ ready: true });
        return;
      }
      if (Date.now() - startedAt > 5000) {
        resolve({
          ready: false,
          documentReadyState: document.readyState,
          hasInput: Boolean(document.querySelector("#command-input")),
          marker: window.__resonantosSidePanelReady,
          error: window.__resonantosSidePanelReadyError || null,
          scripts: [...document.scripts].map((script) => script.src)
        });
        return;
      }
      setTimeout(check, 25);
    };
    check();
  })`)).result.value;
  assert(sidePanelReady.ready, `Side panel did not finish binding listeners: ${JSON.stringify(sidePanelReady)}`);

  await evaluate(panel, `chrome.storage.local.clear(); document.querySelector("#transcript").replaceChildren();`);
  await evaluate(panel, `chrome.storage.local.set({
    augmentorTaskConsents: Object.fromEntries(["booking", "shopping", "research", "form-edit"].map((taskClass) => [
      "127.0.0.1::" + taskClass,
      {
        siteKey: "127.0.0.1",
        taskClass,
        mode: "allow-safe",
        grantedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        reason: "Live deterministic test consent for safe non-sensitive actions.",
        source: "live-test"
      }
    ]))
  })`);
  const shortcutState = (await evaluate(panel, `(async () => {
    const input = document.querySelector("#command-input");
    const form = document.querySelector("#command-form");
    const originalRequestSubmit = form.requestSubmit.bind(form);
    let clipboardText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => clipboardText,
        writeText: async (value) => { clipboardText = value; },
      },
    });
    input.value = "first line";
    let submitted = false;
    form.requestSubmit = () => { submitted = true; };
    input.focus();
    input.setSelectionRange(0, 0);
    const metaA = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(metaA);
    const afterMetaA = {
      defaultPrevented: metaA.defaultPrevented,
      submitted,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      value: input.value,
    };

    const clipboardChecks = {};
    for (const key of ["c", "x", "v"]) {
      input.value = "first line";
      clipboardText = key === "v" ? "pasted" : "";
      input.setSelectionRange(0, key === "c" ? input.value.length : 5);
      const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
      clipboardChecks[key] = { defaultPrevented: event.defaultPrevented, submitted, value: input.value, clipboardText };
    }
    const fallbackClipboardChecks = {};
    for (const key of ["c", "x", "v"]) {
      input.value = "first line";
      clipboardText = key === "v" ? "pasted" : "";
      input.setSelectionRange(0, key === "c" ? input.value.length : 5);
      const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(event, "resonantosUseClipboardFallback", { value: true });
      input.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
      fallbackClipboardChecks[key] = { defaultPrevented: event.defaultPrevented, submitted, value: input.value, clipboardText };
    }

    input.value = "undo baseline";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "undo baseline plus";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    const afterMetaZ = { submitted, value: input.value };

    input.value = "enter test";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    const afterShiftEnter = { submitted, value: input.value };
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    const afterMetaEnter = { submitted, value: input.value };
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    form.requestSubmit = originalRequestSubmit;
    return { afterMetaA, clipboardChecks, fallbackClipboardChecks, afterMetaZ, afterShiftEnter, afterMetaEnter, submitted };
  })()`)).result.value;
  assert(shortcutState.afterMetaA.defaultPrevented, `Command+A should be handled by the composer: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.afterMetaA.selectionStart === 0, `Command+A should select from start: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.afterMetaA.selectionEnd === shortcutState.afterMetaA.value.length, `Command+A should select full composer text: ${JSON.stringify(shortcutState)}`);
  assert(!shortcutState.afterMetaA.submitted, `Command+A should not submit: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.clipboardChecks.c.defaultPrevented, `Command+C should use the governed composer clipboard path in the extension UI: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.clipboardChecks.c.clipboardText === "first line", `Command+C should copy selected composer text: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.clipboardChecks.x.defaultPrevented, `Command+X should use the governed composer clipboard path in the extension UI: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.clipboardChecks.x.clipboardText === "first", `Command+X should copy selected composer text: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.clipboardChecks.x.value === " line", `Command+X should remove selected composer text: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.clipboardChecks.v.defaultPrevented, `Command+V should use the governed composer clipboard path in the extension UI: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.clipboardChecks.v.value === "pasted line", `Command+V should paste clipboard text into selection: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.fallbackClipboardChecks.c.defaultPrevented, `Explicit Command+C fallback should use composer clipboard API: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.fallbackClipboardChecks.c.clipboardText === "first line", `Explicit Command+C fallback should copy selected composer text: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.fallbackClipboardChecks.x.defaultPrevented, `Explicit Command+X fallback should use composer clipboard API: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.fallbackClipboardChecks.x.clipboardText === "first", `Explicit Command+X fallback should copy selected composer text: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.fallbackClipboardChecks.x.value === " line", `Explicit Command+X fallback should remove selected composer text: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.fallbackClipboardChecks.v.defaultPrevented, `Explicit Command+V fallback should use composer clipboard API: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.fallbackClipboardChecks.v.value === "pasted line", `Explicit Command+V fallback should paste clipboard text into selection: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.afterMetaZ.value === "undo baseline", `Command+Z should undo the last composer edit: ${JSON.stringify(shortcutState)}`);
  assert(!shortcutState.afterShiftEnter.submitted, `Shift+Enter should not submit: ${JSON.stringify(shortcutState)}`);
  assert(!shortcutState.afterMetaEnter.submitted, `Command-modified Enter should not submit: ${JSON.stringify(shortcutState)}`);
  assert(shortcutState.submitted, `Enter should submit the composer: ${JSON.stringify(shortcutState)}`);
  await evaluate(panel, `document.querySelector("#command-input").value = ""; document.querySelector("#transcript").replaceChildren();`);
  if (liveProfile === "full") {
    await evaluate(panel, `document.querySelector("#read-page").click()`);
    await waitForPanelText(panel, /Page context attached:/, "initial content script attachment");
    await evaluate(panel, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === ${JSON.stringify(`http://127.0.0.1:${fixturePort}/`)});
      if (!tab?.id) throw new Error("Root fixture tab not found for inline assistant.");
      const response = await chrome.tabs.sendMessage(tab.id, {
        channel: "resonantos.browser_first.content",
        type: "show_inline_assistant_for_text",
        text: "This page verifies safe browser control, document-style typing, and approval gates.",
        rect: { left: 44, right: 520, top: 92, bottom: 116, width: 476, height: 24 }
      });
      if (!response?.ok) throw new Error(response?.error || "Inline assistant trigger failed.");
      return response;
    })()`);
    await waitForPageCondition(page, `document.querySelector("#resonantos-inline-button")?.style.display === "block"`, "inline assistant button");
    await evaluate(page, `document.querySelector("#resonantos-inline-button").click()`);
    const inlineSummary = await waitForPageCondition(page, `document.querySelector("#resonantos-inline-assistant .ros-inline-result")?.innerText.includes("Summary")`, "inline assistant summary");
    assert(inlineSummary, "Inline assistant did not produce a summary.");
    const inlinePromptPresent = (await evaluate(page, `Boolean(document.querySelector("#resonantos-inline-assistant .ros-inline-prompt"))`)).result.value;
    assert(inlinePromptPresent, "Inline Assistant custom prompt input is missing.");
    await evaluate(page, `document.querySelector('#resonantos-inline-assistant [data-action="send"]').click()`);
    await waitForPanelText(panel, /Inline Assistant context received\./, "inline send to side panel");
    const inlineInsertionState = (await evaluate(page, `(() => {
      const editor = document.querySelector("#inline-editor");
      editor.focus();
      const start = editor.value.indexOf("teh quick i");
      const end = start + "teh quick i".length;
      editor.setSelectionRange(start, end);
      editor.dispatchEvent(new Event("select", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    })()`)).result.value;
    assert(inlineInsertionState, "Inline editor selection setup failed.");
    await waitForPageCondition(page, `document.querySelector("#resonantos-inline-button")?.style.display === "block"`, "inline editable selection button");
    await evaluate(page, `document.querySelector("#resonantos-inline-button").click()`);
    await evaluate(page, `document.querySelector('#resonantos-inline-assistant [data-action="rewrite"]').click()`);
    await waitForPageCondition(page, `document.querySelector("#resonantos-inline-assistant .ros-inline-result")?.innerText.includes("the quick I")`, "inline rewrite result");
    const inlineShortcutLabels = (await evaluate(page, `Array.from(document.querySelectorAll("#resonantos-inline-assistant kbd")).map((node) => node.textContent).join("")`)).result.value;
    assert(/S/.test(inlineShortcutLabels) && /I/.test(inlineShortcutLabels), `Inline Assistant shortcuts are missing: ${inlineShortcutLabels}`);
    await evaluate(page, `document.querySelector('#resonantos-inline-assistant [data-action="insert"]').click()`);
    const inlineEditorValue = (await evaluate(page, `document.querySelector("#inline-editor").value`)).result.value;
    assert(inlineEditorValue === "prefix the quick I suffix", `Inline Assistant should replace only selected editable text: ${inlineEditorValue}`);
  } else {
    certificationReport.record(
      "provider-inline-assistant-flow",
      "excluded",
      "Excluded from the Agent Control CI profile because it requires provider behavior owned by a separate certification lane.",
    );
  }
  const dockCollapsedState = (await evaluate(panel, `({
    dockHidden: document.querySelector("#context-dock").hidden,
    siteHidden: document.querySelector("#site-permission-panel").hidden,
    jobsHidden: document.querySelector("#job-monitor").hidden,
    activityHidden: document.querySelector("#activity-panel").hidden,
    toggle: document.querySelector("#context-toggle").textContent
  })`)).result.value;
  assert(dockCollapsedState.siteHidden && dockCollapsedState.jobsHidden, `Site/jobs panels should be hidden by default: ${JSON.stringify(dockCollapsedState)}`);
  await evaluate(panel, `document.querySelector("#context-toggle").click()`);
  const sitePanelState = await waitForPageCondition(panel, `(() => {
    const state = {
      visible: !document.querySelector("#site-permission-panel").hidden,
      host: document.querySelector("#site-permission-host").textContent,
      mode: document.querySelector("#site-permission-mode").value
    };
    return state.visible && state.host === "127.0.0.1" ? state : false;
  })()`, "site permission panel binding");
  assert(sitePanelState.visible && sitePanelState.host === "127.0.0.1", `Site permission panel not bound: ${JSON.stringify(sitePanelState)}`);
  const sitePanelMode = (await evaluate(panel, `({
    visible: !document.querySelector("#site-permission-panel").hidden,
    host: document.querySelector("#site-permission-host").textContent,
    mode: document.querySelector("#site-permission-mode").value
  })`)).result.value;
  assert(sitePanelMode.mode, `Site permission panel mode missing: ${JSON.stringify(sitePanelMode)}`);
  await submitControlCommand(panel, `/capabilities`);
  await waitForPanelText(panel, /What Augmentor can do now:/, "capabilities command");
  await submitControlCommand(panel, `/wallet status`);
  await waitForPanelText(panel, /Wallet status[\s\S]*Phantom Solana: (connected|available, not connected)[\s\S]*read-only detection/, "wallet status command");
  await submitControlCommand(panel, `/dao review the governance action`);
  await waitForPanelText(
    panel,
    /DAO workflow helper[\s\S]*Connect Wallet[\s\S]*Vote For[\s\S]*Against[\s\S]*Execute Proposal[\s\S]*Treasury recipient[\s\S]*\/wallet status[\s\S]*Risk checklist:[\s\S]*quorum\/threshold[\s\S]*will not click wallet connect, sign, vote, submit, transfer, or transaction confirmation/,
    "dao workflow helper"
  );
  await submitControlCommand(panel, `/wallet audit`);
  await waitForPanelText(panel, /Saved a wallet\/DAO audit to Living Archive intake[\s\S]*Wallet connect, signing, voting, transfer, transaction confirmation, and public submission remain human-only/, "wallet audit command");
  await submitControlCommand(panel, `/dao audit review the governance action`);
  await waitForPanelText(panel, /Saved a wallet\/DAO audit to Living Archive intake[\s\S]*read-only evidence/, "dao audit command");
  await submitControlCommand(panel, `/site block`);
  await waitForPanelText(panel, /Set 127\.0\.0\.1 Assistant permission to blocked/, "site block command");
  const blockedSiteMode = (await evaluate(panel, `document.querySelector("#site-permission-mode").value`)).result.value;
  assert(blockedSiteMode === "blocked", `Site permission select did not reflect blocked mode: ${blockedSiteMode}`);
  await evaluate(page, `(() => {
    const paragraph = document.querySelector("p");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const inlineBlocked = (await evaluate(page, `document.querySelector("#resonantos-inline-button")?.style.display !== "block"`)).result.value;
  assert(inlineBlocked, "Site block did not hide Inline Assistant.");
  await submitControlCommand(panel, `/site ask`);
  await waitForPanelText(panel, /Set 127\.0\.0\.1 Assistant permission to ask-before-action/, "site ask command");

  const iframeReadState = (await evaluate(panel, `(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === ${JSON.stringify(`http://127.0.0.1:${fixturePort}/`)});
    if (!tab?.id) return { error: "Fixture tab not found." };
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const responses = [];
    for (const frame of frames) {
      const response = await chrome.tabs.sendMessage(tab.id, {
        channel: "resonantos.browser_first.content",
        type: "read_page"
      }, { frameId: frame.frameId }).catch((error) => ({ ok: false, error: String(error) }));
      responses.push({
        frameId: frame.frameId,
        ok: Boolean(response?.ok),
        text: String(response?.snapshot?.text ?? "").slice(0, 240),
        error: response?.error ?? null
      });
    }
    return { tabId: tab.id, frames, responses };
  })()`)).result.value;
  assert(
    iframeReadState.responses?.some((response) => response.ok && response.text.includes("Booking calendar frame")),
    `Direct frame read did not expose booking context: ${JSON.stringify(iframeReadState)}`,
  );
  const blockedState = await verifyPublicSubmitBoundary(panel, page);

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async ({ snapshot, history }) => ({
    source: "test-next-action",
    thought: "Verify iframe context is visible to the browser-control loop.",
    status: snapshot?.text?.includes("Booking calendar frame") ? (history.length ? "done" : "continue") : "blocked",
    action: snapshot?.text?.includes("Booking calendar frame") && !history.length ? { type: "read" } : null,
    approvalReason: snapshot?.text?.includes("Booking calendar frame") ? null : "Iframe booking context was not visible.",
    doneSummary: history.length ? "Iframe booking context was observed." : null
  }); return true; })()`);
  await submitControlCommand(panel, `book a call now`);
  try {
    await waitForPageCondition(page, `document.querySelector("#resonantos-control-overlay")?.dataset.session === "active"`, "persistent control overlay session start");
  } catch (error) {
    const panelText = (await evaluate(panel, "document.body.innerText")).result.value;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nPanel text:\n${panelText}`);
  }
  const iframePanelText = await waitForPanelText(panel, /Booking calendar frame|Iframe booking context was not visible/, "iframe context read");
  assert(!/Iframe booking context was not visible/.test(iframePanelText), "Agent planner could not see iframe booking context.");
  await waitForComposerReady(panel, "iframe context read");
  await waitForPageCondition(page, `document.querySelector("#resonantos-control-overlay")?.dataset.session !== "active"`, "persistent control overlay session stop");
  const firstJobState = (await evaluate(panel, `(async () => ({
    monitorVisible: !document.querySelector("#job-monitor").hidden,
    stored: (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [],
    panelText: document.querySelector("#job-monitor").innerText
  }))()`)).result.value;
  assert(firstJobState.monitorVisible, "Browser job monitor is not visible after a control task.");
  assert(firstJobState.stored.some((job) => job.goal === "book a call now"), `Browser job did not persist: ${JSON.stringify(firstJobState)}`);
  const bookingJob = firstJobState.stored.find((job) => job.goal === "book a call now");
  assert(bookingJob?.preflightDecision?.mode === "skipped-by-consent", `Browser job did not persist preflight mode: ${JSON.stringify(bookingJob)}`);
  assert(bookingJob?.preflightDecision?.taskClass === "booking", `Browser job did not persist preflight task class: ${JSON.stringify(bookingJob)}`);
  const trustedTaskConsent = (await evaluate(panel, `(async () => (await chrome.storage.local.get("augmentorTaskConsents")).augmentorTaskConsents ?? {})()`)).result.value;
  assert(Object.values(trustedTaskConsent).some((consent) => consent.siteKey === "127.0.0.1" && consent.taskClass === "booking" && consent.source === "live-test"), `Live test task consent did not persist: ${JSON.stringify(trustedTaskConsent)}`);
  await submitControlCommand(panel, `/jobs`);
  await waitForPanelText(panel, /Browser jobs:/, "jobs command");
  await submitControlCommand(panel, `/pause book a call`);
  await waitForPanelText(panel, /Paused browser job/, "pause job command");
  await submitControlCommand(panel, `/resume book a call`);
  await waitForPanelText(panel, /Queued browser job/, "resume job command");
  await submitControlCommand(panel, `/cancel book a call`);
  await waitForPanelText(panel, /Cancelled browser job/, "cancel job command");
  const persistedAfterCancel = (await evaluate(panel, `(async () => (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [])()`)).result.value;
  assert(persistedAfterCancel.some((job) => job.goal === "book a call now" && job.status === "cancelled"), "Cancelled job state did not persist.");
  await panel.send("Page.reload");
  await evaluate(panel, `new Promise((resolve) => {
    const done = () => resolve(Boolean(document.querySelector("#command-input")));
    if (document.readyState === "complete") done();
    else addEventListener("load", done, { once: true });
  })`);
  await waitForPanelText(panel, /book a call now/, "job monitor persisted after panel reload");

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async ({ history }) => ({
    source: "test-next-action",
    thought: history.length ? "The appointment slot is selected." : "Select the visible appointment slot inside the booking frame.",
    status: history.length ? "done" : "continue",
    action: history.length ? null : { type: "click", text: "Tuesday 10:00" },
    approvalReason: null,
    doneSummary: history.length ? "Selected the visible Tuesday 10:00 appointment slot." : null
  }); return true; })()`);
  await submitControlCommand(panel, `Can you arrange a call from this booking page?`);
  let bookingState = null;
  for (let index = 0; index < 80; index += 1) {
    bookingState = (await evaluate(page, `({
      slot: document.querySelector("iframe").contentDocument.body.dataset.slot || "",
      status: document.querySelector("#status").textContent
    })`)).result.value;
    if (bookingState.slot === "Tuesday 10:00") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(bookingState.slot === "Tuesday 10:00", `Variant booking prompt failed: ${JSON.stringify(bookingState)}`);
  const overlayAfterClick = (await evaluate(page, `({
    overlayPresent: Boolean(document.querySelector("#resonantos-control-overlay")),
    session: document.querySelector("#resonantos-control-overlay")?.dataset.session ?? "",
    toastText: document.querySelector("#resonantos-control-toast")?.textContent ?? "",
    highlighted: Boolean(document.querySelector(".resonantos-control-target"))
  })`)).result.value;
  assert(overlayAfterClick.overlayPresent, `Agent control overlay was not injected: ${JSON.stringify(overlayAfterClick)}`);
  assert(
    overlayAfterClick.session === "active" ||
      overlayAfterClick.highlighted ||
      /Clicked|Clicking|Tuesday|Reading page context/i.test(overlayAfterClick.toastText),
    `Agent control overlay did not expose action feedback: ${JSON.stringify(overlayAfterClick)}`
  );
  await waitForComposerReady(panel, "variant booking prompt");
  await waitForBrowserJobTerminal(panel, /Can you arrange a call from this booking page/i, "variant booking prompt");

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async ({ snapshot, history }) => {
    const cartRef = snapshot?.controls?.find((control) => control.text === "Add to Cart")?.ref;
    if (!history.length) {
      return {
        source: "test-next-action",
        thought: "Use the observed cart button ref.",
        status: cartRef ? "continue" : "blocked",
        action: cartRef ? { type: "click", ref: cartRef, text: "Add to Cart" } : null,
        approvalReason: cartRef ? null : "Cart button ref was not visible.",
        doneSummary: null
      };
    }
    return {
      source: "test-next-action",
      thought: "Cart action is complete.",
      status: "done",
      action: null,
      approvalReason: null,
      doneSummary: "Added the visible item to cart."
    };
  }; return true; })()`);
  await submitControlCommand(panel, `add the visible item on this page to the cart`);
  let cartState = null;
  for (let index = 0; index < 80; index += 1) {
    cartState = (await evaluate(page, `({
      cart: document.body.dataset.cart || "",
      status: document.querySelector("#status").textContent
    })`)).result.value;
    if (cartState.cart === "added") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (cartState.cart !== "added") {
    const cartDebug = {
      cartState,
      pageUrl: (await evaluate(page, `location.href`)).result.value,
      panelText: (await evaluate(panel, `document.body.innerText`)).result.value,
      jobs: (await evaluate(panel, `(async () => (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [])()`)).result.value
    };
    assert(false, `Current-page cart prompt failed: ${JSON.stringify(cartDebug, null, 2)}`);
  }
  await waitForComposerReady(panel, "current-page cart prompt");
  await waitForBrowserJobTerminal(panel, /add the visible item on this page/i, "current-page cart prompt");
  await evaluate(panel, `(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === ${JSON.stringify(`http://127.0.0.1:${fixturePort}/`)});
    if (!tab?.id) throw new Error("Root fixture tab not found before safe control checks.");
    await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  })()`);

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async ({ snapshot, history }) => {
    const safeRef = snapshot?.controls?.find((control) => control.text === "Safe Details")?.ref;
    const actions = [
      { type: "read" },
      { type: "click", ref: safeRef, text: "Safe Details" },
      { type: "type", field: "Search field", text: "find resonantos", submit: false },
      { type: "scroll", direction: "down" }
    ];
    const action = actions[history.length] ?? null;
    return {
      source: "test-next-action",
      thought: action ? "Execute next safe fixture action." : "Safe fixture actions are complete.",
      status: action && (action.type !== "click" || action.ref) ? "continue" : action ? "blocked" : "done",
      action,
      approvalReason: action ? "Required element ref was not present in the observation." : null,
      doneSummary: action ? null : "Read, clicked, typed, and scrolled safely."
    };
  }; return true; })()`);
  await submitControlCommand(panel, `/control read this page, click "Safe Details", type "find resonantos", scroll down @ResonantOS Agent Fixture`);
  let safeState = null;
  for (let index = 0; index < 100; index += 1) {
    safeState = (await evaluate(page, `({
      details: document.querySelector("#details").textContent,
      input: document.querySelector("input[name='search']").value,
      scrollY: window.scrollY,
      submitted: window.__submitted,
      doc: document.querySelector("#doc").textContent
    })`)).result.value;
    if (safeState.details === "safe details opened" && safeState.input === "find resonantos" && safeState.scrollY > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await waitForPanelText(panel, /Agent Control Mode completed\./, "safe control completion");
  await waitForComposerReady(panel, "safe control");
  const safePanelText = (await evaluate(panel, "document.body.innerText")).result.value;
  assert(safeState.details === "safe details opened", `Safe click failed: ${JSON.stringify(safeState)}\nPanel:\n${safePanelText}`);
  assert(safeState.input === "find resonantos", `Typing failed: ${JSON.stringify(safeState)}`);
  assert(safeState.scrollY > 0, `Scroll failed: ${JSON.stringify(safeState)}`);
  assert(!safeState.submitted, `Unexpected public submit: ${JSON.stringify(safeState)}`);
  await waitForBrowserJobTerminal(panel, /read this page, click "Safe Details"/i, "safe control");

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async ({ history }) => ({
    source: "test-next-action",
    thought: history.length ? "Document typing is complete." : "Type into a document-like contenteditable region.",
    status: history.length ? "done" : "continue",
    action: history.length ? null : { type: "type", text: "ResonantOS wrote this draft.", field: "Draft document", submit: false },
    approvalReason: null,
    doneSummary: history.length ? "Document region updated." : null
  }); return true; })()`);
  await submitControlCommand(panel, `/control type into the draft document`);
  let documentState = null;
  for (let index = 0; index < 80; index += 1) {
    documentState = (await evaluate(page, `({ doc: document.querySelector("#doc").textContent })`)).result.value;
    if (documentState.doc === "ResonantOS wrote this draft.") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const documentPanelText = (await evaluate(panel, "document.body.innerText")).result.value;
  assert(documentState.doc === "ResonantOS wrote this draft.", `Document-like typing failed: ${JSON.stringify(documentState)}\nPanel:\n${documentPanelText}`);
  await waitForComposerReady(panel, "document typing");
  await waitForBrowserJobTerminal(panel, /type into the draft document/i, "document typing");

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async () => ({
    source: "test-next-action",
    thought: "Attempt contact autofill; content boundary must block automation.",
    status: "continue",
    action: { type: "type", text: "person@example.com", field: "Email address", submit: false },
    approvalReason: null,
    doneSummary: null
  }); return true; })()`);
  await submitControlCommand(panel, `/control fill the email address`);
  await waitForPanelText(panel, /Personal contact fields require a human-controlled autofill flow|Agent Control Mode blocked/i, "contact autofill boundary");
  const contactBlockedState = (await evaluate(page, `({
    email: document.querySelector("input[name='email']").value,
    password: document.querySelector("input[name='password']").value,
    card: document.querySelector("input[name='card']").value
  })`)).result.value;
  assert(contactBlockedState.email === "", `Contact autofill should be blocked before typing: ${JSON.stringify(contactBlockedState)}`);
  await waitForComposerReady(panel, "contact autofill boundary");
  const contactBoundaryJob = await waitForBrowserJobTerminal(panel, /fill the email address/i, "contact autofill boundary");
  assert(contactBoundaryJob.status === "blocked", `Contact autofill job should stop as blocked: ${JSON.stringify(contactBoundaryJob)}`);

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async () => ({
    source: "test-next-action",
    thought: "Attempt payment autofill; content boundary must block automation.",
    status: "continue",
    action: { type: "type", text: "4111111111111111", field: "Card number", submit: false },
    approvalReason: null,
    doneSummary: null
  }); return true; })()`);
  await submitControlCommand(panel, `/control fill the card number`);
  await waitForPanelText(panel, /Payment and wallet fields are human-only|Agent Control Mode blocked/i, "payment autofill boundary");
  const paymentBlockedState = (await evaluate(page, `({
    email: document.querySelector("input[name='email']").value,
    password: document.querySelector("input[name='password']").value,
    card: document.querySelector("input[name='card']").value
  })`)).result.value;
  assert(paymentBlockedState.card === "", `Payment autofill should be blocked before typing: ${JSON.stringify(paymentBlockedState)}`);
  await waitForComposerReady(panel, "payment autofill boundary");
  const paymentBoundaryJob = await waitForBrowserJobTerminal(panel, /fill the card number/i, "payment autofill boundary");
  assert(paymentBoundaryJob.status === "blocked", `Payment autofill job should stop as blocked: ${JSON.stringify(paymentBoundaryJob)}`);

  await evaluate(panel, `(() => { globalThis.__resonantosNextActionOverride = async () => ({
    source: "test-next-action",
    thought: "Attempt wallet click; content boundary must block automation.",
    status: "continue",
    action: { type: "click", text: "Connect Wallet" },
    approvalReason: null,
    doneSummary: null
  }); return true; })()`);
  await submitControlCommand(panel, `/control connect wallet`);
  await waitForPanelText(panel, /Planner requested a restricted click|wallet, login, payment, credential/i, "wallet approval boundary");
  const walletApprovalState = (await evaluate(panel, `({
    cardVisible: !document.querySelector("#approval-card").hidden,
    status: document.querySelector("#status")?.textContent ?? ""
  })`)).result.value;
  assert(!walletApprovalState.cardVisible, `Wallet/payment/login planner blocks must not expose an approval bypass: ${JSON.stringify(walletApprovalState)}`);
  const approvalState = (await evaluate(page, `({ submitted: window.__submitted, status: document.querySelector("#status").textContent })`)).result.value;
  assert(approvalState.status !== "wallet-clicked", `Wallet action executed unexpectedly: ${JSON.stringify(approvalState)}`);

  await mkdir(artifactDir, { recursive: true });
  reportScreenshots = [
    await captureScreenshotArtifact(panel, path.join(artifactDir, "panel.png")),
    await captureScreenshotArtifact(page, path.join(artifactDir, "page.png")),
  ];

  console.log(JSON.stringify({
    ok: true,
    iframeContextVisible: true,
    bookingState,
    cartState,
    safeState,
    documentState,
    blockedState,
    approvalState,
    screenshots: reportScreenshots.map((screenshot) => ({
      ...screenshot,
      path: screenshot.path ? path.basename(screenshot.path) : null,
    })),
  }, null, 2));
} catch (error) {
  runError = error;
  certificationReport.record(
    "run-terminal",
    "failed",
    error instanceof Error ? error.message : String(error),
  );
  throw error;
} finally {
  await mkdir(artifactDir, { recursive: true });
  if (reportScreenshots.length === 0) {
    reportScreenshots = await Promise.all([
      panel
        ? captureScreenshotArtifact(panel, path.join(artifactDir, "panel.png"))
        : Promise.resolve({ ok: false, path: "panel.png", error: "Panel target was unavailable." }),
      page
        ? captureScreenshotArtifact(page, path.join(artifactDir, "page.png"))
        : Promise.resolve({ ok: false, path: "page.png", error: "Fixture target was unavailable." }),
    ]);
  }
  const hasGate = certificationReport.scenarios.some((scenario) => scenario.status === "gated");
  await certificationReport.write({
    status: runError ? "failed" : hasGate ? "passed-with-gates" : "passed",
    screenshots: reportScreenshots,
    error: runError,
    metadata: {
      commit: process.env.GITHUB_SHA ?? "local",
      publicSubmitContract,
    },
  });
  panel?.close();
  page?.close();
  await shutdownHost();
  await new Promise((resolve) => server.close(resolve));
}
