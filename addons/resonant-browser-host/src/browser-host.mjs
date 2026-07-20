// Intent citation: docs/architecture/ADR-017-resonant-browser-addon.md
// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertContained } from "./lib/path-contains.mjs";

const DEFAULT_HOME_URL = "https://resonantos.com";
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const DEFAULT_CHROMIUM_ARGS = ["--password-store=basic", "--use-mock-keychain"];
const MAX_TEXT_CHARS = 12000;
const MAX_LINKS = 80;

const nowIso = () => new Date().toISOString();

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveChromiumLaunchOptions({ headless = true, params = {}, env = process.env } = {}) {
  const executablePath =
    optionalString(params.executablePath) ?? optionalString(env.RESONANTOS_BROWSER_HOST_EXECUTABLE_PATH);
  const channel = optionalString(params.browserChannel) ?? optionalString(env.RESONANTOS_BROWSER_HOST_CHANNEL);
  const launchOptions = {
    headless,
    args: DEFAULT_CHROMIUM_ARGS,
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  } else if (channel) {
    launchOptions.channel = channel;
  }

  return launchOptions;
}

function createSessionId() {
  return `browser-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function assertSafeHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Browser host only accepts valid http or https URLs.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser host only accepts http and https URLs.");
  }

  return parsed.toString();
}

function sanitizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

export class ResonantBrowserHost {
  constructor(options = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sessionId = null;
    this.audit = [];
    this.headless = options.headless ?? true;
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
  }

  isReady() {
    return Boolean(this.browser && this.context && this.page && this.sessionId);
  }

  record(event, details = {}) {
    const entry = {
      at: nowIso(),
      event,
      sessionId: this.sessionId,
      details,
    };
    this.audit.push(entry);
    return entry;
  }

  recentAudit() {
    return this.audit.slice(-60);
  }

  async start(params = {}) {
    if (this.isReady()) {
      return this.health();
    }

    const defaultUrl = assertSafeHttpUrl(params.defaultUrl ?? DEFAULT_HOME_URL);
    this.headless = params.headless ?? this.headless;
    this.sessionId = createSessionId();
    const launchOptions = resolveChromiumLaunchOptions({ headless: this.headless, params });
    this.browser = await chromium.launch(launchOptions);
    this.context = await this.browser.newContext({
      viewport: params.viewport ?? this.viewport,
      deviceScaleFactor: 1,
    });
    this.page = await this.context.newPage();
    this.record("session.started", {
      engine: "chromium",
      headless: this.headless,
      channel: launchOptions.channel ?? null,
      executablePathConfigured: Boolean(launchOptions.executablePath),
    });
    await this.openUrl({ url: defaultUrl });
    return this.health();
  }

  requirePage() {
    if (!this.page || !this.sessionId) {
      throw new Error("Browser session is not started.");
    }
    return this.page;
  }

  async openUrl(params = {}) {
    const page = this.requirePage();
    const url = assertSafeHttpUrl(params.url ?? DEFAULT_HOME_URL);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: params.timeoutMs ?? 30000 });
    await page.waitForLoadState("networkidle", { timeout: params.networkIdleTimeoutMs ?? 8000 }).catch(() => undefined);
    const title = await page.title();
    const finalUrl = page.url();
    const status = response?.status() ?? null;
    this.record("page.opened", { requestedUrl: url, finalUrl, title, status });
    return {
      sessionId: this.sessionId,
      finalUrl,
      title,
      status,
      audit: this.recentAudit(),
    };
  }

  async readPage(params = {}) {
    const page = this.requirePage();
    if (params.selector) {
      await page.locator(params.selector).first().waitFor({ timeout: params.timeoutMs ?? 5000 });
    }
    const result = await page.evaluate(
      ({ selector, maxTextChars, maxLinks }) => {
        const root = selector ? document.querySelector(selector) : document.body;
        const text = (root?.innerText ?? document.body?.innerText ?? "").slice(0, maxTextChars);
        const links = Array.from(document.querySelectorAll("a[href]"))
          .slice(0, maxLinks)
          .map((link) => ({
            label: link.textContent?.replace(/\s+/g, " ").trim().slice(0, 160) ?? "",
            href: link.href,
          }));
        return { text, links };
      },
      { selector: params.selector, maxTextChars: MAX_TEXT_CHARS, maxLinks: MAX_LINKS },
    );
    const payload = {
      sessionId: this.sessionId,
      finalUrl: page.url(),
      title: await page.title(),
      text: sanitizeText(result.text),
      links: result.links,
      audit: this.recentAudit(),
    };
    this.record("page.read", { url: payload.finalUrl, selector: params.selector ?? null, textChars: payload.text.length });
    return { ...payload, audit: this.recentAudit() };
  }

  async click(params = {}) {
    const page = this.requirePage();
    if (params.selector) {
      await page.locator(params.selector).first().click({ timeout: params.timeoutMs ?? 8000 });
      this.record("page.clicked", { selector: params.selector });
    } else if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
      await page.mouse.click(params.x, params.y);
      this.record("page.clicked", { x: params.x, y: params.y });
    } else {
      throw new Error("Click requires either selector or x/y coordinates.");
    }
    return {
      sessionId: this.sessionId,
      finalUrl: page.url(),
      title: await page.title(),
      audit: this.recentAudit(),
    };
  }

  async type(params = {}) {
    const page = this.requirePage();
    if (!params.selector) {
      throw new Error("Type requires a selector.");
    }
    if (typeof params.text !== "string") {
      throw new Error("Type requires text.");
    }
    const locator = page.locator(params.selector).first();
    await locator.fill(params.text, { timeout: params.timeoutMs ?? 8000 });
    this.record("page.typed", { selector: params.selector, chars: params.text.length, sensitive: Boolean(params.sensitive) });
    return {
      sessionId: this.sessionId,
      finalUrl: page.url(),
      title: await page.title(),
      audit: this.recentAudit(),
    };
  }

  async captureEvidence(params = {}) {
    const page = this.requirePage();
    if (!params.artifactsDir) {
      throw new Error("Evidence capture requires artifactsDir.");
    }
    // P1-d containment: the screenshot leaf must resolve INSIDE the realpath of
    // the caller-declared artifactsDir. A `..` chain, an absolute reroot, or a
    // symlink that escapes the artifacts root is refused before any FS write.
    const artifactsRoot = params.artifactsDir.replace(/\/$/, "");
    const path = `${artifactsRoot}/${this.sessionId}-${Date.now()}.png`;
    assertContained(artifactsRoot, path, "evidence screenshot");
    await page.screenshot({ path, fullPage: Boolean(params.fullPage) });
    this.record("evidence.captured", { path, reason: params.reason ?? "unspecified" });
    return {
      sessionId: this.sessionId,
      evidenceRef: path,
      audit: this.recentAudit(),
    };
  }

  async health() {
    return {
      ready: this.isReady(),
      sessionId: this.sessionId,
      engine: "chromium",
      headless: this.headless,
      url: this.page ? this.page.url() : null,
      audit: this.recentAudit(),
    };
  }

  async close() {
    const sessionId = this.sessionId;
    if (this.browser) {
      await this.browser.close();
    }
    this.record("session.closed", { sessionId });
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sessionId = null;
    return {
      sessionId,
      closed: true,
      audit: this.recentAudit(),
    };
  }
}

const methodMap = {
  "browser.start": "start",
  "browser.open_url": "openUrl",
  "browser.read_page": "readPage",
  "browser.click": "click",
  "browser.type": "type",
  "browser.capture_evidence": "captureEvidence",
  "browser.close": "close",
  "browser.close_session": "close",
  "browser.health": "health",
};

export async function handleJsonRpcLine(host, line) {
  const request = JSON.parse(line);
  const method = methodMap[request.method];
  if (!method || typeof host[method] !== "function") {
    throw new Error(`Unknown browser host method: ${request.method}`);
  }
  return {
    id: request.id ?? null,
    result: await host[method](request.params ?? {}),
  };
}

async function runStdioServer() {
  const host = new ResonantBrowserHost({ headless: true });
  const input = createInterface({ input: process.stdin, terminal: false });

  for await (const line of input) {
    if (!line.trim()) {
      continue;
    }
    try {
      const response = await handleJsonRpcLine(host, line);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          id: null,
          error: { message: error instanceof Error ? error.message : String(error) },
        })}\n`,
      );
    }
  }

  await host.close().catch(() => undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
