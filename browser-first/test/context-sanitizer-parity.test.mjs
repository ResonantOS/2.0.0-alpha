// #410 parity guard. Referenced-tab ("@tab") text is redacted by
// safeContextText in chat-turn-controller.js, which is a hand-maintained copy of
// the content script's _rcSanitizeText (content.js). The two live in different
// module systems (content.js is a classic content script and cannot be
// imported), so they cannot share a function today — this test is the net that
// keeps them from drifting apart silently.
//
// The contract (see the comment above CHAT_TOKEN_PATTERN): the chat-side
// sanitizer must strip AT LEAST as much as a live snapshot does, or scoped-tab
// context would leak a secret that a normal capture redacts.
//
// Two complementary guards:
//   1. BEHAVIOURAL (primary): compile both sanitizers from source and run a
//      golden corpus of secret shapes through both, asserting that every secret
//      the content script redacts the chat sanitizer also redacts. This fails if
//      a pattern is declared but no longer applied, or removed, or weakened on
//      one side — the gap a text-only comparison misses.
//   2. STRUCTURAL (secondary): the original regex-literal subset check, kept as a
//      cheap backstop that also catches a divergence on inputs the corpus does
//      not happen to cover.
//
// Both sanitizers stay file-private: we extract each one's source and evaluate
// it in isolation (content's _rcSanitizeText is self-contained; chat's
// safeContextText is sliced together with the CHAT_* pattern constants it
// closes over) rather than adding a production export just for the test.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const extensionSrc = path.resolve(
  import.meta.dirname,
  "..",
  "resonantos-side-panel-extension",
  "src"
);
const contentScriptPath = path.join(extensionSrc, "content.js");
const chatTurnControllerPath = path.join(extensionSrc, "lib", "chat-turn-controller.js");

// Slice out just the sanitizer so unrelated regex literals elsewhere in the file
// (URL handling, etc.) never enter the comparison. Fails loudly if the bounding
// markers move, rather than silently comparing the wrong region.
function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}: could not find start marker "${startMarker}" (did the source move?)`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label}: could not find end marker "${endMarker}" after the start`);
  return source.slice(start, end);
}

// Compile a sanitizer from its extracted source. `slice` ends with (or contains)
// a declaration named `fnName`; we evaluate it in a fresh function scope — with
// no access to module globals — and hand back the callable. This runs the REAL
// redaction code, so a pattern that is declared but never applied is caught.
function compileSanitizer(slice, fnName) {
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${slice}\nreturn ${fnName};`)();
}

// Match /…/flags regex literals. Every redaction pattern in both files is
// single-line and contains no unescaped internal "/", so this stays simple:
// escaped chars, character classes, then any other non-slash char.
const REGEX_LITERAL = /\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g;

// Fold the one deliberate difference (character-class casing) so equivalent
// patterns compare equal. Applied identically to both sides, so a genuine
// structural difference still shows.
function normalizePattern(literal) {
  const body = literal.slice(1).replace(/\/[gimsuy]*$/, "");
  return body
    .replace(/A-Za-z/g, "a-z")
    .replace(/A-Z/g, "a-z")
    .replace(/a-za-z/g, "a-z");
}

function patternSet(slice) {
  return new Set((slice.match(REGEX_LITERAL) ?? []).map(normalizePattern));
}

// Golden corpus: one entry per secret shape both sanitizers must strip. `secret`
// is the exact substring that must NOT survive sanitization. A large `max` is
// passed so trailing truncation never masquerades as redaction. Every token
// value is 12+ chars to clear the {12,} length floors in the patterns.
//
// Each value is a synthetic, non-functional credential SHAPE, needed so the
// corpus exercises the real redaction patterns on realistic inputs (the
// sk-or-v1- OpenRouter prefix, for one, cannot be reduced to an "obvious
// placeholder" the way AKIA can). Provider-key shapes are assembled with
// token() so the contiguous literal never appears in the scanned source and
// repo:hygiene does not read the fixture as a committed credential; the full
// value is still reconstructed at runtime and must be redacted. Same approach
// as the token() helper in scripts/check-repo-hygiene.test.mjs.
const token = (prefix, body) => `${prefix}${body}`;
const SECRET = {
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOAIBAAJAabc123def456ghi789\n-----END RSA PRIVATE KEY-----",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  openai: token("sk-", "abcdefghijklmnop1234"),
  anthropic: token("sk-ant-", "abcdefghijklmnop1234"),
  openrouter: token("sk-or-v1-", "abcdefghijklmnop1234"),
  github: token("ghp_", "abcdefghijklmnop1234"),
  githubPat: token("github_pat_", "abcdefghijklmnop1234"),
  huggingface: "hf_abcdefghijklmnop1234",
  slack: "xoxb-abcdefghijklmnop1234",
  xai: token("xai-", "abcdefghijklmnop1234"),
  groq: token("gsk_", "abcdefghijklmnop1234"),
  google: token("AIza", "AbCdEfGhIjKlMnOp1234"),
  aws: token("AKIA", "ABCDEFGHIJKLMNOP"),
  stripePk: "pk_live_abcdefghijkl1234",
  stripeRk: "rk_live_abcdefghijkl1234",
  labelledApiKey: "sixteencharsecretvalue",
  labelledToken: "anothersecrettokenvalue",
  labelledPassword: "hunter2hunter2hunter2",
  labelledAuthorization: "BasicZm9vOmJhcnNlY3JldA",
  labelledSecret: "topsecretvaluehere12",
  labelledCookie: "sessioncookievalue1234",
  creditCard: "4111 1111 1111 1111"
};

const GOLDEN_VECTORS = [
  { name: "PEM private key block", input: `key:\n${SECRET.privateKey}\n`, secret: "MIIBOAIBAAJAabc123def456ghi789" },
  { name: "JWT", input: `authz ${SECRET.jwt} end`, secret: SECRET.jwt },
  { name: "OpenAI key (sk-)", input: `use ${SECRET.openai} now`, secret: SECRET.openai },
  { name: "Anthropic key (sk-ant-)", input: `use ${SECRET.anthropic} now`, secret: SECRET.anthropic },
  { name: "OpenRouter key (sk-or-v1-)", input: `use ${SECRET.openrouter} now`, secret: SECRET.openrouter },
  { name: "GitHub token (ghp_)", input: `use ${SECRET.github} now`, secret: SECRET.github },
  { name: "GitHub PAT (github_pat_)", input: `use ${SECRET.githubPat} now`, secret: SECRET.githubPat },
  { name: "HuggingFace token (hf_)", input: `use ${SECRET.huggingface} now`, secret: SECRET.huggingface },
  { name: "Slack token (xoxb-)", input: `use ${SECRET.slack} now`, secret: SECRET.slack },
  { name: "xAI key (xai-)", input: `use ${SECRET.xai} now`, secret: SECRET.xai },
  { name: "Groq key (gsk_)", input: `use ${SECRET.groq} now`, secret: SECRET.groq },
  { name: "Google key (AIza)", input: `use ${SECRET.google} now`, secret: SECRET.google },
  { name: "AWS access key (AKIA)", input: `use ${SECRET.aws} now`, secret: SECRET.aws },
  { name: "Stripe publishable (pk_live_)", input: `use ${SECRET.stripePk} now`, secret: SECRET.stripePk },
  { name: "Stripe restricted (rk_live_)", input: `use ${SECRET.stripeRk} now`, secret: SECRET.stripeRk },
  { name: "labelled api_key=", input: `api_key=${SECRET.labelledApiKey}`, secret: SECRET.labelledApiKey },
  { name: "labelled token:", input: `token: ${SECRET.labelledToken}`, secret: SECRET.labelledToken },
  { name: "labelled password=", input: `password=${SECRET.labelledPassword}`, secret: SECRET.labelledPassword },
  { name: "labelled authorization:", input: `authorization: ${SECRET.labelledAuthorization}`, secret: SECRET.labelledAuthorization },
  { name: "labelled secret=", input: `secret=${SECRET.labelledSecret}`, secret: SECRET.labelledSecret },
  { name: "labelled cookie=", input: `cookie=${SECRET.labelledCookie}`, secret: SECRET.labelledCookie },
  { name: "credit-card number", input: `card ${SECRET.creditCard} exp`, secret: SECRET.creditCard }
];

test("chat-turn sanitizer redacts every secret shape the content-script sanitizer redacts (#410 parity, behavioural)", async () => {
  const [contentSource, chatSource] = await Promise.all([
    readFile(contentScriptPath, "utf8"),
    readFile(chatTurnControllerPath, "utf8")
  ]);

  // content's _rcSanitizeText is self-contained; chat's safeContextText is
  // sliced together with the CHAT_* pattern constants it references.
  const contentSanitize = compileSanitizer(
    sliceBetween(contentSource, "function _rcSanitizeText", "function _rcSanitizeUrl", "content.js _rcSanitizeText"),
    "_rcSanitizeText"
  );
  const chatSanitize = compileSanitizer(
    sliceBetween(chatSource, "const CHAT_PRIVATE_KEY_PATTERN", "function safeContextUrl", "chat-turn-controller.js safeContextText"),
    "safeContextText"
  );

  // The corpus must actually drive the content sanitizer, or the superset check
  // below passes vacuously for any vector content doesn't touch. Today content
  // redacts every vector, so the baseline is "all of them". If a shape is ever
  // added that content legitimately does NOT strip (e.g. the `Authorization:
  // Bearer` scheme word, left in place per #510), name it here with a reason so
  // the slack is explicit and can never silently mask a real redaction gap.
  const CONTENT_MAY_NOT_REDACT = new Set([]);
  const unexpectedlyUnredacted = GOLDEN_VECTORS
    .filter((v) => contentSanitize(v.input, 100000).includes(v.secret) && !CONTENT_MAY_NOT_REDACT.has(v.name))
    .map((v) => v.name);
  assert.deepEqual(
    unexpectedlyUnredacted,
    [],
    `golden corpus must exercise the content sanitizer, but content.js did not redact: ${unexpectedlyUnredacted.join(", ")} ` +
      `(add to CONTENT_MAY_NOT_REDACT with a reason only if leaving it unredacted is intended)`
  );

  // The contract: chat strips at least as much as content. For every secret the
  // content script removes, the chat sanitizer must remove it too.
  const leaks = [];
  for (const vector of GOLDEN_VECTORS) {
    const contentOut = contentSanitize(vector.input, 100000);
    const chatOut = chatSanitize(vector.input, 100000);
    const contentRedacted = !contentOut.includes(vector.secret);
    const chatRedacted = !chatOut.includes(vector.secret);
    if (contentRedacted && !chatRedacted) leaks.push(vector.name);
  }
  assert.deepEqual(
    leaks,
    [],
    `chat-turn-controller.js safeContextText leaks secret shapes that content.js _rcSanitizeText redacts — ` +
      `referenced-tab text would leak secrets a live snapshot strips:\n  ${leaks.join("\n  ")}`
  );
});

test("chat-turn sanitizer's redaction patterns are a superset of the content-script's (#410 parity, structural backstop)", async () => {
  const [contentSource, chatSource] = await Promise.all([
    readFile(contentScriptPath, "utf8"),
    readFile(chatTurnControllerPath, "utf8")
  ]);

  const contentSlice = sliceBetween(
    contentSource,
    "function _rcSanitizeText",
    "function _rcSanitizeUrl",
    "content.js _rcSanitizeText"
  );
  // Covers the four CHAT_* pattern constants plus the inline patterns inside
  // safeContextText (credit-card, control-char, whitespace).
  const chatSlice = sliceBetween(
    chatSource,
    "CHAT_PRIVATE_KEY_PATTERN",
    "function safeContextUrl",
    "chat-turn-controller.js safeContextText"
  );

  const contentPatterns = patternSet(contentSlice);
  const chatPatterns = patternSet(chatSlice);

  // Extraction sanity: if the regex-literal matcher or the slice markers ever
  // stop finding the real patterns, the subset check below would pass
  // vacuously. Anchor on a stable, secret-specific pattern to prevent that.
  assert.ok(contentPatterns.size >= 5, `expected to extract the content-script redaction patterns, got ${contentPatterns.size}`);
  assert.ok(
    [...contentPatterns].some((pattern) => pattern.includes("PRIVATE KEY")),
    "extraction sanity: the PEM private-key pattern must be among the extracted content-script patterns"
  );

  const missing = [...contentPatterns].filter((pattern) => !chatPatterns.has(pattern));
  assert.deepEqual(
    missing,
    [],
    `chat-turn-controller.js safeContextText is missing redaction pattern(s) present in content.js _rcSanitizeText — ` +
      `referenced-tab text would leak secrets a live snapshot redacts. Add the pattern(s) to keep parity:\n  ${missing.join("\n  ")}`
  );
});
