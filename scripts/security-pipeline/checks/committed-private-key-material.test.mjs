import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "./committed-private-key-material.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function createFixture() {
  return mkdtempSync(path.join(os.tmpdir(), "private-key-material-"));
}

function writeFixture(root, relativePath, content = "") {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function generateEd25519Material() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }),
    jwk: privateKey.export({ format: "jwk" }),
  };
}

async function runFixture(root, check = { surfaces: ["."] }) {
  return run({ check, repoRoot: root });
}

test("PEM private key in config text fails without leaking key material", async () => {
  const root = createFixture();
  try {
    const { pem } = generateEd25519Material();
    const bodyFirst40Chars = pem
      .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u, "")
      .replace(/-----END [A-Z0-9 ]*PRIVATE KEY-----/u, "")
      .replace(/\s+/gu, "")
      .slice(0, 40);
    writeFixture(root, "config/keys.txt", pem);

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, "pem-private-key");
    assert.equal(result.evidence[0].path, "config/keys.txt");
    assert.equal(JSON.stringify(result).includes(bodyFirst40Chars), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-line short PEM decoy is ignored", async () => {
  const root = createFixture();
  try {
    writeFixture(root, "config/redacted.txt", "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----");

    const result = await runFixture(root);

    assert.equal(result.status, "pass");
    assert.equal(result.evidence.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PEM embedded in JSON string literal escapes fails", async () => {
  const root = createFixture();
  try {
    const { pem } = generateEd25519Material();
    writeFixture(root, "signer-config.json", JSON.stringify({ privateKeyPem: pem }));

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, "pem-private-key");
    assert.equal(result.evidence[0].path, "signer-config.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JWK private component fails without leaking d value", async () => {
  const root = createFixture();
  try {
    const { jwk } = generateEd25519Material();
    writeFixture(root, "test/fixtures/key.json", JSON.stringify(jwk, null, 2));

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, "jwk-private-component");
    assert.equal(result.evidence[0].path, "test/fixtures/key.json");
    assert.equal(JSON.stringify(result).includes(jwk.d), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public JWK without private component passes", async () => {
  const root = createFixture();
  try {
    const { jwk } = generateEd25519Material();
    delete jwk.d;
    writeFixture(root, "test/fixtures/key.json", JSON.stringify(jwk, null, 2));

    const result = await runFixture(root);

    assert.equal(result.status, "pass");
    assert.equal(result.evidence.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-JSON text with nearby JWK kty and d fails", async () => {
  const root = createFixture();
  try {
    const dValue = "abcdefghijklmnopqrstuvwxyz";
    writeFixture(root, "notes/key.txt", `prefix "kty": "OKP", "d": "${dValue}" suffix`);

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, "jwk-private-component");
    assert.equal(result.evidence[0].path, "notes/key.txt");
    assert.equal(JSON.stringify(result).includes(dValue), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private-key-like filenames fail even when empty", async () => {
  const root = createFixture();
  try {
    writeFixture(root, "scripts/.bundled-test-signer.json");
    writeFixture(root, "certs/server.pem");
    writeFixture(root, "id_ed25519");

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.deepEqual(
      result.evidence.map(({ kind, path: evidencePath }) => [kind, evidencePath]).sort(),
      [
        ["private-key-filename", "certs/server.pem"],
        ["private-key-filename", "id_ed25519"],
        ["private-key-filename", "scripts/.bundled-test-signer.json"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allowlisted PEM finding passes and records reason", async () => {
  const root = createFixture();
  try {
    const { pem } = generateEd25519Material();
    writeFixture(root, "config/keys.txt", pem);

    const result = await runFixture(root, {
      surfaces: ["."],
      allowlist: [{ path: "config/keys.txt", reason: "documented redaction fixture" }],
    });

    assert.equal(result.status, "pass");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].status, "allowlisted");
    assert.equal(result.evidence[0].reason, "documented redaction fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allowlist entry without reason fails configuration", async () => {
  const root = createFixture();
  try {
    writeFixture(root, "config/keys.txt", "");

    const result = await runFixture(root, {
      surfaces: ["."],
      allowlist: [{ path: "config/keys.txt" }],
    });

    assert.equal(result.status, "fail");
    assert.match(result.summary, /reason/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real repository baseline is clean through git ls-files branch", async () => {
  const result = await runFixture(path.resolve(HERE, "..", "..", ".."), { surfaces: ["."] });

  assert.equal(result.status, "pass");
});

test("binary extension content is not scanned", async () => {
  const root = createFixture();
  try {
    const { pem } = generateEd25519Material();
    writeFixture(root, "images/key.png", pem);

    const result = await runFixture(root);

    assert.equal(result.status, "pass");
    assert.equal(result.evidence.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PEM body without an END footer still fails", async () => {
  const root = createFixture();
  try {
    const { pem } = generateEd25519Material();
    const truncated = pem.replace(/-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/u, "");
    writeFixture(root, "notes/partial.txt", `${truncated}\n(rest of the file)`);

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, "pem-private-key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PEM embedded with literal CRLF escapes in a JSON string fails", async () => {
  const root = createFixture();
  try {
    const { pem } = generateEd25519Material();
    const crlfPem = pem.replace(/\n/gu, "\r\n");
    writeFixture(root, "config/windows-settings.json", JSON.stringify({ key: crlfPem }));

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, "pem-private-key");
    assert.equal(result.evidence[0].path, "config/windows-settings.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("surfaces match on path boundaries, not bare prefixes", async () => {
  const root = createFixture();
  try {
    writeFixture(root, "src-legacy/server.pem");
    writeFixture(root, "src/server.pem");

    const outside = await runFixture(root, { surfaces: ["src"] });
    assert.equal(outside.status, "fail");
    assert.deepEqual(outside.evidence.map((finding) => finding.path), ["src/server.pem"]);

    const legacyOnly = await runFixture(root, { surfaces: ["src-legacy/"] });
    assert.deepEqual(legacyOnly.evidence.map((finding) => finding.path), ["src-legacy/server.pem"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable path is reported without failing or aborting the scan", async () => {
  const root = createFixture();
  try {
    symlinkSync(path.join(root, "does-not-exist.txt"), path.join(root, "dangling.txt"));
    writeFixture(root, "README.md", "clean");

    const result = await runFixture(root);

    assert.equal(result.status, "pass");
    assert.deepEqual(
      result.evidence.map(({ kind, path: evidencePath, status }) => [kind, evidencePath, status]),
      [["unreadable", "dangling.txt", "unreadable"]],
    );
    assert.match(result.summary, /1 unreadable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lowercase kty does not hide a JWK private component (parsed and fallback paths)", async () => {
  const root = createFixture();
  try {
    const { jwk } = generateEd25519Material();
    const lowered = { ...jwk, kty: jwk.kty.toLowerCase() };
    writeFixture(root, "keys/lower.json", JSON.stringify(lowered));
    writeFixture(root, "keys/lower.txt", `key = ${JSON.stringify(lowered)}`);

    const result = await runFixture(root);

    assert.equal(result.status, "fail");
    assert.deepEqual(
      result.evidence.map(({ kind, path: evidencePath }) => [kind, evidencePath]).sort(),
      [
        ["jwk-private-component", "keys/lower.json"],
        ["jwk-private-component", "keys/lower.txt"],
      ],
    );
    assert.equal(JSON.stringify(result).includes(jwk.d), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file above the content cap is reported as oversized instead of silently skipped", async () => {
  const root = createFixture();
  try {
    const { pem } = generateEd25519Material();
    writeFixture(root, "big/blob.txt", `${pem}${"x".repeat(2048)}`);

    const result = await runFixture(root, { surfaces: ["."], maxContentBytes: 1024 });

    assert.equal(result.status, "pass");
    assert.deepEqual(
      result.evidence.map(({ kind, path: evidencePath, status }) => [kind, evidencePath, status]),
      [["oversized", "big/blob.txt", "oversized"]],
    );
    assert.match(result.summary, /1 oversized/u);
    assert.equal(JSON.stringify(result).includes(pem.split("\n")[1]), false);

    const scanned = await runFixture(root);
    assert.equal(scanned.status, "fail");
    assert.equal(scanned.evidence[0].kind, "pem-private-key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
