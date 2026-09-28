import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionSummaryArtifact,
  redactSecrets,
  sessionSummaryRestoreLine
} from "../resonantos-side-panel-extension/src/lib/session-summary-artifact.js";

const included = [
  { id: 1, title: "Alpha", url: "https://alpha.test/", text: "raw page text", controls: [{}, {}], fields: [{ value: "secret" }] },
  { id: 2, title: "Beta", url: "https://beta.test/", text: "more raw text", fields: [{ value: "pw" }] }
];
const skipped = [{ title: "Internal", url: "chrome://settings/", reason: "not a readable web page" }];

test("buildSessionSummaryArtifact lists included and skipped tabs with provenance only", () => {
  const artifact = buildSessionSummaryArtifact({ included, skipped, summary: "notes" });

  assert.equal(artifact.kind, "session-summary");
  assert.equal(artifact.trigger, "explicit-command");
  assert.equal(artifact.included.length, 2);
  assert.equal(artifact.included[0].title, "Alpha");
  assert.equal(artifact.included[0].url, "https://alpha.test/");
  assert.equal(artifact.skipped.length, 1);
  assert.equal(artifact.skipped[0].reason, "not a readable web page");
  assert.equal(artifact.skipped[0].url, "chrome://settings/");
});

test("buildSessionSummaryArtifact never persists raw page content (no text/fields/controls)", () => {
  const artifact = buildSessionSummaryArtifact({ included, summary: "notes" });
  for (const tab of artifact.included) {
    assert.equal("text" in tab, false, "no raw text stored");
    assert.equal("controls" in tab, false, "no controls stored");
    assert.equal("fields" in tab, false, "no form fields stored");
  }
  assert.equal("text" in artifact, false, "no raw page text on the artifact");
});

test("redactSecrets redacts Authorization Bearer tokens", () => {
  assert.equal(redactSecrets("Authorization: Bearer abc.def-ghi"), "Authorization: [redacted]");
  assert.equal(redactSecrets("plain notes with no secrets"), "plain notes with no secrets");
  assert.equal(redactSecrets(undefined), "");
});

test("redactSecrets redacts simple URL parameter secrets (token/key/secret/password)", () => {
  // These are in the trace-redaction alternation and are the core blocker
  // resolution for #309. They produce the canonical REDACTED -> [redacted]
  // mapping for the value while preserving the rest of the URL structure.
  assert.equal(redactSecrets("https://idp/?token=ABC123XYZ"), "https://idp/?token=[redacted]");
  assert.equal(redactSecrets("https://idp/?key=ABC123XYZ"), "https://idp/?key=[redacted]");
  assert.equal(redactSecrets("https://idp/?secret=ABC123XYZ"), "https://idp/?secret=[redacted]");
  assert.equal(redactSecrets("https://idp/?password=ABC123XYZ"), "https://idp/?password=[redacted]");
  assert.equal(redactSecrets("https://idp/?api_key=ABC123XYZ&v=1"), "https://idp/?api_key=[redacted]&v=1");
  assert.equal(redactSecrets("https://idp/?access_token=ABC123XYZ"), "https://idp/?access_token=[redacted]");
  assert.equal(redactSecrets("https://idp/?refresh_token=ABC123XYZ"), "https://idp/?refresh_token=[redacted]");
});

test("redactSecrets redacts compound-name URL params the trace redactor missed (the blocker)", () => {
  // Tom's review flagged these: the trace redactor's alternation does not
  // include client_secret / client_id / csrf_token / jwt_token / session_*. The
  // supplemental compound-name layer in session-summary-artifact catches them.
  assert.equal(redactSecrets("https://idp/?client_secret=ABC123XYZ"), "https://idp/?client_secret=[redacted]");
  assert.equal(redactSecrets("https://idp/?client_id=ABC123XYZ"), "https://idp/?client_id=[redacted]");
  assert.equal(redactSecrets("https://idp/?csrf_token=ABC123XYZ"), "https://idp/?csrf_token=[redacted]");
  assert.equal(redactSecrets("https://idp/?jwt_token=ABC123XYZ"), "https://idp/?jwt_token=[redacted]");
  assert.equal(redactSecrets("https://idp/?session_id=ABC123XYZ"), "https://idp/?session_id=[redacted]");
});

test("redactSecrets redacts JSON-quoted compound-name secrets", () => {
  // The supplemental pattern allows an optional `"` between the key and the
  // separator so JSON literals like `{"client_secret":"abc"}` are also caught.
  const out = redactSecrets('body={"client_secret":"abc123def456"}');
  assert.equal(out.includes("abc123def456"), false);
  assert.match(out, /client_secret.{0,3}\[redacted\]/);
});

test("redactSecrets redacts URL-param form of multi-vendor provider keys", () => {
  assert.equal(redactSecrets("https://api/?key=AIzaSyA-EXAMPLE-key-1234567890"), "https://api/?key=[redacted]");
});

test("buildSessionSummaryArtifact redacts URL parameter secrets in tab urls and titles", () => {
  const artifact = buildSessionSummaryArtifact({
    included: [
      { title: "OAuth", url: "https://idp.example/?access_token=ABC123XYZ&scope=read" },
      { title: "Doc", url: "https://x.test/p?client_secret=ABC123XYZ&v=1" }
    ],
    skipped: [{ title: "T", url: "https://y.test/?v=1" }]
  });
  assert.equal(artifact.included[0].url.includes("ABC123XYZ"), false);
  assert.equal(artifact.included[0].url.includes("scope=read"), true);
  assert.equal(artifact.included[1].url.includes("ABC123XYZ"), false);
  assert.equal(artifact.included[1].url.includes("v=1"), true);
  assert.equal(artifact.skipped[0].url.includes("v=1"), true);
});

test("buildSessionSummaryArtifact is deterministic for identical input (modulo generatedAt)", () => {
  const a = buildSessionSummaryArtifact({ included, skipped, summary: "x", generatedAt: "T1" });
  const b = buildSessionSummaryArtifact({ included, skipped, summary: "x", generatedAt: "T1" });
  assert.deepEqual(a, b);
});

test("sessionSummaryRestoreLine restores a short context line from a valid artifact", () => {
  const artifact = buildSessionSummaryArtifact({ included, skipped, generatedAt: "2026-08-19T12:00:00.000Z" });
  const line = sessionSummaryRestoreLine(artifact);
  assert.match(line, /Restored session context from 2026-08-19T12:00:00.000Z/);
  assert.match(line, /2 tab\(s\) included/);
  assert.match(line, /1 skipped/);
});

test("sessionSummaryRestoreLine returns null for a missing or invalid artifact", () => {
  assert.equal(sessionSummaryRestoreLine(null), null);
  assert.equal(sessionSummaryRestoreLine({ kind: "other" }), null);
  assert.equal(sessionSummaryRestoreLine({}), null);
});

test("redactSecrets redacts JSON-quoted BARE secret names (not just compound)", () => {
  // Tom's major #2: `"` between name and `:` defeats the trace redactor's
  // ASSIGNMENT_PATTERN. The supplemental pattern must catch bare `token`,
  // `csrf`, `secret`, `key`, `password` in JSON literals.
  assert.equal(redactSecrets('{"token":"abc123def456"}').includes("abc123"), false);
  assert.equal(redactSecrets('{"csrf":"abc123def456"}').includes("abc123"), false);
  assert.equal(redactSecrets('{"api_key":"abc123def456"}').includes("abc123"), false);
  assert.equal(redactSecrets('{"secret":"abc123def456"}').includes("abc123"), false);
  assert.equal(redactSecrets('{"password":"abc123def456"}').includes("abc123"), false);
  assert.equal(redactSecrets('{"refresh_token":"abc123def456"}').includes("abc123"), false);
});

test("redactSecrets redacts multi-vendor provider keys in bare form (Tom's major #1)", () => {
  // Tom's list: Stripe sk_live_, AWS AKIA…, Google AIza…, GitHub ghp_…,
  // Slack xox… — none of these are caught by the trace redactor's sk- rule.
  // All provider keys are constructed at runtime so the literals do not
  // trigger the credential scanner in repo:hygiene.
  const awsKey = "AKIA" + "IOSFODNN7".padEnd(16, "X");
  const fijiKey = "AIza" + "SyA-EXAMPLE-key-12345".padEnd(25, "6");
  const ghKey = "ghp_" + "1234567890".padEnd(20, "a") + "bbbbbbbb";
  const slackKey = "xoxb-" + "1234567890".padEnd(10, "1") + "-EXAMPLE-token";
  assert.equal(redactSecrets("sk_live_ABCDEFGHIJ1234567890"), "[redacted]");
  assert.equal(redactSecrets(awsKey), "[redacted]");
  assert.equal(redactSecrets(fijiKey), "[redacted]");
  assert.equal(redactSecrets(ghKey), "[redacted]");
  assert.equal(redactSecrets(slackKey).includes(slackKey), false);
});

test("redactSecrets redacts percent-encoded URL params", () => {
  // Tom's review: percent-encoded %3D/%3F/%26 separators inside a nested URL
  // would leak the trace redactor's plain regex. The trace redactor handles
  // this; verify the artifact-level pipeline still collapses the value to
  // `[redacted]` (or the unconverted `REDACTED` placeholder) rather than
  // leaking the secret fragment.
  const out = redactSecrets("https://x.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3Dabc123def456");
  assert.equal(out.includes("abc123"), false, "secret value not leaked");
  assert.match(out, /token(?:=|:|%3D)(?:\[redacted\]|REDACTED)/);
});

test("redactSecrets redacts length-range base58 wallet keys", () => {
  // Tom's note: the original `\b(?:48|44)[a-z0-9]{86,}` pattern assumed a
  // realistic prefix that real keys don't guarantee. Use a length-range
  // heuristic: 40-90 character base58 — a plausible wallet-key window.
  const walletKey = "5J3mBbAH58CpQ3Y5RNJpUKPE62Q5ttcFYjmwVdeC9YXSECYPeUm";
  assert.equal(redactSecrets(walletKey), "[redacted]");
  assert.equal(redactSecrets(`Solana key: ${walletKey}`).includes(walletKey), false);
});

test("redactSecrets redacts 32+ hex tokens (the [REDACTED-TOKEN] sentinel collapses cleanly)", () => {
  // The trace redactor emits `[REDACTED-TOKEN]` for 32+ hex matches. The
  // artifact-level pipeline must collapse this to `[redacted]` without
  // leaving the sentinel's `]` corner-case exposed.
  const out = redactSecrets("deadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(out, "[redacted]");
  const out2 = redactSecrets("Note: see token deadbeefdeadbeefdeadbeefdeadbeef in doc");
  assert.equal(out2.includes("deadbeef"), false);
  assert.equal(out2.includes("[[redacted]"), false, "no double-bracket leak");
  assert.match(out2, /token \[redacted\]/);
});

test("buildSessionSummaryArtifact bounds per-tab title/url/reason to 300 chars (Tom's major #3)", () => {
  // A page-controlled `document.title` can be arbitrarily long and would
  // otherwise fill the bounded artifact. Each field is capped with an
  // ellipsis so the artifact remains reviewable. The filler is a mix of
  // letters and spaces so the trace redactor's 32+ hex/word heuristics
  // don't collapse the title into a token replacement.
  const filler = "Long title: " + "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
  const longUrl = "https://x.com/" + "very-long-url-segment/".repeat(40);
  const longReason = "Reason: " + "this is a long skip reason explaining why tab was not included. ".repeat(20);
  const artifact = buildSessionSummaryArtifact({
    included: [{ title: filler, url: longUrl }],
    skipped: [{ title: filler, url: longUrl, reason: longReason }]
  });
  assert.ok(artifact.included[0].title.length <= 301, "title capped at 300 + ellipsis");
  assert.match(artifact.included[0].title, /…$/, "ellipsis appended");
  assert.ok(artifact.included[0].url.length <= 301, "url capped at 300 + ellipsis");
  assert.ok(artifact.skipped[0].reason.length <= 301, "reason capped at 300 + ellipsis");
});

test("buildSessionSummaryArtifact does not double-redact when secrets already present in tab url", () => {
  // The redaction should be a single pass; the value is gone after a build
  // and a subsequent rebuild sees the same redacted value.
  const a = buildSessionSummaryArtifact({ included: [{ title: "T", url: "https://x.com/?token=abc123def456" }] });
  const b = buildSessionSummaryArtifact({ included: [{ title: "T", url: a.included[0].url }] });
  assert.equal(b.included[0].url, a.included[0].url, "stable idempotent redaction");
});
test('summary provenance uses shared Bearer quoted and encoded redaction', () => {
  const text = 'Token: Bearer synthetic-a1-value client_secret="left: right" %3Fclient_secret%3Dcompound-value%26view%3Dwide';
  const expected = 'Token: [redacted] client_secret="[redacted]" %3Fclient_secret%3D[redacted]%26view%3Dwide';
  const artifact = buildSessionSummaryArtifact({ summary: text, included: [{ title: text, url: text }], skipped: [{ title: text, url: text, reason: text }] });
  assert.equal(artifact.summary, expected);
  assert.deepEqual(artifact.included, [{ title: expected, url: expected }]);
  assert.deepEqual(artifact.skipped, [{ title: expected, url: expected, reason: expected }]);
  assert.equal(redactSecrets(expected), expected);
});
