import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  getSidePanelElements,
  SIDE_PANEL_REQUIRED_ELEMENT_IDS,
  SIDE_PANEL_STORAGE_KEYS
} from "../resonantos-side-panel-extension/src/lib/side-panel-dom.js";

const extensionRoot = path.resolve(import.meta.dirname, "..", "resonantos-side-panel-extension");

test("side panel DOM contract resolves every required element from side-panel.html", async () => {
  const html = await readFile(path.join(extensionRoot, "src", "side-panel.html"), "utf8");
  const dom = new JSDOM(html);
  const elements = getSidePanelElements(dom.window.document);

  for (const id of SIDE_PANEL_REQUIRED_ELEMENT_IDS) {
    assert.ok(dom.window.document.getElementById(id), `side-panel.html is missing #${id}`);
  }
  for (const [name, element] of Object.entries(elements)) {
    assert.ok(element, `getSidePanelElements did not resolve ${name}`);
  }
});

test("side panel dock order matches the main panel, with a new-chat button after Chats", async () => {
  const html = await readFile(path.join(extensionRoot, "src", "side-panel.html"), "utf8");
  const d = new JSDOM(html).window.document;
  const dockButtons = [...d.querySelectorAll("#dock-tabs button")].map((button) => button.id);
  assert.deepEqual(dockButtons, [
    "dock-tab-site", "dock-tab-control", "dock-tab-jobs", "dock-tab-permissions", "dock-tab-chats", "dock-new-chat"
  ]);
});

test("side panel storage keys stay namespaced to Augmentor browser state", () => {
  const values = Object.values(SIDE_PANEL_STORAGE_KEYS);
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.every((key) => /^augmentor/.test(key)));
});
