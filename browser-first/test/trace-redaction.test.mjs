import test from "node:test";
import assert from "node:assert/strict";

import { redactTraceText } from "../resonantos-side-panel-extension/src/lib/trace-redaction.js";

test("redactTraceText redacts secret URL query parameters and preserves benign ones", () => {
  const input = "https://example.test/login?token=abc123&email=a@b.com&api_key=sekrit&ref=home";
  const output = redactTraceText(input);
  assert.equal(output, "https://example.test/login?token=REDACTED&email=a@b.com&api_key=REDACTED&ref=home");
});

test("redactTraceText redacts secret assignment forms", () => {
  assert.equal(redactTraceText("password=hunter2secret"), "password=REDACTED");
  assert.equal(redactTraceText("password: hunter2secret"), "password: REDACTED");
  assert.equal(redactTraceText("password:hunter2secret"), "password:REDACTED");
  const bearer = redactTraceText("Token: Bearer abc123");
  assert.match(bearer, /Token: REDACTED/);
  assert.doesNotMatch(bearer, /Bearer/);
  assert.equal(redactTraceText("api_key = super-secret-value"), "api_key = REDACTED");
  assert.equal(redactTraceText("pin: 9876"), "pin: REDACTED");
  assert.equal(redactTraceText("otp is 123456"), "otp is 123456");
});

test("redactTraceText redacts long hex tokens and preserves short hex and normal text", () => {
  const longHex = "7f3c9a1b2d4e5f68790a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f";
  assert.equal(redactTraceText(`token ${longHex} end`), "token [REDACTED-TOKEN] end");
  assert.equal(redactTraceText("color #f3c9a1"), "color #f3c9a1");
  assert.equal(redactTraceText("the quick brown fox"), "the quick brown fox");
});

test("redactTraceText returns an empty string for non-string input", () => {
  assert.equal(redactTraceText(undefined), "");
  assert.equal(redactTraceText(null), "");
  assert.equal(redactTraceText(42), "");
  assert.equal(redactTraceText({ token: "abc" }), "");
});

test("redactTraceText leaves clean trace text unchanged", () => {
  const clean = [
    "# Browser Job Report",
    "- status: completed",
    "1. Read page - ok - read product page",
    "## Boundary",
    "Intake artifact only."
  ].join("\n");
  assert.equal(redactTraceText(clean), clean);
});
