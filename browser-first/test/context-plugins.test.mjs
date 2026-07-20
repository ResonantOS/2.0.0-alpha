import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const openAiLikeFieldSecret = ["sk", "live", "FIELD", "SECRET", "1234567890"].join("-");
const openAiLikeUrlSecret = ["sk", "live", "URL", "SECRET"].join("-");
const contextPluginsPath = path.join(
  repoRoot,
  "browser-first",
  "resonantos-side-panel-extension",
  "src",
  "lib",
  "context-plugins.js",
);

async function loadRegistry() {
  const dom = new JSDOM("<!doctype html>", { runScripts: "outside-only" });
  dom.window.eval(await readFile(contextPluginsPath, "utf8"));
  return dom.window.ResonantOSContextPlugins;
}

test("context plugin registry selects known domains without suffix spoofing", async () => {
  const registry = await loadRegistry();

  assert.equal(registry.getPluginForDomain("github.com").domain, "github.com");
  assert.equal(registry.getPluginForDomain("docs.github.com").domain, "github.com");
  assert.equal(registry.getPluginForDomain("docs.google.com").domain, "google.com");
  assert.equal(registry.getPluginForDomain("evil-github.com").domain, "generic-web");
  assert.equal(registry.getPluginForDomain("github.com.evil.test").domain, "generic-web");
  assert.equal(registry.hostMatchesDomain("sub.github.com", "github.com"), true);
  assert.equal(registry.hostMatchesDomain("notgithub.com", "github.com"), false);
});

test("context plugin registry exposes restored selector capabilities", async () => {
  const registry = await loadRegistry();
  const github = registry.getPluginForDomain("github.com");
  const google = registry.getPluginForDomain("mail.google.com");

  assert.ok(github.pages.all.sections.some((section) => /Code Diff/.test(section.label)));
  assert.ok(github.pages.all.forms.some((form) => /Issue|Comment|Review/.test(form.name)));
  assert.ok(google.pages.all.sections.some((section) => /Document|Email|Drive/.test(section.label)));
  assert.ok(Array.isArray(registry.UNIVERSAL_OVERLAYS));
});

test("context plugin redaction uses sibling form metadata before preserving values", async () => {
  const registry = await loadRegistry();
  const payload = {
    fields: [
      { name: "password", type: "text", value: "hunter2-secret" },
      { name: "apiKey", value: openAiLikeFieldSecret },
      { name: "client_secret", value: "opaque-client-secret" },
      { label: "Private key", valuePreview: "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----" },
      { name: "q", type: "search", value: "resonantos browser" },
    ],
    auth: "Bearer secret-auth-token",
    nested: { credentials: { token: "session-token-secret" } },
  };

  const redacted = registry.redactSensitiveFields(payload);
  const serialized = JSON.stringify(redacted);

  assert.equal(serialized.includes(openAiLikeFieldSecret), false);
  assert.doesNotMatch(serialized, /hunter2-secret|opaque-client-secret|PRIVATE KEY|secret-auth-token|session-token-secret/);
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /resonantos browser/);
});

test("context plugin URL sanitizer strips all query and hash data", async () => {
  const registry = await loadRegistry();

  assert.equal(
    registry.sanitizeUrlForContext("https://example.test/path?data=OpaqueSecretValue123456#fragment-secret"),
    "https://example.test/path",
  );
  assert.equal(
    registry.sanitizeUrlForContext(`/next?token=${openAiLikeUrlSecret}#card-4111222233334444`, "https://example.test/base"),
    "https://example.test/next",
  );
});
