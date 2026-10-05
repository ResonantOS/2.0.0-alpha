// #410 parity guard. Referenced-tab ("@tab") text is redacted by
// safeContextText in chat-turn-controller.js, which is a hand-maintained copy of
// the content script's _rcSanitizeText (content.js). The two live in different
// module systems (content.js is a classic content script and cannot be
// imported), so they cannot share a function today — this test is the net that
// keeps them from drifting apart silently.
//
// The contract (see the comment above CHAT_TOKEN_PATTERN): the chat-side
// sanitizer must strip AT LEAST as much as a live snapshot does, or scoped-tab
// context would leak a secret that a normal capture redacts. So we assert every
// redaction pattern in _rcSanitizeText also appears in safeContextText —
// i.e. content's pattern set is a SUBSET of chat's. chat may strip more (it also
// scrubs control characters), which is allowed.
//
// Neither sanitizer is callable in isolation (both are file-private), so the
// guard compares the regex literals as they appear in source. The only
// deliberate, functionally-equivalent difference between the two is the
// character-class casing (content uses [A-Za-z…] with the /i flag; chat uses
// [a-z…] with /i), which the normalizer below folds away.

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

test("chat-turn sanitizer strips at least as much as the content-script sanitizer (#410 parity)", async () => {
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
