import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountEmbedBar } from '../resonantos-side-panel-extension/src/lib/embed-bar.js';

function fixture(mode = 'embed') {
  const dom = new JSDOM('<body><main></main></body>');
  const calls = [];
  let visible = false, count = 2;
  const bar = mountEmbedBar({ documentRef: dom.window.document,
    parent: dom.window.document.body, mode,
    toggleWorkspace: async () => { calls.push('toggle'); return visible = !visible; },
    workspaceVisible: async () => visible,
    openWorkspace: async () => { calls.push('open'); return true; },
    selectAssistant: async value => calls.push(value),
    sharePage: async () => { calls.push('page'); return 'Page shared'; },
    readApprovals: async () => count
  });
  return { dom, bar, calls, setCount: value => { count = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('embed bar orders all five controls, confirms locally and reflects workspace state', async t => {
  const f = fixture(); t.after(() => { f.bar.destroy(); f.dom.window.close(); });
  await f.bar.ready;
  const root = f.bar.root;
  assert.deepEqual([...root.querySelectorAll('[data-control]')].map(node => node.dataset.control),
    ['workspace', 'assistant', 'page', 'approvals', 'status']);
  for (const button of root.querySelectorAll('button')) {
    assert.ok(button.getAttribute('aria-label'));
    assert.ok(button.title);
  }
  const workspace = root.querySelector('[data-control=workspace]');
  assert.equal(workspace.getAttribute('aria-pressed'), 'false');
  workspace.click(); await settle();
  assert.equal(workspace.getAttribute('aria-pressed'), 'true');
  root.querySelector('[data-control=page]').click(); await settle();
  assert.equal(root.querySelector('[role=status]').textContent, 'Page shared');
  root.querySelector('[data-control=approvals]').click(); await settle();
  assert.deepEqual(f.calls, ['toggle', 'page', 'open']);
  assert.match(root.querySelector('[data-control=approvals]').getAttribute('aria-label'), /2/);
  f.setCount(null); await f.bar.refresh();
  assert.equal(root.querySelector('[data-control=approvals]').title, 'Approvals unavailable');
  f.bar.setStatus({ online: true, busy: false });
  assert.equal(root.querySelector('[data-control=status]').textContent, 'Online · idle');
  f.bar.setStatus({ online: true, busy: true });
  assert.equal(root.querySelector('[data-control=status]').textContent, 'Busy');
  f.bar.setStatus(null);
  assert.equal(root.querySelector('[data-control=status]').textContent, 'Offline');
});

test('normal bar contains only Assistant; Escape restores focus and choices are named', async t => {
  const f = fixture('normal'); t.after(() => { f.bar.destroy(); f.dom.window.close(); });
  await f.bar.ready;
  const root = f.bar.root;
  assert.deepEqual([...root.querySelectorAll('[data-control]')].map(node => node.dataset.control), ['assistant']);
  const assistant = root.querySelector('[data-control=assistant]');
  assistant.click();
  const menu = root.querySelector('[role=menu]');
  assert.equal(menu.hidden, false);
  menu.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.hidden, true);
  assert.equal(f.dom.window.document.activeElement, assistant);
  assistant.click();
  root.querySelector('[data-mode=embed]').click(); await settle();
  assert.deepEqual(f.calls, ['embed']);
  assistant.click();
  root.querySelector('[data-mode=normal]').click(); await settle();
  assert.deepEqual(f.calls, ['embed', 'normal']);
});

test('bar failures are inline and do not disable Workspace or Assistant', async t => {
  const dom = new JSDOM('<body></body>'); t.after(() => dom.window.close());
  const bar = mountEmbedBar({ documentRef: dom.window.document, parent: dom.window.document.body,
    mode: 'embed', toggleWorkspace: async () => false, workspaceVisible: async () => false,
    openWorkspace: async () => true, readApprovals: async () => null,
    sharePage: async () => 'Page sharing blocked',
    selectAssistant: async () => { throw Error('secret diagnostic'); }
  });
  t.after(() => bar.destroy()); await bar.ready;
  bar.root.querySelector('[data-control=page]').click(); await settle();
  assert.equal(bar.root.querySelector('[role=status]').textContent, 'Page sharing blocked');
  bar.root.querySelector('[data-control=assistant]').click();
  bar.root.querySelector('[data-mode=normal]').click(); await settle();
  assert.equal(bar.root.querySelector('[role=status]').textContent, 'Assistant switch unavailable');
  assert.equal(bar.root.textContent.includes('secret diagnostic'), false);
  assert.equal(bar.root.querySelector('[data-control=workspace]').disabled, false);
  assert.equal(bar.root.querySelector('[data-control=assistant]').disabled, false);
});

test('CSS declares bounded one-row layout, keyboard focus, a dark-only palette and reduced motion', async () => {
  const css = await readFile(new URL('../resonantos-side-panel-extension/src/styles/side-panel/base-layout.css', import.meta.url), 'utf8');
  assert.match(css, /--embed-bar-height:\s*36px/);
  assert.match(css, /\.embed-bar\s*\{[^}]*max-height:\s*36px/s);
  assert.match(css, /\.embed-bar button:focus-visible/);
  // The bar sits on dark harness and ResonantOS panels, so it never switches to a light palette.
  assert.match(css, /--embed-bar-bg:\s*#111315/);
  assert.doesNotMatch(css, /prefers-color-scheme:\s*light[^{]*\{[^}]*\.embed-bar/s);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  const html = await readFile(new URL('../resonantos-side-panel-extension/src/side-panel.html', import.meta.url), 'utf8');
  assert.match(html, /id="normal-chat-root" class="chat-shell"/);
});
