import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  allowsCustomProviderEndpoint,
} from "../resonantos-side-panel-extension/src/lib/settings/provider-catalog.js";
import {
  openProviderAccountModal,
  providerAccountForm,
  providerAccountPayload,
} from "../resonantos-side-panel-extension/src/lib/settings/providers-section.js";

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://resonantos.local/",
  });
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.Node = dom.window.Node;
  globalThis.window = dom.window;
  return {
    body: dom.window.document.body,
    cleanup: () => {
      delete globalThis.document;
      delete globalThis.HTMLElement;
      delete globalThis.Event;
      delete globalThis.Node;
      delete globalThis.window;
    },
  };
}

function statusNode() {
  const node = document.createElement("p");
  node.className = "settings-status";
  return node;
}

function submitForm(form) {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

test("provider account form payload captures account fields", () => {
  const { body, cleanup } = setupDom();
  try {
    const form = providerAccountForm({ templateId: "openai-compatible" });
    body.append(form);
    form.querySelector("input[name='label']").value = "Test account";
    form.querySelector("input[name='apiBaseUrl']").value = "https://api.test.local/v1";
    form.querySelector("input[name='role']").value = "Routine";
    form.querySelector("textarea[name='models']").value = "model-a\nmodel-b";
    form.querySelector("input[name='credential']").value = "sk-test-credential";

    const payload = providerAccountPayload(form);
    assert.equal(payload.label, "Test account");
    assert.equal(payload.providerType, "openai-compatible");
    assert.equal(payload.authType, "api-key");
    assert.equal(payload.apiBaseUrl, "https://api.test.local/v1");
    assert.equal(payload.role, "Routine");
    assert.deepEqual(payload.models, ["model-a", "model-b"]);
    assert.equal(payload.credential, "sk-test-credential");
  } finally {
    cleanup();
  }
});

test("provider catalog endpoint lock matches backend validation", () => {
  assert.equal(allowsCustomProviderEndpoint("minimax"), false);
  assert.equal(allowsCustomProviderEndpoint("openai"), false);
  assert.equal(allowsCustomProviderEndpoint("anthropic"), false);
  assert.equal(allowsCustomProviderEndpoint("gemini"), false);
  assert.equal(allowsCustomProviderEndpoint("xai"), true);
  assert.equal(allowsCustomProviderEndpoint("openai-compatible"), true);
  assert.equal(allowsCustomProviderEndpoint("ollama"), true);
  assert.equal(allowsCustomProviderEndpoint("cohere"), true);
  assert.equal(allowsCustomProviderEndpoint("replicate"), true);
});

test("provider account form disables API base URL for locked templates", () => {
  const { body, cleanup } = setupDom();
  try {
    const lockedForm = providerAccountForm({ templateId: "openai" });
    body.append(lockedForm);
    const lockedUrl = lockedForm.querySelector("input[name='apiBaseUrl']");
    assert.equal(lockedUrl.disabled, true, "locked template should disable API base URL");
    assert.equal(lockedUrl.value, "https://api.openai.com/v1");
    assert.equal(lockedUrl.title, "This provider requires its built-in endpoint URL.");

    const editableForm = providerAccountForm({ templateId: "openai-compatible" });
    body.append(editableForm);
    const editableUrl = editableForm.querySelector("input[name='apiBaseUrl']");
    assert.equal(editableUrl.disabled, false, "editable template should keep API base URL enabled");
    assert.equal(editableUrl.title, "");
  } finally {
    cleanup();
  }
});

test("provider account form locks and unlocks API base URL when template changes", () => {
  const { body, cleanup } = setupDom();
  try {
    const form = providerAccountForm({ templateId: "openai-compatible" });
    body.append(form);
    const template = form.querySelector("select[name='templateId']");
    const url = form.querySelector("input[name='apiBaseUrl']");
    assert.equal(url.disabled, false);

    template.value = "openai";
    template.dispatchEvent(new Event("change"));
    assert.equal(url.disabled, true, "switching to locked template should disable the URL field");
    assert.equal(url.value, "https://api.openai.com/v1");

    template.value = "xai";
    template.dispatchEvent(new Event("change"));
    assert.equal(url.disabled, false, "switching back to editable template should enable the URL field");
    assert.equal(url.value, "https://api.x.ai/v1");
  } finally {
    cleanup();
  }
});

async function fillAndSubmitAccountForm(body, bridgeRequest) {
  const node = statusNode();
  let reloadCalled = false;
  openProviderAccountModal({
    bridgeRequest,
    getBridgeRequest: () => bridgeRequest,
    statusNode: node,
    reload: async () => { reloadCalled = true; },
  });
  const overlay = body.querySelector(".settings-provider-modal");
  assert.ok(overlay, "modal overlay should be appended to body");
  const form = overlay.querySelector("form");
  assert.ok(form, "form should exist inside modal");
  form.querySelector("input[name='label']").value = "Test account";
  form.querySelector("input[name='credential']").value = "sk-test-credential";
  submitForm(form);
  return { overlay, form, node, reloadCalled: () => reloadCalled };
}

test("add provider account modal closes and reloads on success", async () => {
  const { body, cleanup } = setupDom();
  try {
    const { overlay, node, reloadCalled } = await fillAndSubmitAccountForm(body, async () => ({ provider: { id: "test" } }));
    assert.equal(body.contains(overlay), false, "modal overlay should be removed from body after success");
    assert.equal(node.textContent, "Provider account saved.", "global status shows success");
    assert.equal(node.dataset.tone, "success");
    assert.equal(reloadCalled(), true, "reload should be called after success");
  } finally {
    cleanup();
  }
});

test("add provider account modal displays error above save button on failure", async () => {
  const { body, cleanup } = setupDom();
  try {
    const { overlay, form, node } = await fillAndSubmitAccountForm(body, async () => {
      throw new Error("Bridge refused credential save");
    });
    assert.equal(body.contains(overlay), true, "modal should remain open after failure");
    const errorNode = form.querySelector(".settings-provider-modal-error");
    assert.ok(errorNode, "in-modal error node should exist");
    assert.equal(errorNode.hidden, false, "error node should be visible");
    assert.match(errorNode.textContent, /Provider account save failed/);
    assert.match(errorNode.textContent, /Bridge refused credential save/);
    const actions = form.querySelector(".settings-provider-modal-actions");
    assert.ok(
      actions.compareDocumentPosition(errorNode) & Node.DOCUMENT_POSITION_PRECEDING,
      "error node should be before the save actions in document order"
    );
    assert.equal(node.textContent, "", "global status should stay empty while modal is open");
    assert.equal(node.dataset.tone, undefined, "global status should have no tone while modal is open");
  } finally {
    cleanup();
  }
});

test("add provider account modal clears prior error on retry", async () => {
  const { body, cleanup } = setupDom();
  try {
    let shouldFail = true;
    const bridgeRequest = async () => {
      if (shouldFail) {
        throw new Error("First attempt fails");
      }
      return { provider: { id: "test" } };
    };
    const { form } = await fillAndSubmitAccountForm(body, bridgeRequest);
    const errorNode = form.querySelector(".settings-provider-modal-error");
    assert.ok(errorNode.textContent.includes("First attempt fails"));
    shouldFail = false;
    submitForm(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(errorNode.textContent, "", "error node should be cleared on retry");
    assert.equal(errorNode.hidden, true, "error node should be hidden after retry clears it");
  } finally {
    cleanup();
  }
});

