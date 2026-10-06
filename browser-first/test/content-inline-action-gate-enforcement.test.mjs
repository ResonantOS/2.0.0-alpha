import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const extensionSrcRoot = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension", "src");
const scriptPath = (...segments) => path.join(extensionSrcRoot, ...segments);

const contentScriptPath = scriptPath("content.js");
const controlOverlayScriptPath = scriptPath("lib", "control-overlay.js");
const fieldSafetyScriptPath = scriptPath("lib", "content-field-safety.js");
const inlineActionsScriptPath = scriptPath("lib", "content-inline-actions.js");
const controlRefsScriptPath = scriptPath("lib", "content-control-refs.js");
const inlineActionSurfaceGateScriptPath = scriptPath("lib", "content-inline-action-surface-gate.js");
const augmentorShortcutControllerScriptPath = scriptPath("lib", "augmentor-shortcut-controller.js");

async function evalScript(targetWindow, filePath) {
  targetWindow.eval(await readFile(filePath, "utf8"));
}

async function loadContentScript({
  loadGate = true,
  url = "https://example.test/article",
  exposePermissionGate = false,
} = {}) {
  const dom = new JSDOM("<!doctype html><main>Selected page text for the inline assistant.</main>", {
    runScripts: "outside-only",
    url,
  });
  const sentMessages = [];
  let listener = null;
  dom.window.chrome = {
    runtime: {
      onMessage: {
        addListener(callback) {
          listener = callback;
        },
      },
      sendMessage(message) {
        sentMessages.push(message);
        return Promise.resolve({ ok: true, reply: "Provider reply should not run on denied surfaces." });
      },
    },
    storage: {
      local: {
        get() {
          return Promise.resolve({ augmentorSitePermissions: {} });
        },
        set() {
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener() {},
      },
    },
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  dom.window.__resonantosControlDwellMs = 0;

  await evalScript(dom.window, controlOverlayScriptPath);
  await evalScript(dom.window, fieldSafetyScriptPath);
  await evalScript(dom.window, inlineActionsScriptPath);
  await evalScript(dom.window, controlRefsScriptPath);
  if (loadGate) {
    await evalScript(dom.window, inlineActionSurfaceGateScriptPath);
  }
  if (exposePermissionGate) {
    // Expose closure-local functions only in the evaluated test copy.
    const source = await readFile(contentScriptPath, "utf8");
    assert.ok(source.trimEnd().endsWith("})();"));
    dom.window.eval(source.replace(/\}\)\(\);\s*$/, `
      window.permissionGateTest = { currentSitePermission, positionInlineButton, runInlineAction };
    })();`));
  } else {
    await evalScript(dom.window, contentScriptPath);
  }
  assert.equal(typeof listener, "function");
  return { dom, listener, sentMessages };
}

function showInlineAssistant(listener) {
  listener({
    channel: "resonantos.browser_first.content",
    type: "show_inline_assistant_for_text",
    text: "Selected page text for the inline assistant.",
    rect: { bottom: 120, left: 24, top: 96, width: 320 },
  }, {}, () => {});
}

async function runInlineSummarize({ loadGate, url }) {
  const { dom, listener, sentMessages } = await loadContentScript({ loadGate, url });
  showInlineAssistant(listener);
  dom.window.document.querySelector("#resonantos-inline-button").click();
  dom.window.document.querySelector('[data-action="summarize"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return {
    result: dom.window.document.querySelector("#resonantos-inline-assistant .ros-inline-result")?.textContent ?? "",
    sentMessages,
  };
}

async function loadShortcutController({ loadGate }) {
  const dom = new JSDOM("<!doctype html>", { runScripts: "outside-only" });
  await evalScript(dom.window, augmentorShortcutControllerScriptPath);
  if (loadGate) {
    await evalScript(dom.window, inlineActionSurfaceGateScriptPath);
  }
  return dom.window.ResonantOSAugmentorShortcutController;
}

function makeShortcutEvent() {
  return {
    altKey: true,
    code: "KeyA",
    ctrlKey: false,
    isComposing: false,
    key: "a",
    metaKey: false,
    shiftKey: false,
    target: { tagName: "BODY", isContentEditable: false },
  };
}

test("inline action path denies restricted surfaces through the loaded gate (#347)", async () => {
  const { result, sentMessages } = await runInlineSummarize({
    loadGate: true,
    url: "chrome://settings/",
  });

  assert.match(result, /Augmentor inline actions are disabled on this page \(chrome:\/\/\)/);
  assert.equal(sentMessages.length, 0, "denied inline action must not reach the provider path");
});

test("inline action path denies when the surface gate did not load (#347)", async () => {
  const { result, sentMessages } = await runInlineSummarize({
    loadGate: false,
    url: "https://example.test/article",
  });

  assert.equal(result, "Inline actions are unavailable: the surface gate did not load.");
  assert.equal(sentMessages.length, 0, "missing gate must fail closed before running the action");
});

test("shortcut controller denies chrome pages with and without the gate global (#347)", async () => {
  for (const loadGate of [true, false]) {
    const controller = await loadShortcutController({ loadGate });
    const result = controller.classifyShortcut(makeShortcutEvent(), { locationHref: "chrome://settings/" });
    assert.equal(result.action, "none", `expected no shortcut action when loadGate=${loadGate}`);
    assert.equal(result.conflict, "restricted", `expected restricted shortcut classification when loadGate=${loadGate}`);
  }
});

test("shortcut controller reads the gate restricted schemes lazily at call time (#347)", async () => {
  const controller = await loadShortcutController({ loadGate: true });
  const result = controller.classifyShortcut(makeShortcutEvent(), { locationHref: "chrome-untrusted://terminal/" });

  assert.equal(result.action, "none");
  assert.equal(result.conflict, "restricted");
});

const blockedSiteMessage = "Augmentor inline actions are blocked for this site by your saved site permission. Toggle the site permission in the side panel to re-enable inline actions.";

async function loadPermissionGate(t) {
  const harness = await loadContentScript({ exposePermissionGate: true });
  t.after(() => harness.dom.window.close());
  showInlineAssistant(harness.listener);
  const { window } = harness.dom;
  const button = window.document.querySelector("#resonantos-inline-button");
  const panel = window.document.querySelector("#resonantos-inline-assistant");
  panel.dataset.selection = "Selected page text for the inline assistant.";
  return { ...harness, window, button, panel, gate: window.permissionGateTest };
}

async function assertPermissionHidesUi({ window, button, panel, gate }) {
  button.style.display = "block";
  panel.style.display = "block";
  gate.positionInlineButton();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.equal(button.style.display, "none");
  assert.equal(panel.style.display, "none");
}

test("T1 storage read throws: permission is blocked and positioning hides button and panel", async (t) => {
  const harness = await loadPermissionGate(t);
  harness.window.chrome.storage.local.get = async () => { throw new Error("Storage unavailable"); };
  assert.equal(await harness.gate.currentSitePermission(), "blocked");
  await assertPermissionHidesUi(harness);
});

test("T2 host-keyed blocked permission refuses send without writing an inline draft", async (t) => {
  const { window, panel, gate } = await loadPermissionGate(t);
  assert.equal(window.location.hostname, "example.test");
  window.chrome.storage.local.get = async () => ({ augmentorSitePermissions: { "example.test": "blocked" } });
  const writes = [];
  window.chrome.storage.local.set = async (value) => { writes.push(value); };
  await gate.runInlineAction("send");
  assert.equal(panel.querySelector(".ros-inline-result").textContent, blockedSiteMessage);
  assert.equal(writes.some((value) => Object.hasOwn(value, "augmentorInlineDraft")), false);
});

test("T3 healthy storage with no host entry keeps ask-before-action", async (t) => {
  const { gate } = await loadPermissionGate(t);
  assert.equal(await gate.currentSitePermission(), "ask-before-action");
});

test("T4 healthy blocked permission keeps button and panel hidden", async (t) => {
  const harness = await loadPermissionGate(t);
  harness.window.chrome.storage.local.get = async () => ({ augmentorSitePermissions: { "example.test": "blocked" } });
  assert.equal(await harness.gate.currentSitePermission(), "blocked");
  await assertPermissionHidesUi(harness);
});

test("non-callable storage get fails closed", async (t) => {
  const harness = await loadPermissionGate(t);
  for (const get of [undefined, null, "unavailable"]) {
    harness.window.chrome.storage.local.get = get;
    assert.equal(await harness.gate.currentSitePermission(), "blocked");
    await assertPermissionHidesUi(harness);
  }
});

test("unreadable storage refuses send without writing an inline draft", async (t) => {
  const { window, panel, gate } = await loadPermissionGate(t);
  const writes = [];
  window.chrome.storage.local.set = async (value) => { writes.push(value); };
  for (const get of [async () => { throw new Error("Storage unavailable"); }, undefined]) {
    window.chrome.storage.local.get = get;
    await gate.runInlineAction("send");
    assert.equal(panel.querySelector(".ros-inline-result").textContent, blockedSiteMessage);
    assert.equal(writes.length, 0);
  }
});

const inlineAssistantMessage = {
  channel: "resonantos.browser_first.content",
  type: "show_inline_assistant_for_text",
  text: "Selected page text for the inline assistant.",
  rect: { bottom: 120, left: 24, top: 96, width: 320 },
};

test("show_inline_assistant_for_text never surfaces the button on a blocked or unreadable site", async (t) => {
  const cases = [
    ["blocked", async () => ({ augmentorSitePermissions: { "example.test": "blocked" } })],
    ["unreadable", async () => { throw new Error("Storage unavailable"); }],
  ];
  for (const [label, get] of cases) {
    const harness = await loadContentScript({ exposePermissionGate: true });
    t.after(() => harness.dom.window.close());
    const { window } = harness.dom;
    window.chrome.storage.local.get = get;
    const responses = [];
    harness.listener(inlineAssistantMessage, {}, (response) => responses.push(response));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.notEqual(window.document.querySelector("#resonantos-inline-button").style.display, "block", label);
    assert.equal(responses.length, 1, label);
    assert.equal(responses[0].ok, false, label);
  }
});

test("show_inline_assistant_for_text still shows the button on an unblocked site with a healthy store", async (t) => {
  const harness = await loadContentScript({ exposePermissionGate: true });
  t.after(() => harness.dom.window.close());
  const { window } = harness.dom;
  window.chrome.storage.local.get = async () => ({ augmentorSitePermissions: {} });
  const responses = [];
  harness.listener(inlineAssistantMessage, {}, (response) => responses.push(response));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.equal(window.document.querySelector("#resonantos-inline-button").style.display, "block");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].textLength, inlineAssistantMessage.text.length);
});
