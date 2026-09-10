import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderPersonalizationSection } from "../resonantos-side-panel-extension/src/lib/settings/personalization-section.js";
import { readPersonalizationSettings } from "../resonantos-side-panel-extension/src/lib/personalization-settings.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function render(t, storage) {
  const dom = new JSDOM("<main></main>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  renderPersonalizationSection(document.querySelector("main"), { storage });
  return {
    status: () => document.querySelector(".settings-status").textContent,
    field: (name) => document.querySelector(`[aria-label="${name}"]`),
    save: document.querySelector('[type="submit"]'),
    submit: () => document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true, bubbles: true })),
  };
}

test("failed Profile read blocks writes and read-only retry restores the saved prompt", async (t) => {
  let fail = true;
  let writes = 0;
  const saved = { augmentorConfig: { displayName: "Fixture AI", systemPrompt: "Existing custom prompt" } };
  const ui = render(t, { get: async () => { if (fail) throw new Error("storage read unavailable"); return saved; }, set: async () => { writes++; } });
  await tick();
  assert.match(ui.status(), /unavailable/);
  assert.equal(ui.save.disabled, true);
  ui.submit();
  await tick();
  assert.equal(writes, 0);
  const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Retry loading identity");
  assert.ok(retry);
  fail = false;
  retry.click();
  await tick();
  assert.equal(ui.field("Augmentor system prompt").value, "Existing custom prompt");
  assert.equal(ui.save.disabled, false);
  assert.equal(writes, 0);
});

test("pending initial load disables editing and cannot race a Save", async (t) => {
  let release;
  let writes = 0;
  const ui = render(t, { get: () => new Promise((resolve) => { release = resolve; }), set: async () => { writes++; } });
  assert.equal(ui.save.disabled, true);
  assert.equal(ui.field("User display name").disabled, true);
  ui.submit();
  release({ augmentorUserProfile: { displayName: "Saved name" } });
  await tick();
  assert.equal(writes, 0);
  assert.equal(ui.field("User display name").value, "Saved name");
  assert.equal(ui.field("User display name").disabled, false);
});

test("successful missing keys allow a new identity to be saved", async (t) => {
  let saved;
  const ui = render(t, { get: async () => ({}), set: async (values) => { saved = values; } });
  await tick();
  ui.field("User display name").value = "New fixture user";
  ui.submit();
  await tick();
  assert.equal(saved.augmentorUserProfile.displayName, "New fixture user");
  assert.match(ui.status(), /saved/);
});

test("rejected writes retain the draft and permit retry", async (t) => {
  let fail = true;
  const ui = render(t, { get: async () => ({}), set: async () => { if (fail) throw new Error("write unavailable"); } });
  await tick();
  ui.field("Augmentor system prompt").value = "Unsaved draft";
  ui.submit();
  await tick();
  assert.match(ui.status(), /Save failed/);
  assert.equal(ui.field("Augmentor system prompt").value, "Unsaved draft");
  assert.equal(ui.save.disabled, false);
  fail = false;
  ui.submit();
  await tick();
  assert.match(ui.status(), /saved/);
});

test("strict reads reject malformed or unavailable storage while chat fallback stays compatible", async () => {
  for (const storage of [{}, { get: async () => null }, { get: async () => { throw new Error("offline"); } }]) {
    await assert.rejects(readPersonalizationSettings(storage, {}, { strict: true }));
    assert.equal((await readPersonalizationSettings(storage)).profile.displayName, "ResonantOS User");
  }
});

test("duplicate submits during persistence perform one write", async (t) => {
  let release;
  let writes = 0;
  const ui = render(t, { get: async () => ({}), set: async () => { writes++; await new Promise((resolve) => { release = resolve; }); } });
  await tick();
  ui.submit();
  ui.submit();
  assert.equal(writes, 1);
  release();
  await tick();
});
