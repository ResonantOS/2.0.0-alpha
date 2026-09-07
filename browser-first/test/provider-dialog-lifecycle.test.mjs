import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installDialogLifecycle } from "./dialog-dom-fixture.mjs";
import { openProviderAccountModal } from "../resonantos-side-panel-extension/src/lib/settings/providers-section.js";

function setup(t, bridgeRequest) {
  const dom = new JSDOM('<button id="invoker">Add provider account</button><p id="status"></p>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  installDialogLifecycle(dom.window);
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const statusNode = document.querySelector('#status');
  let reloads = 0;
  const open = () => {
    openProviderAccountModal({ bridgeRequest, statusNode, reload: async () => { reloads++; } });
    return document.querySelector('dialog[open]');
  };
  const submit = (dialog) => dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return { open, submit, statusNode, reloads: () => reloads };
}

test('provider dialog exposes a name and removes itself after native close', (t) => {
  const { open } = setup(t, async () => ({}));
  const dialog = open();
  assert.equal(dialog.getAttribute('aria-label'), 'Add provider account');
  dialog.querySelector('button').click();
  assert.equal(dialog.isConnected, false);
});

test('provider dialog backdrop dismisses but panel content does not', (t) => {
  const { open } = setup(t, async () => ({}));
  const dialog = open();
  dialog.querySelector('section').click();
  assert.equal(dialog.open, true);
  dialog.click();
  assert.equal(dialog.isConnected, false);
});

test('provider dialog preserves errors and retries through the original capability', async (t) => {
  const requests = [];
  const { open, submit, statusNode, reloads } = setup(t, async (path, options) => {
    requests.push({ path, options });
    if (requests.length === 1) throw new Error('Account unavailable');
    return {};
  });
  const dialog = open();
  const label = dialog.querySelector('input[name="label"]');
  label.value = 'Fixture account';
  submit(dialog);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.open, true);
  assert.match(dialog.querySelector('[role="status"]').textContent, /Account unavailable/);
  assert.equal(label.value, 'Fixture account');
  assert.equal(dialog.querySelector('[type="submit"]').disabled, false);
  submit(dialog);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.isConnected, false);
  assert.equal(reloads(), 1);
  assert.match(statusNode.textContent, /saved/);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, '/providers/accounts');
  assert.equal(requests[1].options.capability, 'provider-credential-write');
  assert.equal(requests[1].options.body.label, 'Fixture account');
});

test('completion of a dismissed dialog does not close a newer dialog', async (t) => {
  let resolveRequest;
  const { open, submit, reloads } = setup(t, () => new Promise(resolve => { resolveRequest = resolve; }));
  const first = open();
  submit(first);
  assert.equal(first.querySelector('[type="submit"]').disabled, true);
  first.close();
  const second = open();
  resolveRequest({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.isConnected, false);
  assert.equal(second.open, true);
  assert.equal(second.isConnected, true);
  assert.equal(reloads(), 1);
});
