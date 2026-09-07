import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { createBridgeRouteSelfTestInvoker } from "../host/bridge-self-test-invoker.mjs";

const execFileAsync = promisify(execFile);

test("minimal bridge self-test adapter enforces live default-deny and scoped capability checks", async () => {
  const bridgeToken = "adapter-bridge-token";
  const capabilityToken = "adapter-capability-token";
  const bridgeCapabilityTokens = { "bridge-diagnostics-read": capabilityToken };
  let observedHeaders = {};

  const invokeBridgeRouteForSelfTest = createBridgeRouteSelfTestInvoker({
    bridgeToken,
    bridgeCapabilityTokens,
    capabilityBootstrapToken: "adapter-bootstrap-token",
    routes: [
      {
        method: "POST",
        path: "/adapter-undeclared",
        handler: async () => ({ unexpected: true }),
      },
      {
        method: "POST",
        path: "/adapter-declared",
        requiredCapability: "bridge-diagnostics-read",
        handler: async (payload, request) => {
          observedHeaders = request.headers;
          return { accepted: payload.accepted === true };
        },
      },
    ],
  });

  const undeclared = await invokeBridgeRouteForSelfTest({
    method: "POST",
    routePath: "/adapter-undeclared",
    body: { accepted: true },
    capabilityToken,
  });
  assert.equal(undeclared.status, 403);
  assert.equal(undeclared.payload.error, "Bridge route declares no capability; refused by default.");

  const declared = await invokeBridgeRouteForSelfTest({
    method: "POST",
    routePath: "/adapter-declared",
    body: { accepted: true },
    capabilityToken,
  });
  assert.equal(declared.status, 200);
  assert.equal(declared.payload.accepted, true);
  assert.equal(observedHeaders["x-resonantos-bridge-token"], bridgeToken);
  assert.equal(observedHeaders["x-resonantos-bridge-capability-token"], capabilityToken);
});

test("browser-first bridge auth passes in-process deterministic smoke test", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "browser-first/host/run-browser-first.mjs",
    "--bridge-auth-inprocess-self-test=true",
    "--bridge-token=test-token",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.route, "/status");
  assert.equal(result.unauthorizedStatus, 401);
  assert.equal(result.wrongTokenStatus, 401);
  assert.equal(result.bridgeTokenOnlyStatus, 403);
  assert.equal(result.authorizedStatus, 200);
});
