import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import tls from "node:tls";
import net from "node:net";

import {
  getBridgeHttpsUrl,
  startBridgeServersWithTls,
} from "../host/bridge-server.mjs";
import {
  ensureBridgeTls,
  getCertSans,
} from "../host/bridge-tls.mjs";

let tmp;
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "resonantos-tls-test-"));
  process.env.RESONANTOS_BRIDGE_TLS_DIR = tmp;
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || "GET",
      ca: options.ca,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      headers: options.headers || {},
    }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("ensureBridgeTls: generates CA + leaf with auto-discovered SANs", async () => {
  const tls = await ensureBridgeTls({ dir: tmp, regen: true });
  assert.ok(tls.key.length > 0, "key non-empty");
  assert.ok(tls.cert.length > 0, "cert non-empty");
  assert.ok(tls.ca.length > 0, "ca non-empty");
  assert.equal(tls.generated, true);
  const sans = await getCertSans(tls.cert);
  assert.ok(sans.includes("localhost"), `localhost in SANs (got ${JSON.stringify(sans)})`);
  assert.ok(sans.includes("127.0.0.1"), `127.0.0.1 in SANs`);
  // At least one of the LAN/Tailscale addresses should be there
  const hasNetwork = sans.some(s => /^(192\.168|100\.112|10\.)/.test(s));
  assert.ok(hasNetwork, `at least one network IP in SANs (got ${JSON.stringify(sans)})`);
});

test("bridge TLS pins OpenSSL and passes only a scoped environment", async () => {
  const bridgeTls = await import("../host/bridge-tls.mjs");
  assert.equal(typeof bridgeTls.runOpenSsl, "function");
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const pending = bridgeTls.runOpenSsl(["version"], {
    environment: {
      HOME: "/home/test",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp/test",
      SECRET_SENTINEL: "do-not-inherit",
    },
    exists: (candidate) => candidate === "/usr/bin/openssl",
    platform: "linux",
    spawnImpl: (...args) => {
      calls.push(args);
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });

  assert.deepEqual(await pending, { stdout: "", stderr: "" });
  assert.deepEqual(calls, [[
    "/usr/bin/openssl",
    ["version"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: "/home/test",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: "/tmp/test",
      },
    },
  ]]);
});

test("ensureBridgeTls: idempotent on second call (no regen)", async () => {
  const first = await ensureBridgeTls({ dir: tmp });
  const second = await ensureBridgeTls({ dir: tmp });
  assert.equal(first.generated, false);
  assert.equal(second.generated, false);
  assert.equal(first.cert.toString(), second.cert.toString());
});

test("startBridgeServersWithTls: HTTP and HTTPS serve the same routes", async () => {
  const tls = await ensureBridgeTls({ dir: tmp });
  const TOKEN = "tls-test-token-1";
  const routes = [{ method: "GET", path: "/ping", handler: async () => ({ pong: true }) }];
  const result = await startBridgeServersWithTls({
    httpPort: 0, httpsPort: 0,
    tls: { key: tls.key, cert: tls.cert },
    bridgeToken: TOKEN, routes, host: "127.0.0.1",
  });
  try {
    assert.ok(result.httpServer);
    assert.ok(result.httpsServer);
    assert.notEqual(result.httpPort, result.httpsPort);
    // HTTP
    const httpResp = await fetch(`http://127.0.0.1:${result.httpPort}/ping`, {
      headers: { "X-ResonantOS-Bridge-Token": TOKEN },
    });
    assert.equal(httpResp.status, 200);
    // HTTPS
    const httpsResp = await httpsGet(`https://127.0.0.1:${result.httpsPort}/ping`, {
      ca: tls.ca,
      headers: { "X-ResonantOS-Bridge-Token": TOKEN },
    });
    assert.equal(httpsResp.status, 200);
    const body = JSON.parse(httpsResp.body);
    assert.equal(body.ok, true);
    assert.equal(body.pong, true);
  } finally {
    result.httpServer.close();
    result.httpsServer.close();
  }
});

test("startBridgeServersWithTls: HTTPS enforces token auth (401 without header)", async () => {
  const tls = await ensureBridgeTls({ dir: tmp });
  const TOKEN = "tls-test-token-2";
  const result = await startBridgeServersWithTls({
    httpPort: 0, httpsPort: 0,
    tls: { key: tls.key, cert: tls.cert },
    bridgeToken: TOKEN,
    routes: [{ method: "GET", path: "/ping", handler: async () => ({ pong: true }) }],
    host: "127.0.0.1",
  });
  try {
    const r = await httpsGet(`https://127.0.0.1:${result.httpsPort}/ping`, { ca: tls.ca });
    assert.equal(r.status, 401);
  } finally {
    result.httpServer.close();
    result.httpsServer.close();
  }
});

test("startBridgeServersWithTls: HTTPS reverse-proxies the dashboard", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>TLS-Proxy-OK</title>");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  process.env.RESONANTOS_HERMES_DASHBOARD_PORT = String(upPort);
  const tls = await ensureBridgeTls({ dir: tmp });
  const TOKEN = "tls-test-token-3";
  const result = await startBridgeServersWithTls({
    httpPort: 0, httpsPort: 0,
    tls: { key: tls.key, cert: tls.cert },
    bridgeToken: TOKEN, routes: [], host: "127.0.0.1",
  });
  try {
    const r = await httpsGet(`https://127.0.0.1:${result.httpsPort}/hermes-dashboard/`, {
      ca: tls.ca,
      headers: { "X-ResonantOS-Bridge-Token": TOKEN },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes("TLS-Proxy-OK"));
  } finally {
    result.httpServer.close();
    result.httpsServer.close();
    delete process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
    await new Promise((r) => upstream.close(r));
  }
});

test("startBridgeServersWithTls: HTTPS proxy preserves subresources (assets path)", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end("/* fake css */");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  process.env.RESONANTOS_HERMES_DASHBOARD_PORT = String(upPort);
  const tls = await ensureBridgeTls({ dir: tmp });
  const TOKEN = "tls-test-token-4";
  const result = await startBridgeServersWithTls({
    httpPort: 0, httpsPort: 0,
    tls: { key: tls.key, cert: tls.cert },
    bridgeToken: TOKEN, routes: [], host: "127.0.0.1",
  });
  try {
    const r = await httpsGet(
      `https://127.0.0.1:${result.httpsPort}/hermes-dashboard/assets/index-abc.css`,
      { ca: tls.ca, headers: { "X-ResonantOS-Bridge-Token": TOKEN } },
    );
    assert.equal(r.status, 200);
    assert.match(r.body, /fake css/);
  } finally {
    result.httpServer.close();
    result.httpsServer.close();
    delete process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
    await new Promise((r) => upstream.close(r));
  }
});

test("startBridgeServersWithTls: HTTPS proxy returns 502 when upstream is down", async () => {
  process.env.RESONANTOS_HERMES_DASHBOARD_PORT = "1"; // guaranteed unbound
  const tls = await ensureBridgeTls({ dir: tmp });
  const TOKEN = "tls-test-token-5";
  const result = await startBridgeServersWithTls({
    httpPort: 0, httpsPort: 0,
    tls: { key: tls.key, cert: tls.cert },
    bridgeToken: TOKEN, routes: [], host: "127.0.0.1",
  });
  try {
    const r = await httpsGet(`https://127.0.0.1:${result.httpsPort}/hermes-dashboard/`, {
      ca: tls.ca,
      headers: { "X-ResonantOS-Bridge-Token": TOKEN },
    });
    assert.equal(r.status, 502);
    assert.match(r.body, /Hermes dashboard is not running/);
  } finally {
    result.httpServer.close();
    result.httpsServer.close();
    delete process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
  }
});

test("getBridgeHttpsUrl: derives https URL from public URL + port", () => {
  process.env.RESONANTOS_BRIDGE_PUBLIC_URL = "http://192.168.1.100:47773";
  process.env.RESONANTOS_BRIDGE_HTTPS_PORT = "47774";
  const u = getBridgeHttpsUrl(47773);
  assert.equal(u, "https://192.168.1.100:47774");
  delete process.env.RESONANTOS_BRIDGE_PUBLIC_URL;
  delete process.env.RESONANTOS_BRIDGE_HTTPS_PORT;
});

test("getBridgeHttpsUrl: respects explicit RESONANTOS_BRIDGE_PUBLIC_URL_HTTPS", () => {
  process.env.RESONANTOS_BRIDGE_PUBLIC_URL = "http://192.168.1.100:47773";
  process.env.RESONANTOS_BRIDGE_PUBLIC_URL_HTTPS = "https://bridge.example.com:8443";
  const u = getBridgeHttpsUrl(47773);
  assert.equal(u, "https://bridge.example.com:8443");
  delete process.env.RESONANTOS_BRIDGE_PUBLIC_URL;
  delete process.env.RESONANTOS_BRIDGE_PUBLIC_URL_HTTPS;
});

test("getBridgeHttpsUrl: handles missing env gracefully", () => {
  delete process.env.RESONANTOS_BRIDGE_PUBLIC_URL;
  delete process.env.RESONANTOS_BRIDGE_PUBLIC_URL_HTTPS;
  const u = getBridgeHttpsUrl(47773);
  // Should still produce a valid URL (with default 47774 port)
  assert.match(u, /^https:\/\/.+:47774$/);
});

test("HTTPS handshake: peer cert has CN=ResonantOS Bridge", async () => {
  const tlsBundle = await ensureBridgeTls({ dir: tmp });
  const result = await startBridgeServersWithTls({
    httpPort: 0, httpsPort: 0,
    tls: { key: tlsBundle.key, cert: tlsBundle.cert },
    bridgeToken: "tls-test-token-6",
    routes: [],
    host: "127.0.0.1",
  });
  try {
    const peer = await new Promise((resolve, reject) => {
      const s = net.connect(result.httpsPort, "127.0.0.1", () => {
        const ts = tls.connect({
          socket: s,
          ca: tlsBundle.ca,
          servername: "localhost",
        }, () => {
          const c = ts.getPeerCertificate();
          ts.end();
          resolve(c);
        });
        ts.on("error", reject);
      });
    });
    assert.equal(peer.subject.CN, "ResonantOS Bridge");
  } finally {
    result.httpServer.close();
    result.httpsServer.close();
  }
});

test("HTTPS handshake: fails when CA is not trusted (rejectUnauthorized=true)", async () => {
  const tls = await ensureBridgeTls({ dir: tmp });
  const result = await startBridgeServersWithTls({
    httpPort: 0, httpsPort: 0,
    tls: { key: tls.key, cert: tls.cert },
    bridgeToken: "tls-test-token-7",
    routes: [],
    host: "127.0.0.1",
  });
  try {
    // No `ca` option — system CA store doesn't trust our self-signed.
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "127.0.0.1",
        port: result.httpsPort,
        path: "/",
        rejectUnauthorized: true,
      }, () => {
        req.destroy();
        reject(new Error("Should have failed TLS verification"));
      });
      req.on("error", (err) => {
        // We expect 'unable to verify' or 'self signed' in the error.
        if (/self signed|unable to verify/i.test(err.message)) resolve();
        else reject(new Error(`Unexpected TLS error: ${err.message}`));
      });
      req.end();
    });
  } finally {
    result.httpServer.close();
    result.httpsServer.close();
  }
});
