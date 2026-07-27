import assert from "node:assert/strict";
import test from "node:test";

import {
  inferControlNavigationTarget,
  normalizeBrowserUrl,
  normalizeSearchQuery,
  parseAmazonShoppingTask,
  parseAutonomousBrowserActionIntent,
  parseBrowserNavigationTaskIntent,
  parseClickIntent,
  parseControlIntent,
  parseNaturalBrowserIntent,
  parseNaturalSearchIntent,
  parseQuotedText,
  parseReadPageIntent,
  parseControlContinuationIntent,
  parseScrollIntent,
  parseStructuredPageEditIntent,
  parseSummarizePageIntent,
  parseTypeIntent,
} from "../resonantos-side-panel-extension/src/lib/browser-command-parser.js";

test("browser command parser normalizes safe navigation targets", () => {
  assert.equal(normalizeBrowserUrl("resonantos.com"), "https://resonantos.com/");
  assert.equal(normalizeBrowserUrl("https://resonantos.com/dao/"), "https://resonantos.com/dao/");
  assert.throws(() => normalizeBrowserUrl("file:///tmp/private.txt"), /Only http and https/);
});

test("browser command parser detects natural navigation without swallowing slash commands", () => {
  assert.deepEqual(parseNaturalBrowserIntent("can you go to resonantos.com/dao"), {
    action: "open",
    target: "resonantos.com/dao",
  });
  assert.equal(parseNaturalBrowserIntent("/browser open resonantos.com"), null);
});

test("browser command parser extracts page read, click, type, and scroll intents", () => {
  assert.deepEqual(parseReadPageIntent("can you read this page?"), { action: "read_page" });
  assert.deepEqual(parseReadPageIntent("can you check the loaded page?"), { action: "read_page" });
  assert.deepEqual(parseReadPageIntent("what can you see here?"), { action: "read_page" });
  assert.deepEqual(parseReadPageIntent("tell me about the current website"), { action: "read_page" });
  assert.deepEqual(parseClickIntent('click "Add to cart"'), { text: "Add to cart" });
  assert.deepEqual(parseClickIntent("click About"), { text: "About" });
  assert.deepEqual(parseClickIntent("open the About screen"), { text: "About" });
  assert.equal(parseClickIntent("open resonantos.com"), null);
  assert.deepEqual(parseTypeIntent('type "pizza stone" into the search bar'), { text: "pizza stone", submit: true });
  assert.deepEqual(parseScrollIntent("scroll to the bottom"), { direction: "bottom" });
});

test("browser command parser treats a bare summarize/tldr/recap as summarize-the-page", () => {
  // Bare summarize-family commands = "summarize the page I'm looking at".
  assert.deepEqual(parseSummarizePageIntent("summarize"), { action: "summarize_page" });
  assert.deepEqual(parseSummarizePageIntent("Summarise"), { action: "summarize_page" });
  assert.deepEqual(parseSummarizePageIntent("tldr"), { action: "summarize_page" });
  assert.deepEqual(parseSummarizePageIntent("tl;dr"), { action: "summarize_page" });
  assert.deepEqual(parseSummarizePageIntent("recap"), { action: "summarize_page" });
  assert.deepEqual(parseSummarizePageIntent("sum it up"), { action: "summarize_page" });
  assert.deepEqual(parseSummarizePageIntent("summarize this page"), { action: "summarize_page" });
  assert.deepEqual(parseSummarizePageIntent("please summarize it"), { action: "summarize_page" });
  // A richer ask that only starts with the verb stays out — it belongs in chat.
  assert.equal(parseSummarizePageIntent("summarize these notes: buy milk, call Sam"), null);
  assert.equal(parseSummarizePageIntent("summarize the meeting transcript below"), null);
  // A slash command is handled elsewhere, not here.
  assert.equal(parseSummarizePageIntent("/summarize"), null);
  // A non-summarize read verb is left to the generic read intent.
  assert.equal(parseSummarizePageIntent("read this page"), null);
});

test("browser command parser recognizes bare continuation phrases", () => {
  assert.deepEqual(parseControlContinuationIntent("try again"), { action: "control_continue" });
  assert.deepEqual(parseControlContinuationIntent("continue"), { action: "control_continue" });
  assert.deepEqual(parseControlContinuationIntent("retry"), { action: "control_continue" });
  assert.deepEqual(parseControlContinuationIntent("keep going"), { action: "control_continue" });
  assert.deepEqual(parseControlContinuationIntent("resume"), { action: "control_continue" });
  // A continuation verb that carries a real task is not a bare continuation.
  assert.equal(parseControlContinuationIntent("continue to the checkout and pay"), null);
  assert.equal(parseControlContinuationIntent("try a different search engine"), null);
  assert.equal(parseControlContinuationIntent("/continue"), null);
});

test("browser command parser routes compound navigate-and-act commands as control tasks", () => {
  // Compound: navigation target + follow-up action -> full agent control.
  assert.deepEqual(
    parseBrowserNavigationTaskIntent("go to fifa.com and click on news"),
    { goal: "go to fifa.com and click on news" }
  );
  assert.deepEqual(
    parseBrowserNavigationTaskIntent("open espn.com and search for scores"),
    { goal: "open espn.com and search for scores" }
  );
  assert.deepEqual(
    parseBrowserNavigationTaskIntent("go to amazon.it and find me a rtx5090"),
    { goal: "go to amazon.it and find me a rtx5090" }
  );
  // Pure navigation (no action) stays a plain open, not a control run.
  assert.equal(parseBrowserNavigationTaskIntent("go to resonantos.com/dao"), null);
  assert.equal(parseBrowserNavigationTaskIntent("can you navigate to manoloremiddi.com?"), null);
  // Bare single actions (no navigation target) stay on the current-page fast path.
  assert.equal(parseBrowserNavigationTaskIntent('click "Add to cart"'), null);
  assert.equal(parseBrowserNavigationTaskIntent("scroll to the bottom"), null);
  // Slash commands are never natural-language intents.
  assert.equal(parseBrowserNavigationTaskIntent("/control go to fifa.com and click news"), null);
});

test("browser command parser separates structured edit and control intents", () => {
  assert.deepEqual(parseStructuredPageEditIntent("update the Google Sheet row with the new value"), {
    action: "structured_page_edit",
    instruction: "update the Google Sheet row with the new value",
  });
  assert.deepEqual(parseControlIntent("take control: find available booking slots"), {
    goal: "find available booking slots",
  });
});

test("browser command parser detects autonomous browser work and search work", () => {
  assert.deepEqual(parseAutonomousBrowserActionIntent("go to amazon.it and find jeans under 50 euro"), {
    goal: "go to amazon.it and find jeans under 50 euro",
  });
  assert.deepEqual(parseAutonomousBrowserActionIntent("go to amazon.it and find me a rtx5090"), {
    goal: "go to amazon.it and find me a rtx5090",
  });
  assert.deepEqual(parseAutonomousBrowserActionIntent("check the current website and extract the booking details"), {
    goal: "check the current website and extract the booking details",
  });
  assert.equal(parseAutonomousBrowserActionIntent("go to amazon.it"), null);
  assert.deepEqual(parseNaturalSearchIntent("find latest AI news on the internet"), {
    action: "news",
    query: "latest AI news",
  });
  assert.deepEqual(parseNaturalSearchIntent("hey what's the most inportant new in the world today?"), {
    action: "news",
    query: "news in the world today",
  });
  assert.equal(parseNaturalSearchIntent("go to resonantos.com"), null);
});

test("browser command parser handles quoted text and Amazon shopping tasks", () => {
  assert.equal(parseQuotedText('press "Advanced DNS"'), "Advanced DNS");
  assert.deepEqual(parseAmazonShoppingTask("go to amazon.it and add pringles to the cart"), {
    query: "pringles",
    wantsCart: true,
    url: "https://www.amazon.it/s?k=pringles",
  });
  assert.equal(parseAmazonShoppingTask("add the visible item on this page to the cart"), null);
  assert.equal(inferControlNavigationTarget('read this page, click "Safe Details", type "find resonantos", scroll down'), null);
  assert.equal(inferControlNavigationTarget("research alpha fixture public submit @Alpha."), null);
  assert.equal(normalizeSearchQuery("can you find some news on the internet?"), "top stories");
});
