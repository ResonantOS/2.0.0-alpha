import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatTurnController,
  pageContextForSnapshot,
  providerMessagesFromHistory,
  runtimeContextForAttachments,
  tabContextsForScopedTabs
} from "../resonantos-side-panel-extension/src/lib/chat-turn-controller.js";

test("chat turn controller builds compact page and runtime context", () => {
  assert.equal(pageContextForSnapshot(null), null);
  assert.equal(pageContextForSnapshot({ title: "Page", url: "https://example.com/", text: "Visible" }), "Title: Page\n\nURL: https://example.com/\n\nVisible text:\nVisible");
  assert.equal(runtimeContextForAttachments([]), null);
  assert.equal(runtimeContextForAttachments([
    { name: "a.md", content: "alpha" },
    { name: "b.pdf", summary: "metadata only" }
  ]), "Composer attachments:\n- a.md: alpha\n- b.pdf: metadata only");
});

test("chat turn controller formats sanitized rich Resonant Context snapshots", () => {
  const ghp = ["ghp", "abcdefghijklmnop"].join("_");
  const skAnt = ["sk", "ant", "abcdefghijklmnop"].join("-");
  const context = pageContextForSnapshot({
    title: "Repo",
    url: "https://github.com/org/repo",
    domain: "github.com",
    summary: "Reviewing pull request",
    text: "Visible project text",
    page: {
      headings: ["Implementation plan", `Token ${ghp}`]
    },
    viewport: {
      visibleSections: [
        { label: "Code Diff", text: "Changed file", currentlyVisible: true },
      ],
      activeOverlay: { content: `Dialog ${skAnt}` }
    },
    forms: [
      {
        name: "Comment Box",
        fields: [
          { name: "comment", fieldKind: "document-edit", value: "[redacted:document-edit]" },
          { name: "q", fieldKind: "search-query", value: "resonantos" }
        ]
      }
    ],
    session: {
      clickTrail: [{ text: "Review changes" }]
    }
  });

  assert.match(context, /Domain plugin: github\.com/);
  assert.match(context, /Summary:\nReviewing pull request/);
  assert.match(context, /Headings:\n- Implementation plan/);
  assert.match(context, /Visible sections:\n- Code Diff visible: Changed file/);
  assert.match(context, /Forms:\n- Comment Box:/);
  assert.match(context, /Recent clicks:\n- Review changes/);
  assert.ok(!context.includes(ghp) && !context.includes(skAnt), "page-context secrets should be redacted");
});

test("chat turn controller strips query and hash secrets from page context URLs", () => {
  const skLive = ["sk", "live", "URL", "SECRET"].join("-");
  const skLivePrefix = ["sk", "live"].join("-");
  const card = ["4111", "2222", "3333", "4444"].join("");
  const context = pageContextForSnapshot({
    title: "Secret URL",
    url: `https://example.com/account?token=${skLive}#card-${card}`,
    text: "Visible text"
  });

  assert.match(context, /URL: https:\/\/example\.com\/account/);
  assert.ok(!context.includes(skLivePrefix) && !context.includes(card) && !/token=|#card/.test(context), "URL query/hash secrets should be stripped");
});

test("chat turn controller filters provider messages to recent user/assistant turns", () => {
  const messages = [
    { role: "system", content: "skip" },
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" }
  ];

  assert.deepEqual(providerMessagesFromHistory(messages, 2), [
    { role: "assistant", content: "two" },
    { role: "user", content: "three" }
  ]);
});

function createHarness({ fail = false, failureError = new Error("provider down"), systemPrompt = "", scopedContexts = [] } = {}) {
  const events = [];
  const attachments = [{ name: "notes.md", content: "notes" }];
  const messages = [
    { role: "system", content: "skip" },
    { role: "user", content: "hello" }
  ];
  const controller = createChatTurnController({
    addMessage: async (role, content, options = {}) => events.push(["message", role, content, options]),
    bridgeRequest: async (path, request) => {
      events.push(["bridge", path, request]);
      if (fail) throw failureError;
      return { reply: "answer", providerId: "provider-a", model: "model-a", usage: { tokens: 7 } };
    },
    chatSessionStore: {
      getAttachments: () => attachments,
      getMessages: () => messages
    },
    clearActivitySoon: () => events.push(["clearActivitySoon"]),
    clearAttachments: async () => events.push(["clearAttachments"]),
    consumeScopedTabContexts: () => scopedContexts,
    getLastSnapshot: () => ({ title: "Page", url: "https://example.com/", text: "Visible" }),
    getModel: () => "MiniMax-M3",
    getSystemPrompt: () => systemPrompt,
    getThinkingDepth: () => "high",
    setActivity: (...args) => events.push(["activity", ...args]),
    setStatus: (status) => events.push(["status", status])
  });
  return { controller, events };
}

test("chat turn controller calls provider and records assistant reply", async () => {
  const harness = createHarness();

  await harness.controller.runChatTurn();

  assert.deepEqual(harness.events[0], ["status", "Thinking"]);
  assert.ok(harness.events.some((event) => event[0] === "bridge" && event[1] === "/augmentor/chat"));
  const bridgeEvent = harness.events.find((event) => event[0] === "bridge");
  assert.equal(bridgeEvent[2].body.model, "MiniMax-M3");
  assert.equal(bridgeEvent[2].body.surface, "side-panel");
  assert.equal(bridgeEvent[2].body.systemPrompt, "");
  assert.equal(bridgeEvent[2].body.workload, "augmentor-chat");
  assert.equal(bridgeEvent[2].body.thinkingDepth, "high");
  assert.match(bridgeEvent[2].body.pageContext, /Visible text/);
  assert.match(bridgeEvent[2].body.runtimeContext, /notes\.md/);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[1] === "assistant" && event[2] === "answer"));
  assert.ok(harness.events.some((event) => event[0] === "clearAttachments"));
  assert.deepEqual(harness.events.at(-1), ["clearActivitySoon"]);
});

test("chat turn controller forwards the user-configured Augmentor prompt", async () => {
  const harness = createHarness({ systemPrompt: "Use the ResonantOS profile rules." });

  await harness.controller.runChatTurn();

  const bridgeEvent = harness.events.find((event) => event[0] === "bridge");
  assert.equal(bridgeEvent[2].body.systemPrompt, "Use the ResonantOS profile rules.");
});

test("chat turn controller reports provider failure", async () => {
  const harness = createHarness({ fail: true });

  await harness.controller.runChatTurn();

  assert.ok(harness.events.some((event) => event[0] === "status" && event[1] === "Provider failed"));
  assert.ok(harness.events.some((event) => event[0] === "message" && event[1] === "system" && /Model connection unavailable: provider down/.test(event[2])));
  assert.ok(harness.events.some((event) => event[0] === "message" && event[1] === "system" && /Settings > Providers/.test(event[2])));
  assert.deepEqual(harness.events.at(-1), ["clearActivitySoon"]);
});

test("chat turn controller replaces raw fetch failures with bridge setup guidance", async () => {
  const harness = createHarness({ fail: true, failureError: new TypeError("Failed to fetch") });

  await harness.controller.runChatTurn();

  const message = harness.events.find((event) => event[0] === "message" && event[1] === "system")?.[2] ?? "";
  assert.match(message, /Model connection unavailable/);
  assert.match(message, /ResonantOS bridge is unreachable/);
  assert.match(message, /Settings > Bridge Target/);
  assert.doesNotMatch(message, /Failed to fetch/);
});
test("tabContextsForScopedTabs budgets and sanitizes per-tab context blocks", () => {
  assert.deepEqual(tabContextsForScopedTabs(null), []);
  assert.deepEqual(tabContextsForScopedTabs([]), []);
  assert.deepEqual(tabContextsForScopedTabs([null, {}]), []);

  const contexts = tabContextsForScopedTabs([
    { tabId: 1, title: "Alpha", url: "https://alpha.test/", text: "alpha text" },
    { tabId: 2, title: "Beta", url: "https://beta.test/", text: "B".repeat(9000) }
  ]);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].text, "alpha text");
  assert.equal(contexts[1].text.length, 6000, "12000-char budget is split evenly across referenced tabs");

  const single = tabContextsForScopedTabs([{ tabId: 1, title: "Alpha", url: "https://alpha.test/", text: "A".repeat(20000) }]);
  assert.equal(single[0].text.length, 12000, "a single referenced tab gets the whole budget");
});

test("chat turn controller attaches tab contexts and provenance chips for scoped requests", async () => {
  const skLive = ["sk", "live", "TABS", "ECRET"].join("-");
  const harness = createHarness({
    scopedContexts: [
      { tabId: 1, mention: "Alpha News", title: "Alpha News", url: "https://alpha.test/", text: "Alpha visible text" },
      { tabId: 2, mention: "Beta Report", title: "Beta Report", url: `https://beta.test/?token=${skLive}`, text: "Beta visible text" }
    ]
  });

  await harness.controller.runChatTurn();

  const bridgeEvent = harness.events.find((event) => event[0] === "bridge");
  const tabContexts = bridgeEvent[2].body.tabContexts;
  assert.equal(tabContexts.length, 2);
  assert.equal(tabContexts[0].tabId, 1);
  assert.equal(tabContexts[0].title, "Alpha News");
  assert.match(tabContexts[0].text, /Alpha visible text/);
  assert.doesNotMatch(tabContexts[1].url, /token=/, "referenced tab URLs are stripped of query secrets");

  const assistant = harness.events.find((event) => event[0] === "message" && event[1] === "assistant");
  assert.deepEqual(assistant[3]?.chips, [
    { title: "Alpha News", url: "https://alpha.test/" },
    { title: "Beta Report", url: "https://beta.test/" }
  ], "assistant reply carries the request-side provenance chips");
});

test("chat turn controller sends no tab contexts for unscoped requests", async () => {
  const harness = createHarness();

  await harness.controller.runChatTurn();

  const bridgeEvent = harness.events.find((event) => event[0] === "bridge");
  assert.deepEqual(bridgeEvent[2].body.tabContexts, []);
  const assistant = harness.events.find((event) => event[0] === "message" && event[1] === "assistant");
  assert.deepEqual(assistant[3]?.chips, []);
});
