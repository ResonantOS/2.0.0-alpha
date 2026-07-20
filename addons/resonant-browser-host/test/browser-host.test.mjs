// Intent citation: docs/architecture/ADR-017-resonant-browser-addon.md

import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ResonantBrowserHost, handleJsonRpcLine, resolveChromiumLaunchOptions } from "../src/browser-host.mjs";

let server;
let baseUrl;
let localhostBindDenied = false;
const serverSockets = new Set();

function html(body) {
  return `<!doctype html>
<html>
  <head>
    <title>Browser Host Test</title>
    <style>
      body { font-family: sans-serif; min-height: 1600px; }
      button, input { font-size: 18px; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/next") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(html("<main><h1>Second page</h1><p>Navigation worked.</p></main>"));
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      html(`<main>
        <h1>Resonant Browser Host Fixture</h1>
        <p id="status">Waiting</p>
        <button id="change-status" onclick="document.querySelector('#status').textContent = 'Clicked'">Change status</button>
        <label for="field">Field</label>
        <input id="field" oninput="document.querySelector('#typed').textContent = this.value" />
        <p id="typed"></p>
        <a href="/next">Go next</a>
      </main>`),
    );
  });
  server.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    if (error?.code === "EPERM" && error?.address === "127.0.0.1") {
      localhostBindDenied = true;
      return;
    }
    throw error;
  }
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) {
    return;
  }
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  for (const socket of serverSockets) {
    socket.destroy();
  }
  if (server.listening) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

describe("ResonantBrowserHost", () => {
  it("opens, reads, clicks, types, captures evidence, and closes a Chromium session", { timeout: 90_000 }, async (t) => {
    if (localhostBindDenied) {
      t.skip("localhost bind is denied in this sandbox; browser-host live Chromium behavior must be verified outside sandboxed CI.");
      return;
    }
    const artifactsDir = await mkdtemp(join(tmpdir(), "resonant-browser-host-"));
    const host = new ResonantBrowserHost({ headless: true });
    t.after(async () => {
      await host.close().catch(() => undefined);
    });

    const start = await host.start({ defaultUrl: baseUrl });
    assert.equal(start.ready, true);
    assert.equal(start.engine, "chromium");
    assert.equal(start.url, `${baseUrl}/`);

    const read = await host.readPage();
    assert.equal(read.title, "Browser Host Test");
    assert.match(read.text, /Resonant Browser Host Fixture/);
    assert.equal(read.links[0].href, `${baseUrl}/next`);

    await host.click({ selector: "#change-status", timeoutMs: 20_000 });
    const clicked = await host.readPage();
    assert.match(clicked.text, /Clicked/);

    await host.type({ selector: "#field", text: "Augmentor controls Chromium" });
    const typed = await host.readPage();
    assert.match(typed.text, /Augmentor controls Chromium/);

    const evidence = await host.captureEvidence({ artifactsDir, reason: "contract-test" });
    const screenshotStats = await stat(evidence.evidenceRef);
    assert.equal(screenshotStats.isFile(), true);
    assert.ok(screenshotStats.size > 1000);
    assert.ok(evidence.audit.some((entry) => entry.event === "evidence.captured"));

    const closed = await host.close();
    assert.equal(closed.closed, true);
  });

  it("rejects non-web URLs before navigation", async () => {
    const host = new ResonantBrowserHost({ headless: true });

    await assert.rejects(() => host.start({ defaultUrl: "file:///etc/passwd" }), /http and https URLs/);
  });

  it("supports a configured Chrome channel without requiring a bundled Chromium download", () => {
    const channelOptions = resolveChromiumLaunchOptions({
      headless: true,
      params: {},
      env: { RESONANTOS_BROWSER_HOST_CHANNEL: "chrome" },
    });
    assert.equal(channelOptions.channel, "chrome");
    assert.equal(channelOptions.executablePath, undefined);
    assert.deepEqual(channelOptions.args, ["--password-store=basic", "--use-mock-keychain"]);

    const executableOptions = resolveChromiumLaunchOptions({
      headless: true,
      params: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      env: { RESONANTOS_BROWSER_HOST_CHANNEL: "chrome" },
    });
    assert.equal(executableOptions.channel, undefined);
    assert.equal(executableOptions.executablePath, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("handles stdio JSON-RPC method lines", { timeout: 60_000 }, async (t) => {
    if (localhostBindDenied) {
      t.skip("localhost bind is denied in this sandbox; browser-host JSON-RPC live Chromium behavior must be verified outside sandboxed CI.");
      return;
    }
    const host = new ResonantBrowserHost({ headless: true });
    t.after(async () => {
      await host.close().catch(() => undefined);
    });

    const response = await handleJsonRpcLine(
      host,
      JSON.stringify({ id: "1", method: "browser.start", params: { defaultUrl: baseUrl } }),
    );
    assert.equal(response.id, "1");
    assert.equal(response.result.ready, true);
    assert.equal(response.result.url, `${baseUrl}/`);

    const read = await handleJsonRpcLine(host, JSON.stringify({ id: "2", method: "browser.read_page" }));
    assert.equal(read.id, "2");
    assert.match(read.result.text, /Resonant Browser Host Fixture/);

    await host.close();
  });
});
