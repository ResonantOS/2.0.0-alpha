import assert from "node:assert/strict";
import test from "node:test";

import {
  isTopFrameSender,
  sanitizeInlineAssistantBody,
  sanitizeResonantContextSnapshot
} from "../resonantos-side-panel-extension/src/lib/background-message-policy.js";

const openAiLikeCredential = ["sk", "abcdefghijklmnop"].join("-");
const githubLikeCredential = ["ghp", "abcdefghijklmnop"].join("_");
const anthropicLikeCredential = ["sk", "ant", "abcdefghijklmnop"].join("-");
const openRouterLikeCredential = ["sk", "or", "v1", "abcdefghijklmnop"].join("-");

test("background policy sanitizes inline assistant payloads", () => {
  const payload = sanitizeInlineAssistantBody({
    action: "TRANSLATE",
    prompt: "token=abc1234567890",
    selection: "hello\0world",
    pageContext: `A ${"x".repeat(6000)}`,
    __proto__: { polluted: true },
  });

  assert.equal(payload.action, "translate");
  assert.equal(payload.prompt, "[redacted]");
  assert.equal(payload.selection, "hello world");
  assert.equal(payload.pageContext.length, 5000);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(payload), ["action", "prompt", "selection", "pageContext"]);
});

test("background policy defaults unknown inline actions to summarize", () => {
  assert.equal(sanitizeInlineAssistantBody({ action: "wallet_sign" }).action, "summarize");
  assert.equal(sanitizeInlineAssistantBody(null).action, "summarize");
});

test("background policy bounds and redacts Resonant Context snapshots", () => {
  const snapshot = sanitizeResonantContextSnapshot({
    title: "Example",
    url: "javascript:alert(1)",
    text: `Visible ${openAiLikeCredential} ${"x".repeat(8000)}`,
    sections: Array.from({ length: 12 }, (_, index) => ({ label: `Section ${index}`, text: `api_key=secret-${index}` })),
  }, {
    tabId: 42,
    url: "https://example.com/page",
  });

  assert.equal(snapshot.tabId, 42);
  assert.equal(snapshot.url, "https://example.com/page");
  assert.equal(snapshot.text.includes(openAiLikeCredential), false);
  assert.equal(snapshot.text.length, 7000);
  assert.equal(snapshot.sections.length, 8);
  assert.match(snapshot.sections[0].text, /\[redacted\]/);
});

test("background policy enforces top-frame snapshot ownership", () => {
  assert.equal(isTopFrameSender({ frameId: 0 }), true);
  assert.equal(isTopFrameSender({ frameId: 1 }), false);
  assert.equal(isTopFrameSender({}), false);
});

test("background policy preserves rich context while redacting nested secrets", () => {
  const snapshot = sanitizeResonantContextSnapshot({
    v: "1.0",
    domain: "github.com",
    title: "Repo",
    url: `https://github.com/org/repo?token=${githubLikeCredential}#access_token=secret`,
    summary: "Active api_key=supersecret-value",
    page: {
      path: "/org/repo/pull/1?code=SECRET",
      title: "Repo",
      headings: [
        `Review ${githubLikeCredential}`,
        "Card 4111 2222 3333 4444"
      ],
      visibleText: "Bearer token=abc1234567890"
    },
    viewport: {
      visibleSections: [
        { id: "#readme", label: "README", text: anthropicLikeCredential, currentlyVisible: true, pctVisible: 77 }
      ],
      activeOverlay: { id: "dialog", type: "dialog", content: "JWT eyJabcdefghijkl.mnopqrstuv.wxyzabcdef" }
    },
    forms: [
      {
        id: "#login",
        name: "Login",
        completeness: 1,
        fields: [
          { name: "password", type: "password", value: "hunter2" },
          { name: "q", type: "search", fieldKind: "search-query", value: "resonantos" }
        ]
      }
    ],
    session: {
      navigation: [{ path: "/settings?token=secret", title: "Settings", dwellMs: 12 }],
      clickTrail: [{ selector: "#save", text: `Save ${openRouterLikeCredential}`, ts: 9 }],
      entryPoint: "https://example.com/start?session=secret"
    },
    domain_data: {
      token: "abc1234567890",
      nested: { heading: "safe", card: "4111-2222-3333-4444" }
    }
  }, { tabId: 9 });

  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.tabId, 9);
  assert.equal(snapshot.url, "https://github.com/org/repo");
  assert.equal(snapshot.page.path, "/org/repo/pull/1");
  assert.match(serialized, /github\.com|README|resonantos/);
  assert.equal(serialized.includes(githubLikeCredential), false);
  assert.equal(serialized.includes(anthropicLikeCredential), false);
  assert.equal(serialized.includes(openRouterLikeCredential), false);
  assert.doesNotMatch(serialized, /4111 2222 3333 4444|4111-2222-3333-4444|hunter2|supersecret-value|abc1234567890/);
  assert.match(snapshot.forms[0].fields[0].value, /\[redacted:credential\]/);
  assert.equal(snapshot.forms[0].fields[1].value, "resonantos");
  assert.equal(snapshot.domain_data.token, "[redacted]");
});
