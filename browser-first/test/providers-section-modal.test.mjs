import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { openProviderAccountModal } from "../resonantos-side-panel-extension/src/lib/settings/providers-section.js";

// Regression coverage for #271: the Add-provider dialog used to write save
// errors to the settings page *behind* the still-open modal, so the user saw no
// signal and the dialog appeared stuck. Errors must now stay inside the dialog
// (which stays open) and only a success closes it.

function setupDom() {
  const dom = new JSDOM("<!doctype html><main id=\"root\"></main>", { url: "https://resonantos.local/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event;
  globalThis.FormData = dom.window.FormData;
  return {
    dom,
    statusNode: dom.window.document.querySelector("#root"),
    cleanup: () => {
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.Event;
      delete globalThis.FormData;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function submitModal() {
  const form = document.querySelector(".settings-provider-account-form");
  assert.ok(form, "modal form should be mounted");
  form.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true }));
}

test("#271 provider save failure stays in the dialog and keeps it open", async () => {
  const { statusNode, cleanup } = setupDom();
  try {
    openProviderAccountModal({
      bridgeRequest: async () => {
        throw new Error("Invalid API base URL");
      },
      statusNode,
      reload: async () => {},
    });
    submitModal();
    await flush();

    // Dialog stays open so the user can fix the input and retry.
    assert.ok(document.querySelector(".settings-provider-modal"), "modal must remain open on failure");

    // The error is shown INSIDE the dialog, with error tone.
    const modalStatus = document.querySelector(".settings-provider-modal-status");
    assert.ok(modalStatus, "in-dialog status node must exist");
    assert.match(modalStatus.textContent, /Save failed/);
    assert.match(modalStatus.textContent, /Invalid API base URL/);
    assert.equal(modalStatus.dataset.tone, "error");

    // The settings page behind the modal is NOT where the error goes.
    assert.doesNotMatch(statusNode.textContent ?? "", /failed/i);
  } finally {
    cleanup();
  }
});

test("#271 provider save success closes the dialog and confirms on the settings page", async () => {
  const { statusNode, cleanup } = setupDom();
  let reloaded = false;
  try {
    openProviderAccountModal({
      bridgeRequest: async () => ({ ok: true }),
      statusNode,
      reload: async () => {
        reloaded = true;
      },
    });
    submitModal();
    await flush();

    assert.equal(document.querySelector(".settings-provider-modal"), null, "modal must close on success");
    assert.match(statusNode.textContent, /saved/i);
    assert.equal(statusNode.dataset.tone, "success");
    assert.ok(reloaded, "reload() should run after a successful save");
  } finally {
    cleanup();
  }
});
