// Hook-up B integration + H1 caller-attributed tokens: end-to-end caller
// attribution via the runtime grants store, the JSONL audit ledger, and the
// HMAC-signed tokens. Exercised through the wired createBridgeRequestHandler
// with perCallerGrants, tokenKey, and auditSink.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeRequestHandler } from "../host/bridge-server.mjs";
import { createBridgeGrantsStore } from "../host/bridge-grants-store.mjs";
import { createBridgeAuditLedger } from "../host/bridge-audit-ledger.mjs";
import { createBridgeTokenKey } from "../host/bridge-token-key.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), "resonant-bridge-integration-"));
}

function makeMockResponse() {
  const headers = {};
  return {
    statusCode: 0,
    body: null,
    _headers: headers,
    writeHead(status, headerObj) {
      this.statusCode = status;
      Object.assign(headers, headerObj);
    },
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
}

function makeMockRequest({ url, method = "GET", headers, socketRemote = "127.0.0.1" }) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: socketRemote },
  };
}

test("createBridgeRequestHandler + grants store + audit ledger: two callers end-to-end (H1)", async () => {
  const tmp = makeTempDir();
  try {
    const auditPath = path.join(tmp, "audit.jsonl");
    const tokenKey = createBridgeTokenKey();
    const grants = createBridgeGrantsStore({ tokenKey });
    const alphaToken = grants.mintGrant("alpha-caller", "provider-credential-write");
    const betaToken = grants.mintGrant("beta-caller", "provider-credential-write");
    const ledger = createBridgeAuditLedger({ filePath: auditPath });

    const handler = createBridgeRequestHandler({
      bridgeToken: "integration-bridge-token",
      bridgeCapabilityTokens: {},
      perCallerGrants: grants.snapshot(),
      tokenKey,
      auditSink: ledger.sink,
      extensionOrigin: "chrome-extension://integration",
      routes: [
        {
          method: "GET",
          path: "/providers/credentials/probe",
          requiredCapability: "provider-credential-write",
          handler: async () => ({ probed: true }),
        },
      ],
    });

    const alphaResponse = makeMockResponse();
    await handler(makeMockRequest({
      url: "/providers/credentials/probe",
      headers: {
        "X-ResonantOS-Bridge-Token": "integration-bridge-token",
        "X-ResonantOS-Bridge-Capability-Token": alphaToken,
        "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
      },
    }), alphaResponse);
    assert.equal(alphaResponse.statusCode, 200);
    assert.equal(alphaResponse.body.probed, true);

    const betaResponse = makeMockResponse();
    await handler(makeMockRequest({
      url: "/providers/credentials/probe",
      headers: {
        "X-ResonantOS-Bridge-Token": "integration-bridge-token",
        "X-ResonantOS-Bridge-Capability-Token": betaToken,
        "X-ResonantOS-Bridge-Caller-Id": "beta-caller",
      },
    }), betaResponse);
    assert.equal(betaResponse.statusCode, 200);

    // H1 attacker case: alpha-caller id, beta's token — must be rejected.
    // With caller-attributed tokens the token's signed payload binds callerId,
    // so even if the client sets X-ResonantOS-Bridge-Caller-Id to "alpha-caller"
    // and supplies beta's token, the verifier refuses because the token's
    // embedded callerId is "beta-caller".
    const theftResponse = makeMockResponse();
    await handler(makeMockRequest({
      url: "/providers/credentials/probe",
      headers: {
        "X-ResonantOS-Bridge-Token": "integration-bridge-token",
        "X-ResonantOS-Bridge-Capability-Token": betaToken,
        "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
      },
    }), theftResponse);
    assert.equal(theftResponse.statusCode, 403);

    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "exactly the two authorised requests land in the ledger");
    const callerIds = new Set(lines.map((line) => JSON.parse(line).callerId));
    assert.equal(callerIds.size, 2);
    assert.ok(callerIds.has("alpha-caller"));
    assert.ok(callerIds.has("beta-caller"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("grants store revocation is observable at the bridge (H1 tokens)", async () => {
  const tmp = makeTempDir();
  try {
    const auditPath = path.join(tmp, "audit.jsonl");
    const tokenKey = createBridgeTokenKey();
    const grants = createBridgeGrantsStore({ tokenKey });
    const token = grants.mintGrant("alpha-caller", "provider-credential-write");
    grants.revoke("alpha-caller", "provider-credential-write");
    const ledger = createBridgeAuditLedger({ filePath: auditPath });

    const handler = createBridgeRequestHandler({
      bridgeToken: "integration-bridge-token",
      bridgeCapabilityTokens: {},
      perCallerGrants: grants.snapshot(),
      tokenKey,
      callerGrantVerifier: grants.verifyCallerGrant.bind(grants),
      auditSink: ledger.sink,
      extensionOrigin: "chrome-extension://integration",
      routes: [
        {
          method: "GET",
          path: "/providers/credentials/probe",
          requiredCapability: "provider-credential-write",
          handler: async () => ({ probed: true }),
        },
      ],
    });

    const response = makeMockResponse();
    await handler(makeMockRequest({
      url: "/providers/credentials/probe",
      headers: {
        "X-ResonantOS-Bridge-Token": "integration-bridge-token",
        "X-ResonantOS-Bridge-Capability-Token": token,
        "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
      },
    }), response);
    assert.equal(response.statusCode, 403, "revoked grant must be rejected");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
