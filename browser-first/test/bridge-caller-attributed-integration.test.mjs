// Hook-up B integration: end-to-end caller attribution via the runtime
// grants store and the JSONL audit ledger, exercised through the wired
// createBridgeRequestHandler. This proves the seam laid down in hook-up A
// (perCallerGrants + auditSink) is reachable from real factory output, not
// just hard-coded literal grants.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeRequestHandler } from "../host/bridge-server.mjs";
import { createBridgeGrantsStore } from "../host/bridge-grants-store.mjs";
import { createBridgeAuditLedger } from "../host/bridge-audit-ledger.mjs";

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

test("createBridgeRequestHandler + grants store + audit ledger: two callers end-to-end", async () => {
  const tmp = makeTempDir();
  try {
    const auditPath = path.join(tmp, "audit.jsonl");
    const grants = createBridgeGrantsStore();
    const alphaToken = grants.mintGrant("alpha-caller", "provider-credential-write");
    const betaToken = grants.mintGrant("beta-caller", "provider-credential-write");
    const ledger = createBridgeAuditLedger({ filePath: auditPath });

    const handler = createBridgeRequestHandler({
      bridgeToken: "integration-bridge-token",
      bridgeCapabilityTokens: {},
      perCallerGrants: grants.snapshot(),
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

    // alpha-caller with its minted token — must succeed.
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

    // beta-caller with its minted token — must succeed.
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

    // Cross-caller theft: alpha-caller id, beta's token — must be rejected.
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

    // Confirm the JSONL ledger received distinct caller attribution.
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

test("grants store revocation is observable at the bridge", async () => {
  const tmp = makeTempDir();
  try {
    const auditPath = path.join(tmp, "audit.jsonl");
    const grants = createBridgeGrantsStore();
    const token = grants.mintGrant("alpha-caller", "provider-credential-write");
    grants.revoke("alpha-caller", "provider-credential-write");
    const ledger = createBridgeAuditLedger({ filePath: auditPath });

    const handler = createBridgeRequestHandler({
      bridgeToken: "integration-bridge-token",
      bridgeCapabilityTokens: {},
      // Re-snapshot after revocation — the bridge reads from perCallerGrants
      // only at request time, so post-revoke snapshots reflect the
      // up-to-date state.
      perCallerGrants: grants.snapshot(),
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
