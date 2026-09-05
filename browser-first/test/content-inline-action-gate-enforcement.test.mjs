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
  await evalScript(dom.window, contentScriptPath);
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
