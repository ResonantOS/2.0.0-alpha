#!/usr/bin/env node
/**
 * Tests for scripts/health-check.mjs
 * Uses only node:test and node:assert.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Dynamically import the module under test
const healthCheck = await import(pathToFileURL(join(REPO_ROOT, "scripts", "health-check.mjs")));

const { redactSecretValue, extractProviderUrls, extractModelIdentifiers, parseDefaults } = healthCheck;

// ---------------------------------------------------------------------------
// Test: redactSecretValue — redacts when key matches secret patterns
// ---------------------------------------------------------------------------
test("redactSecretValue redacts api_key values", () => {
  const result = redactSecretValue("sk-abc123xyz", "api_key");
  assert.ok(result.includes("..."), "should contain redaction marker");
  assert.ok(result.startsWith("sk-"), "should preserve prefix");
  assert.ok(result.endsWith("xyz"), "should preserve suffix");
});

test("redactSecretValue redacts token values", () => {
  const result = redactSecretValue("tok_live_abcdef123456", "bearer_token");
  assert.ok(result.includes("..."), "should contain redaction marker");
});

test("redactSecretValue redacts password values", () => {
  const result = redactSecretValue("super-secret-pw", "password");
  assert.ok(result.includes("..."), "should contain redaction marker");
});

test("redactSecretValue redacts secret values", () => {
  const result = redactSecretValue("my-secret-value-1234", "client_secret");
  assert.ok(result.includes("..."), "should contain redaction marker");
});

test("redactSecretValue redacts credential values", () => {
  const result = redactSecretValue("cred-abc123", "credential");
  assert.ok(result.includes("..."), "should contain redaction marker");
});

test("redactSecretValue does NOT redact non-secret values", () => {
  const result = redactSecretValue("https://api.minimax.io/v1", "apiBaseUrl");
  assert.strictEqual(result, "https://api.minimax.io/v1", "should return original value");
});

test("redactSecretValue returns original for short values", () => {
  const result = redactSecretValue("abc", "api_key");
  assert.strictEqual(result, "***", "short secret values should be fully redacted");
});

test("redactSecretValue returns original for non-string input", () => {
  assert.strictEqual(redactSecretValue(null, "api_key"), null);
  assert.strictEqual(redactSecretValue(undefined, "api_key"), undefined);
  assert.strictEqual(redactSecretValue("", "api_key"), "");
});

// ---------------------------------------------------------------------------
// Test: extractProviderUrls — finds valid http/https URLs
// ---------------------------------------------------------------------------
test("extractProviderUrls finds valid provider URLs", () => {
  const sample = `
    apiBaseUrl: "https://api.minimax.io/v1",
    endpoint: "http://192.168.1.77:30000/v1",
  `;
  const urls = extractProviderUrls(sample);
  assert.ok(urls.includes("https://api.minimax.io/v1"));
  assert.ok(urls.includes("http://192.168.1.77:30000/v1"));
});

test("extractProviderUrls deduplicates URLs", () => {
  const sample = `
    apiBaseUrl: "https://example.com/api",
    endpoint: "https://example.com/api",
  `;
  const urls = extractProviderUrls(sample);
  assert.strictEqual(urls.filter((u) => u === "https://example.com/api").length, 1);
});

test("extractProviderUrls returns empty array for no URLs", () => {
  const sample = `
    noUrlHere: true,
    another: 42,
  `;
  const urls = extractProviderUrls(sample);
  assert.strictEqual(urls.length, 0);
});

// ---------------------------------------------------------------------------
// Test: extractModelIdentifiers — finds known models
// ---------------------------------------------------------------------------
test("extractModelIdentifiers finds known models", () => {
  const sample = `
    allowedModels: ["MiniMax-M3", "gpt-5.5"],
    primaryModel: "batiai/gemma4-e2b:q4",
  `;
  const models = extractModelIdentifiers(sample);
  assert.ok(models.includes("MiniMax-M3"));
  assert.ok(models.includes("gpt-5.5"));
  assert.ok(models.includes("batiai/gemma4-e2b:q4"));
});

test("extractModelIdentifiers returns empty for no known models", () => {
  const sample = `
    allowedModels: ["unknown-model", "another-unknown"],
  `;
  const models = extractModelIdentifiers(sample);
  assert.strictEqual(models.length, 0);
});

// ---------------------------------------------------------------------------
// Test: parseDefaults — valid config parsing
// ---------------------------------------------------------------------------
test("parseDefaults parses valid defaults.ts", () => {
  const report = parseDefaults(join(REPO_ROOT, "src", "core", "defaults.ts"));
  assert.ok(report.configPath.endsWith("defaults.ts"));
  assert.ok(report.providerUrls.length > 0, "should find at least one provider URL");
  assert.ok(report.modelIdentifiers.length > 0, "should find at least one model identifier");
});

test("parseDefaults URLs are valid http/https", () => {
  const report = parseDefaults(join(REPO_ROOT, "src", "core", "defaults.ts"));
  for (const url of report.providerUrls) {
    assert.ok(
      url.startsWith("http://") || url.startsWith("https://"),
      `URL should start with http:// or https://: ${url}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test: parseDefaults — missing config handling
// ---------------------------------------------------------------------------
test("parseDefaults throws on missing config file", () => {
  assert.throws(
    () => parseDefaults("/nonexistent/path/defaults.ts"),
    /Config file not found/,
  );
});

// ---------------------------------------------------------------------------
// Test: extractProviderUrls — invalid provider URL handling
// ---------------------------------------------------------------------------
test("extractProviderUrls rejects invalid URLs (ftp, file, etc.)", () => {
  const sample = `
    apiBaseUrl: "ftp://files.example.com/data",
    endpoint: "file:///etc/config",
    modelEndpoints: ["https://valid.example.com/api"],
  `;
  const urls = extractProviderUrls(sample);
  assert.ok(!urls.some((u) => u.startsWith("ftp://")));
  assert.ok(!urls.some((u) => u.startsWith("file://")));
  assert.ok(urls.includes("https://valid.example.com/api"));
});

// ---------------------------------------------------------------------------
// Test: secret redaction — comprehensive
// ---------------------------------------------------------------------------
test("redactSecretValue redacts apikey values", () => {
  const result = redactSecretValue("sk-abc123", "apikey");
  assert.ok(result.includes("..."));
});

test("redactSecretValue redacts bearer values", () => {
  const result = redactSecretValue("Bearer abc123", "bearer");
  assert.ok(result.includes("..."));
});

test("redactSecretValue redacts credential values (case insensitive)", () => {
  const result = redactSecretValue("cred-abc123", "CREDENTIAL");
  assert.ok(result.includes("..."));
});

test("redactSecretValue does not redact 'credential' in non-secret context", () => {
  // The key name itself contains the pattern, so it should still redact
  const result = redactSecretValue("some-value", "credential");
  assert.ok(result.includes("..."));
});

test("redactSecretValue does not redact unrelated keys", () => {
  const result = redactSecretValue("some-value", "modelId");
  assert.strictEqual(result, "some-value");
});

test("redactSecretValue does not redact 'token' in non-secret context", () => {
  const result = redactSecretValue("some-value", "maxContextTokens");
  assert.strictEqual(result, "some-value");
});

test("redactSecretValue does not redact credential status metadata", () => {
  const result = redactSecretValue("configured", "credentialStatus");
  assert.strictEqual(result, "configured");
});

test("redactSecretValue does not redact requiresCredential metadata", () => {
  const result = redactSecretValue("true", "requiresCredential");
  assert.strictEqual(result, "true");
});

// ---------------------------------------------------------------------------
// Test: --json flag — JSON mode output
// ---------------------------------------------------------------------------

const NODE_BIN = process.execPath;

test("--json outputs valid JSON with status ok on success", async () => {
  const result = spawnSync(NODE_BIN, ["scripts/health-check.mjs", "--json"], {
    cwd: join(__dirname, ".."),
    encoding: "utf-8",
    timeout: 15000,
  });
  assert.strictEqual(result.status, 0, `expected exit code 0, got ${result.status}`);
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.status, "ok");
  assert.ok(Array.isArray(parsed.providerUrls), "providerUrls must be an array");
  assert.ok(parsed.providerUrls.length > 0, "providerUrls must not be empty");
  assert.ok(Array.isArray(parsed.modelIds), "modelIds must be an array");
  assert.ok(typeof parsed.counts === "object", "counts must be an object");
  assert.strictEqual(parsed.counts.providerUrls, parsed.providerUrls.length);
  assert.strictEqual(parsed.counts.modelIds, parsed.modelIds.length);
});

test("--json outputs valid JSON with status error on missing config", async () => {
  const defaultsPath = join(__dirname, "..", "src", "core", "defaults.ts");
  const backupPath = join(__dirname, "..", "src", "core", "defaults.ts.bak.test-hc");
  const wasPresent = existsSync(defaultsPath);
  try {
    if (wasPresent) {
      writeFileSync(backupPath, readFileSync(defaultsPath));
      unlinkSync(defaultsPath);
    }
    const result = spawnSync(NODE_BIN, ["scripts/health-check.mjs", "--json"], {
      cwd: join(__dirname, ".."),
      encoding: "utf-8",
      timeout: 15000,
    });
    assert.ok(result.status !== 0, `expected nonzero exit code, got ${result.status}`);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.status, "error");
    assert.ok(typeof parsed.message === "string" && parsed.message.length > 0, "must include error message");
  } finally {
    // Restore defaults.ts
    if (wasPresent && existsSync(backupPath)) {
      writeFileSync(defaultsPath, readFileSync(backupPath));
      unlinkSync(backupPath);
    }
  }
});

test("--json produces no extra lines (only one line of output)", async () => {
  const result = spawnSync(NODE_BIN, ["scripts/health-check.mjs", "--json"], {
    cwd: join(__dirname, ".."),
    encoding: "utf-8",
    timeout: 15000,
  });
  const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
  assert.strictEqual(lines.length, 1, "must output exactly one line of JSON");
});

// ---------------------------------------------------------------------------
// Test: default text mode — human-readable report
// ---------------------------------------------------------------------------

test("default mode outputs human-readable report with Status: OK", async () => {
  const result = spawnSync(NODE_BIN, ["scripts/health-check.mjs"], {
    cwd: join(__dirname, ".."),
    encoding: "utf-8",
    timeout: 15000,
  });
  assert.strictEqual(result.status, 0, `expected exit code 0, got ${result.status}`);
  assert.ok(result.stdout.includes("=== Health Check Report ==="), "must include banner");
  assert.ok(result.stdout.includes("Status: OK"), "must include Status: OK");
  assert.ok(result.stdout.includes("Provider URLs found:"), "must include provider URL count");
  assert.ok(result.stdout.includes("Model identifiers found:"), "must include model count");
});

test("default mode exits 0 on success", async () => {
  const result = spawnSync(NODE_BIN, ["scripts/health-check.mjs"], {
    cwd: join(__dirname, ".."),
    encoding: "utf-8",
    timeout: 15000,
  });
  assert.strictEqual(result.status, 0);
});
