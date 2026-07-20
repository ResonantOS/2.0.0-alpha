import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";

import {
  dashboardProxyUrl,
  startBridgeServer,
} from "../host/bridge-server.mjs";

// Spin up a fake "Hermes" upstream and wire it as the proxy target. The
// upstream handler is invoked by node for each incoming proxied request —
// we don't call it ourselves. The bridge HTTP request flows:
//   test fetch → bridge (port X) → upstream (port Y, here).
async function withFakeUpstream(handler, fn) {
  const upstream = http.createServer(handler);
  await new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      process.env.RESONANTOS_HERMES_DASHBOARD_PORT = String(
        upstream.address().port,
      );
      resolve();
    }),
  );
  const previous = process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
  try {
    await fn();
  } finally {
    if (previous === undefined)
      delete process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
    else
      process.env.RESONANTOS_HERMES_DASHBOARD_PORT = previous;
    await new Promise((resolve) => upstream.close(resolve));
  }
}

async function withBridgeServer(options, fn) {
  const server = await startBridgeServer({
    port: 0,
    host: "127.0.0.1",
    ...options,
  });
  const port = server.address().port;
  try {
    await fn({ bridgePort: port, bridgeUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function fetchWithToken(bridgeUrl, path, options = {}) {
  return fetch(`${bridgeUrl}${path}`, {
    ...options,
    headers: {
      "X-ResonantOS-Bridge-Token": "proxy-test-token",
      ...(options.headers || {}),
    },
  });
}

test("proxy: dashboardProxyUrl strips trailing slashes", () => {
  assert.equal(
    dashboardProxyUrl({ publicUrl: "http://192.168.1.100:47773" }),
    "http://192.168.1.100:47773/hermes-dashboard/",
  );
  assert.equal(
    dashboardProxyUrl({ publicUrl: "http://192.168.1.100:47773/" }),
    "http://192.168.1.100:47773/hermes-dashboard/",
  );
  assert.equal(
    dashboardProxyUrl({ publicUrl: "http://192.168.1.100:47773//" }),
    "http://192.168.1.100:47773/hermes-dashboard/",
  );
});

test("proxy: rejects requests without a bridge token", async () => {
  await withFakeUpstream(() => {}, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", openPathPrefixes: [], routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetch(`${bridgeUrl}/hermes-dashboard/`);
        assert.equal(r.status, 401);
      },
    );
  });
});

test("proxy: rejects requests with the wrong bridge token", async () => {
  await withFakeUpstream(() => {}, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", openPathPrefixes: [], routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetch(`${bridgeUrl}/hermes-dashboard/`, {
          headers: { "X-ResonantOS-Bridge-Token": "wrong" },
        });
        assert.equal(r.status, 401);
      },
    );
  });
});

test("proxy: serves /hermes-dashboard/ from the upstream root", async () => {
  await withFakeUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  }, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetchWithToken(bridgeUrl, "/hermes-dashboard/");
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.path, "/");
        assert.equal(body.method, "GET");
      },
    );
  });
});

test("proxy: allows iframe src dashboard mirror paths on loopback by default", async () => {
  await withFakeUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  }, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const root = await fetch(`${bridgeUrl}/hermes-dashboard/`);
        assert.equal(root.status, 200);
        assert.equal((await root.json()).path, "/");

        const asset = await fetch(`${bridgeUrl}/assets/index-abc.js`);
        assert.equal(asset.status, 200);
        assert.equal((await asset.json()).path, "/assets/index-abc.js");
      },
    );
  });
});

test("proxy: owns CORS headers for local harness and extension origins", async () => {
  await withFakeUpstream((_req, res) => {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "http://upstream.invalid",
      "Access-Control-Allow-Credentials": "false",
      "Content-Type": "text/plain",
      "Vary": "Accept-Encoding",
    });
    res.end("ok");
  }, async () => {
    await withBridgeServer(
      {
        allowedOrigins: ["http://127.0.0.1:18777"],
        bridgeToken: "proxy-test-token",
        extensionOrigin: "chrome-extension://extension-id",
        routes: [],
      },
      async ({ bridgeUrl }) => {
        const local = await fetchWithToken(bridgeUrl, "/hermes-dashboard/", {
          headers: { Origin: "http://127.0.0.1:18777" },
        });
        assert.equal(local.status, 200);
        assert.equal(local.headers.get("access-control-allow-origin"), "http://127.0.0.1:18777");
        assert.equal(local.headers.get("access-control-allow-credentials"), "true");
        assert.equal(local.headers.get("vary"), "Origin");
        assert.equal(await local.text(), "ok");

        const extension = await fetchWithToken(bridgeUrl, "/hermes-dashboard/", {
          headers: { Origin: "chrome-extension://extension-id" },
        });
        assert.equal(extension.status, 200);
        assert.equal(extension.headers.get("access-control-allow-origin"), "chrome-extension://extension-id");
      },
    );
  });
});

test("proxy: strips the prefix from subpaths", async () => {
  await withFakeUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  }, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetchWithToken(
          bridgeUrl,
          "/hermes-dashboard/assets/index-abc.js",
        );
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.path, "/assets/index-abc.js");
      },
    );
  });
});

test("proxy: preserves the query string", async () => {
  await withFakeUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  }, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetchWithToken(
          bridgeUrl,
          "/hermes-dashboard/api/chat?x=1&y=2",
        );
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.path, "/api/chat?x=1&y=2");
      },
    );
  });
});

test("proxy: forwards POST body to upstream", async () => {
  await withFakeUpstream((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ method: req.method, path: req.url, body }),
      );
    });
  }, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetchWithToken(
          bridgeUrl,
          "/hermes-dashboard/api/submit",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hello: "world" }),
          },
        );
        assert.equal(r.status, 200);
        const payload = await r.json();
        assert.equal(payload.method, "POST");
        assert.equal(payload.path, "/api/submit");
        assert.equal(payload.body, '{"hello":"world"}');
      },
    );
  });
});

test("proxy: auth bootstrap stub does not duplicate entity headers", async () => {
  const previousOpenPrefixes = process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES;
  process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES = "/api";
  await withFakeUpstream((req, res) => {
    if (req.url === "/api/auth/me") {
      const body = JSON.stringify({ error: "unauthorized" });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected path" }));
  }, async () => {
    try {
      await withBridgeServer(
        {
          bridgeToken: "proxy-test-token",
          routes: [],
        },
        async ({ bridgeUrl }) => {
          // Mirrors iframe behavior: the dashboard SPA cannot attach the
          // bridge token to its own auth bootstrap fetch.
          const r = await fetch(`${bridgeUrl}/api/auth/me`);
          assert.equal(r.status, 200);
          assert.equal(r.headers.get("content-type"), "application/json");
          const body = await r.json();
          assert.equal(body.user_id, "local-loopback");
        },
      );
    } finally {
      if (previousOpenPrefixes === undefined)
        delete process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES;
      else process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES = previousOpenPrefixes;
    }
  });
});

test("proxy: does not leak the bridge token header to the upstream", async () => {
  await withFakeUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ headers: req.headers }));
  }, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetchWithToken(bridgeUrl, "/hermes-dashboard/");
        const body = await r.json();
        assert.equal(
          body.headers["x-resonantos-bridge-token"],
          undefined,
          "bridge token header must not reach upstream",
        );
      },
    );
  });
});

test("proxy: replaces the Host header with the upstream's address", async () => {
  let observedHost = null;
  await withFakeUpstream((req, res) => {
    observedHost = req.headers.host;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetchWithToken(bridgeUrl, "/hermes-dashboard/");
        assert.equal(r.status, 200);
        // Upstream sees its own loopback host (or the bridge host if the
        // bridge is bound to a specific IP), not the bridge's public host.
        assert.match(observedHost, /^(127\.0\.0\.1|\[?[\d.:a-f]+]?):\d+$/);
      },
    );
  });
});

test("proxy: returns 502 when the upstream is not running", async () => {
  // Point the proxy at a guaranteed-unbound port
  process.env.RESONANTOS_HERMES_DASHBOARD_PORT = "1";
  const previous = process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
  try {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        const r = await fetchWithToken(bridgeUrl, "/hermes-dashboard/");
        assert.equal(r.status, 502);
        const body = await r.json();
        assert.match(body.error, /Hermes dashboard is not running/);
      },
    );
  } finally {
    if (previous === undefined)
      delete process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
    else process.env.RESONANTOS_HERMES_DASHBOARD_PORT = previous;
  }
});

test("proxy: non-proxy routes still go through the JSON evaluator", async () => {
  await withFakeUpstream(() => {}, async () => {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgeUrl }) => {
        // No routes registered → 404 from the JSON evaluator, not 502 from
        // the proxy.
        const r = await fetchWithToken(bridgeUrl, "/some-unknown-route");
        assert.equal(r.status, 404);
      },
    );
  });
});

test("proxy: echoes CORS Allow-Origin for matching origin", async () => {
  await withFakeUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  }, async () => {
    await withBridgeServer(
      {
        bridgeToken: "proxy-test-token",
        extensionOrigin: "chrome-extension://test",
        routes: [],
      },
      async ({ bridgeUrl }) => {
        const r = await fetch(`${bridgeUrl}/hermes-dashboard/`, {
          headers: {
            "X-ResonantOS-Bridge-Token": "proxy-test-token",
            Origin: "chrome-extension://test",
          },
        });
        assert.equal(r.headers.get("access-control-allow-origin"),
          "chrome-extension://test");
      },
    );
  });
});

test("proxy: forwards WebSocket upgrade to upstream and pipes both ways", async () => {
  // Fake upstream that performs a real WebSocket handshake and echoes
  // any bytes back to the client. The bridge does not interpret WebSocket
  // frames; after the HTTP 101 response, it only needs to pipe bytes.
  // Proves the bridge proxy speaks the upgrade protocol, not just
  // plain HTTP — without this the dashboard iframe's chat / event
  // WebSockets fail to connect (close code 1006).
  const upstream = net.createServer((socket) => {
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (upgraded) {
        socket.write(chunk);
        return;
      }
      const request = chunk.toString("utf8");
      if (!/upgrade:\s*websocket/i.test(request)) {
        socket.destroy(new Error("missing websocket upgrade"));
        return;
      }
      upgraded = true;
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "\r\n",
      ].join("\r\n"));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const previousPort = process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
  const previousOpenPrefixes = process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES;
  process.env.RESONANTOS_HERMES_DASHBOARD_PORT = String(upstreamPort);
  process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES = "/hermes-dashboard";
  try {
    await withBridgeServer(
      { bridgeToken: "proxy-test-token", routes: [] },
      async ({ bridgePort }) => {
        const client = net.createConnection({ host: "127.0.0.1", port: bridgePort });
        try {
          await new Promise((resolve, reject) => {
            client.once("connect", resolve);
            client.once("error", reject);
            setTimeout(() => reject(new Error("ws open timeout")), 3000);
          });
          client.write([
            "GET /hermes-dashboard/api/ws HTTP/1.1",
            "Host: 127.0.0.1",
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "X-ResonantOS-Bridge-Token: proxy-test-token",
            "\r\n",
          ].join("\r\n"));
          const upgraded = await new Promise((resolve, reject) => {
            client.once("data", (chunk) => resolve(chunk.toString("utf8")));
            client.once("error", reject);
            setTimeout(() => reject(new Error("ws upgrade timeout")), 3000);
          });
          assert.match(upgraded, /^HTTP\/1\.1 101 /);

          client.write("ping");
          const echoed = await new Promise((resolve, reject) => {
            client.once("data", (chunk) => resolve(chunk.toString("utf8")));
            client.once("error", reject);
            setTimeout(() => reject(new Error("ws message timeout")), 3000);
          });
          assert.equal(echoed, "ping");
        } finally {
          client.destroy();
        }
      },
    );
  } finally {
    if (previousPort === undefined) delete process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
    else process.env.RESONANTOS_HERMES_DASHBOARD_PORT = previousPort;
    if (previousOpenPrefixes === undefined)
      delete process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES;
    else process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES = previousOpenPrefixes;
    await new Promise((resolve) => upstream.close(resolve));
  }
});
