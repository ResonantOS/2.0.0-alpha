import http from "node:http";
import os from "node:os";
import path from "node:path";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";

export const resonantExtensionId = "cdpdmmalhmokbfcfgogoepnjplaakgnl";

export async function freeLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isInteger(port) || port < 1024) {
    throw new Error("Could not allocate an ephemeral loopback port.");
  }
  return port;
}

export async function stageExtensionCopy(repoRoot) {
  const source = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension");
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-extension-stage-"));
  const extensionRoot = path.join(root, "resonantos-side-panel-extension");
  await cp(source, extensionRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const relative = path.relative(source, sourcePath);
      if (!relative) return true;
      if (relative === "node_modules" || relative.startsWith(`node_modules${path.sep}`)) return false;
      return relative !== path.join("src", "bridge-config.generated.js");
    },
  });
  return {
    root,
    extensionRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export class CdpClient {
  constructor(url, { timeoutMs = 10_000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
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
        return;
      }
      if (message.method && this.listeners.has(message.method)) {
        for (const listener of this.listeners.get(message.method)) {
          listener(message.params ?? {});
        }
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
      },
    }));
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        this.pending.delete(id);
        const expression = typeof params.expression === "string"
          ? ` expression=${JSON.stringify(params.expression.slice(0, 220))}`
          : "";
        reject(new Error(`CDP ${method} timed out after ${this.timeoutMs}ms.${expression}`));
      }, this.timeoutMs);
    });
    return Promise.race([response, timeout]);
  }

  close() {
    this.ws?.close();
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }
}

export async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "CDP evaluation failed.",
    );
  }
  return result;
}

export async function launchExtensionContext({
  repoRoot,
  debugPort,
  profile = path.join(os.tmpdir(), `resonantos-live-profile-${Date.now()}`),
  executablePath = process.env.RESONANTOS_LIVE_CHROME_PATH,
  extensionPath = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension"),
} = {}) {
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
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  const browserContext = await chromium.launchPersistentContext(profile, launchOptions);
  return { browserContext, extensionPath, profile };
}

export function createLivePanelHarness({
  debugPort,
  extensionId = resonantExtensionId,
  cdpTimeoutMs = 10_000,
} = {}) {
  const sidePanelPageUrl = `chrome-extension://${extensionId}/src/side-panel.html`;

  async function browserTargets() {
    return fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
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

  async function waitForSidePanelReady(panel, label, timeoutMs = 8000) {
    let lastError = null;
    let consecutiveErrors = 0;
    let blankPolls = 0;
    const deadline = Date.now() + timeoutMs;
    for (let index = 0; index < 80; index += 1) {
      try {
        const state = (await evaluate(panel, `(() => {
          const errorPage = location.href.startsWith("chrome-error://");
          return {
            ready: Boolean(window.__resonantosSidePanelReady && document.querySelector("#command-input")),
            errorPage,
            errorText: errorPage ? (document.body?.innerText?.slice(0, 160) ?? "") : null,
            readyState: document.readyState,
            hasInput: Boolean(document.querySelector("#command-input")),
            marker: window.__resonantosSidePanelReady ?? null,
            scripts: [...document.scripts].map((script) => script.src)
          };
        })()`)).result.value;
        if (state.ready) return { ready: true };
        if (state.errorPage) return { ready: false, errorPage: true, text: state.errorText ?? "" };
        consecutiveErrors = 0;
        if (state.readyState === "complete" && !state.hasInput) {
          blankPolls += 1;
          if (blankPolls >= 12) {
            return { ready: false, reason: "complete page never bound the composer", ...state };
          }
        } else {
          blankPolls = 0;
        }
        if (Date.now() >= deadline) {
          return { ready: false, reason: `readiness window of ${timeoutMs}ms elapsed`, ...state };
        }
      } catch (error) {
        lastError = error;
        consecutiveErrors += 1;
        if (consecutiveErrors >= 2) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const state = (await evaluate(panel, `(() => ({
      errorPage: location.href.startsWith("chrome-error://"),
      readyState: document.readyState,
      hasInput: Boolean(document.querySelector("#command-input")),
      marker: window.__resonantosSidePanelReady ?? null,
      error: window.__resonantosSidePanelReadyError || null,
      scripts: [...document.scripts].map((script) => script.src)
    }))()`).catch(() => ({ error: lastError instanceof Error ? lastError.message : String(lastError) }))).result?.value ?? {};
    throw new Error(`${label} did not finish binding listeners: ${JSON.stringify(state)}`);
  }

  async function connectToReadyPanelTarget() {
    const rejectedTargets = new Set();
    for (let index = 0; index < 80; index += 1) {
      const targets = await browserTargets().catch(() => []);
      const candidates = targets.filter(
        (target) => target.url === sidePanelPageUrl && target.webSocketDebuggerUrl && !rejectedTargets.has(target.id),
      );
      for (const candidate of candidates) {
        const probe = new CdpClient(candidate.webSocketDebuggerUrl, { timeoutMs: cdpTimeoutMs });
        try {
          await probe.connect();
          await probe.send("Runtime.enable");
          await probe.send("Page.enable");
          const ready = await waitForSidePanelReady(probe, "side panel readiness", 5000);
          if (ready.ready) return probe;
          probe.close();
        } catch {
          probe.close();
        }
        rejectedTargets.add(candidate.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  async function openExtensionPanel() {
    let lastError = null;
    let created = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      created = await fetch(
        `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(sidePanelPageUrl)}`,
        { method: "PUT" },
      ).then((response) => response.json());
      const panel = await connectToReadyPanelTarget();
      if (panel) return panel;
      lastError = new Error("no side-panel target bound the composer within the discovery window");
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${created?.id}`, { method: "PUT" }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error(`Could not open the ResonantOS side panel after 3 attempts.\n${String(lastError)}`);
  }

  async function waitForBrowserTarget(predicate, label) {
    for (let index = 0; index < 80; index += 1) {
      const targets = await browserTargets();
      const target = targets.find(predicate);
      if (target?.webSocketDebuggerUrl) return target;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const targets = await browserTargets().catch(() => []);
    throw new Error(`${label} did not appear in CDP targets.\nTargets:\n${JSON.stringify(targets, null, 2)}`);
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

  return {
    browserTargets,
    openExtensionPanel,
    sidePanelPageUrl,
    waitForBrowserTarget,
    waitForDebugPort,
    waitForPanelText,
    waitForSidePanelReady,
  };
}

export async function captureScreenshotArtifact(client, filePath) {
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
