import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Render the actual extension modules and complete CSS cascade with fixture data.
// This is a presentation regression check, not bridge/extension certification.
const extensionRoot = path.resolve(import.meta.dirname, "../resonantos-side-panel-extension");
const artifacts = process.env.RESONANTOS_SETTINGS_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), `resonantos-settings-shapes-${process.pid}`);
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Settings shape fixtures</title><link rel="stylesheet" href="/src/main-workspace.css"><body><main id="root"></main><button id="outside">Outside Settings</button></body></html>';
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
      return;
    }
    const file = path.resolve(extensionRoot, `.${pathname}`);
    if (!file.startsWith(`${extensionRoot}${path.sep}`)
      || !/\.(?:css|js)$/.test(file) || file.endsWith("bridge-config.generated.js")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": file.endsWith(".css") ? "text/css" : "text/javascript" });
    response.end(await readFile(file));
  } catch {
    response.end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({
    // CI has no interactive desktop; use Chrome's native headless compositor.
    headless: /^(?:1|true)$/i.test(process.env.CI ?? ""),
    ...(process.env.RESONANTOS_LIVE_CHROME_PATH
      ? { executablePath: process.env.RESONANTOS_LIVE_CHROME_PATH }
      : { channel: "chrome" }),
  });
  const page = await browser.newPage();
  // No provider, bridge or public-network access is needed for these fixtures.
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route("**/*", route => route.request().url().startsWith(`${origin}/`)
    ? route.continue() : route.abort());
  await page.goto(origin);
  async function render(section) {
    await page.evaluate(async initialSection => {
      const { renderSettingsWorkspace } = await import("/src/lib/main-workspace-settings.js");
      renderSettingsWorkspace({
        container: document.querySelector("#root"), initialSection,
        bridgeRequest: async () => ({ providers: [], addons: [], memory: {} }),
        chromeApi: { storage: { local: { get: async () => ({}), set: async () => {} } } },
      });
    }, section);
    await page.locator(".settings-panel").waitFor();
  }
  async function radius(selector, expected) {
    const actual = await page.locator(selector).first().evaluate(node => getComputedStyle(node).borderRadius);
    assert.equal(actual, `${expected}px`, selector);
  }
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await render("overview");
    await radius(".settings-subnav", 24);
    await radius(".settings-nav-item", 16);
    await radius(".settings-setup-card", 22);
    await radius(".settings-health-card", 20);
    await radius(".settings-setup-card button", 12);
    await radius(".settings-setup-card span", 999);
    await radius("#outside", 3);
    await page.screenshot({ path: path.join(artifacts, `overview-${width}.png`), fullPage: true });
    await render("appearance");
    await radius(".settings-appearance-control select", 12);
    await radius(".settings-panel button", 12);
    await page.getByRole("combobox").first().focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid");
    await page.evaluate(async () => {
      const { openProviderAccountModal } = await import("/src/lib/settings/providers-section.js");
      openProviderAccountModal({ bridgeRequest: async () => ({}), statusNode: document.createElement("p"), reload: async () => {} });
    });
    await radius(".settings-provider-modal-panel", 22);
    await radius(".settings-provider-field input", 12);
    await radius(".settings-provider-field textarea", 16);
    await radius(".settings-provider-modal-actions button", 12);
    await page.screenshot({ path: path.join(artifacts, `provider-modal-${width}.png`), fullPage: true });
    await page.locator(".settings-provider-modal").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".settings-provider-modal").waitFor({ state: "detached" });
  }
  // Prove the check catches the original regression: a later important override.
  await render("overview");
  const override = await page.addStyleTag({ content: ".settings-health-card { border-radius: 3px !important; }" });
  await assert.rejects(() => radius(".settings-health-card", 20), { name: "AssertionError" });
  await override.evaluate(node => node.remove());
  await radius(".settings-health-card", 20);
  const pillOverride = await page.addStyleTag({ content: ".settings-setup-card button { border-radius: 999px !important; }" });
  await assert.rejects(() => radius(".settings-setup-card button", 12), { name: "AssertionError" });
  await pillOverride.evaluate(node => node.remove());
  await radius(".settings-setup-card button", 12);
  console.log(JSON.stringify({ passed: true, chrome: browser.version(), viewports: [1280, 768, 390], injectedOverrideDetected: true, injectedPillDetected: true }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
