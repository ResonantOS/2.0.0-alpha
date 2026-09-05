import assert from "node:assert/strict";
import test from "node:test";

// The gate is a CLASSIC content script (see content-scripts-parse-as-classic.test.mjs):
// import it for its side effect and read the API it publishes on globalThis.
import "../resonantos-side-panel-extension/src/lib/content-inline-action-surface-gate.js";
const {
  INLINE_RESTRICTED_SCHEMES,
  inlineActionRestrictedScheme,
  inlineActionAllowedForLocationGate
} = globalThis.ResonantOSInlineActionSurfaceGate;

test("inline-action surface gate exposes the same restricted-scheme prefixes as control-target-classification (#219)", () => {
  // The two sources of truth must agree. control-target-classification.js
  // defines the prefixes used by Agent Control; this module mirrors them for
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("chrome://"));
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("chrome-untrusted://"));
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("chrome-extension://"));
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("devtools://"));
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("view-source:"));
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("about:"));
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("edge://"));
  assert.ok(INLINE_RESTRICTED_SCHEMES.includes("brave://"));
});

test("inline-action surface gate allows ordinary http(s) URLs (#219)", () => {
  const result = inlineActionAllowedForLocationGate("https://example.com/article");
  assert.equal(result.allowed, true);
  const result2 = inlineActionAllowedForLocationGate("http://example.com/");
  assert.equal(result2.allowed, true);
});

test("inline-action surface gate denies restricted-scheme URLs with a clear message (#219)", () => {
  const cases = [
    "chrome://settings/",
    "chrome-extension://abcd/popup.html",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com/",
    "about:blank",
    "edge://settings/",
    "brave://settings/",
    "chrome-untrusted://terminal/"
  ];
  for (const url of cases) {
    const result = inlineActionAllowedForLocationGate(url);
    assert.equal(result.allowed, false, `expected denied for ${url}`);
    assert.equal(result.reason, "restricted-scheme");
    assert.match(result.message, /Augmentor inline actions are disabled on this page/);
    assert.match(result.message, /Chrome blocks extensions/);
  }
});

test("inline-action surface gate denies empty URLs (#219)", () => {
  const result = inlineActionAllowedForLocationGate("");
  assert.equal(result.allowed, false);
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});

test("inlineActionRestrictedScheme returns the matching prefix string (#219)", () => {
  assert.equal(inlineActionRestrictedScheme("chrome://settings/"), "chrome://");
  assert.equal(inlineActionRestrictedScheme("CHROME://settings/"), "chrome://");
  assert.equal(inlineActionRestrictedScheme("about:blank"), "about:");
  assert.equal(inlineActionRestrictedScheme("https://example.com/"), "");
  assert.equal(inlineActionRestrictedScheme(null), "no open web page");
  assert.equal(inlineActionRestrictedScheme(""), "no open web page");
});
