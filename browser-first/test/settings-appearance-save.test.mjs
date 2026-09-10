import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderAppearanceSection } from "../resonantos-side-panel-extension/src/lib/settings/appearance-section.js";

const key = "appearance";
const initial = { density: "comfortable", fontScale: "standard", motion: "full" };
const changed = { density: "compact", fontScale: "large", motion: "reduced" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(t, storage) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.document; });
  const root = document.querySelector("main");
  renderAppearanceSection(root, { storage, storageKeys: { appearance: key } });
  await tick();
  const form = root.querySelector("form");
  const save = form.querySelector("button");
  const status = root.querySelector(".settings-status");
  const choose = () => {
    for (const [name, value] of Object.entries(changed)) form.elements[name].value = value;
  };
  const submit = () => form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  return { root, form, save, status, choose, submit };
}

test("failed appearance save preserves applied preferences and allows retry with the same selection", async (t) => {
  let fail = true;
  let stored = { ...initial };
  const storage = {
    get: async () => ({ [key]: stored }),
    set: async (values) => {
      if (fail) throw new Error("storage unavailable");
      stored = values[key];
    }
  };
  const ui = await setup(t, storage);
  ui.choose();
  ui.submit();
  await tick();
  assert.deepEqual({ ...document.body.dataset }, initial);
  assert.deepEqual(stored, initial);
  assert.equal(ui.status.dataset.tone, "error");
  assert.match(ui.status.textContent, /could not be saved/i);
  assert.equal(ui.status.getAttribute("role"), "status");
  assert.equal(ui.status.closest("form"), ui.form);
  assert.equal(ui.status.parentElement, ui.save.parentElement);
  assert.equal(ui.save.disabled, false);
  for (const [name, value] of Object.entries(changed)) assert.equal(ui.form.elements[name].value, value);
  fail = false;
  ui.submit();
  await tick();
  assert.deepEqual(stored, changed);
  assert.deepEqual({ ...document.body.dataset }, changed);
  assert.equal(ui.status.textContent, "Appearance settings saved.");
  renderAppearanceSection(ui.root, { storage, storageKeys: { appearance: key } });
  await tick();
  for (const [name, value] of Object.entries(changed)) assert.equal(ui.root.querySelector(`[name="${name}"]`).value, value);
});

test("appearance changes apply only after persistence and duplicate pending submits do not write", async (t) => {
  let finish;
  let writes = 0;
  const ui = await setup(t, {
    get: async () => ({ [key]: initial }),
    set: () => { writes += 1; return new Promise((resolve) => { finish = resolve; }); }
  });
  ui.choose();
  ui.submit();
  ui.submit();
  assert.equal(writes, 1);
  assert.deepEqual({ ...document.body.dataset }, initial);
  assert.equal(ui.save.disabled, true);
  assert.match(ui.status.textContent, /saving/i);
  finish();
  await tick();
  assert.deepEqual({ ...document.body.dataset }, changed);
  assert.equal(ui.save.disabled, false);
});

test("missing appearance storage cannot report a successful save", async (t) => {
  const ui = await setup(t, undefined);
  ui.choose();
  ui.submit();
  await tick();
  assert.deepEqual({ ...document.body.dataset }, initial);
  assert.equal(ui.status.dataset.tone, "error");
  assert.doesNotMatch(ui.status.textContent, /settings saved\./);
  assert.equal(ui.save.disabled, false);
});
