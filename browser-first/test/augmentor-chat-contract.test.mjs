import assert from "node:assert/strict";
import test from "node:test";

import {
  augmentorSurfaceInstruction,
  buildAugmentorChatRequestMessages,
  buildAugmentorSystemPrompt,
  sanitizeAugmentorChatMessages
} from "../host/augmentor-chat-contract.mjs";

test("Augmentor chat contract preserves browser and delegation capability boundaries", () => {
  const prompt = buildAugmentorSystemPrompt({
    pageContext: "Title: Example\nURL: https://example.com/",
    runtimeContext: "Provider route ready",
    systemPrompt: "Use my profile."
  });

  assert.match(prompt, /Strategist agent inside ResonantOS/);
  assert.match(prompt, /host-mediated browser tools/);
  assert.match(prompt, /Agent Control Mode/);
  assert.match(prompt, /current\/latest news/);
  assert.match(prompt, /web research/);
  assert.match(prompt, /may delegate to approved add-on agents such as Hermes, OpenCode, and Resonant Engineer/);
  assert.match(prompt, /never claim delegation is outside Augmentor's ResonantOS capabilities/);
  assert.match(prompt, /If such a browser-action request reaches you anyway/);
  assert.match(prompt, /lack internet access/);
  assert.match(prompt, /Current browser page context/);
  assert.match(prompt, /Current ResonantOS runtime context/);
  assert.doesNotMatch(prompt, /I can't browse/i);
  assert.doesNotMatch(prompt, /text-only assistant/i);
});

test("Augmentor chat contract describes the active chat surface explicitly", () => {
  const sidePanelPrompt = buildAugmentorSystemPrompt({});
  const mainWorkspacePrompt = buildAugmentorSystemPrompt({ surface: "main-workspace" });

  assert.equal(augmentorSurfaceInstruction(), "You are running inside the ResonantOS browser side bar.");
  assert.match(sidePanelPrompt, /browser side bar/);
  assert.doesNotMatch(sidePanelPrompt, /full ResonantOS main workspace/);
  assert.match(mainWorkspacePrompt, /full ResonantOS main workspace/);
  assert.doesNotMatch(mainWorkspacePrompt, /browser side bar/);
  assert.match(
    buildAugmentorSystemPrompt({ surface: "archive-intake" }),
    /browser-page intake summarizer for the Living Archive review queue/
  );
});

test("Augmentor chat contract filters untrusted message roles and keeps user turns", () => {
  assert.deepEqual(sanitizeAugmentorChatMessages([
    { role: "system", content: "drop" },
    { role: "tool", content: "drop" },
    { role: "user", content: "  navigate to example.com  " },
    { role: "assistant", content: "  needs Agent Control  " },
    { role: "user", content: "" }
  ]), [
    { role: "user", content: "navigate to example.com" },
    { role: "assistant", content: "needs Agent Control" }
  ]);
});

test("Augmentor chat request messages require a human/assistant turn and prepend system contract", () => {
  assert.throws(() => buildAugmentorChatRequestMessages({ messages: [{ role: "system", content: "only system" }] }), /No chat message/);

  const messages = buildAugmentorChatRequestMessages({
    messages: [{ role: "user", content: "can you delegate this to Hermes?" }]
  });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /may delegate to approved add-on agents/);
  assert.deepEqual(messages.slice(1), [
    { role: "user", content: "can you delegate this to Hermes?" }
  ]);
});
test("Augmentor chat contract renders explicitly referenced tabs with provenance", () => {
  const prompt = buildAugmentorSystemPrompt({
    tabContexts: [
      { title: "Alpha News", url: "https://alpha.test/", text: "Alpha visible text" },
      { title: "Beta Report", url: "https://beta.test/", text: "Beta visible text" }
    ]
  });

  assert.match(prompt, /Browser tabs explicitly referenced by the user/);
  assert.match(prompt, /Referenced tab 1: Alpha News — https:\/\/alpha\.test\//);
  assert.match(prompt, /Referenced tab 2: Beta Report — https:\/\/beta\.test\//);
  assert.match(prompt, /Alpha visible text/);
  assert.match(prompt, /scope the answer to these tabs/);

  assert.doesNotMatch(buildAugmentorSystemPrompt({}), /explicitly referenced by the user/);
  assert.doesNotMatch(buildAugmentorSystemPrompt({ tabContexts: [] }), /explicitly referenced by the user/);
  assert.doesNotMatch(buildAugmentorSystemPrompt({ tabContexts: "not-an-array" }), /explicitly referenced by the user/);
});
