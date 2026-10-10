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

test('window blur closes Assistant without reclaiming focus and is removed on destroy', async t => {
  const f = fixture(); t.after(() => { f.bar.destroy(); f.dom.window.close(); });
  await f.bar.ready;
  const { document } = f.dom.window;
  const assistant = f.bar.root.querySelector('[data-control=assistant]');
  const menu = f.bar.root.querySelector('[role=menu]');
  const frame = document.createElement('iframe'); document.body.append(frame);
  assistant.click(); frame.focus();
  f.dom.window.dispatchEvent(new f.dom.window.Event('blur'));
  assert.equal(menu.hidden, true);
  assert.equal(assistant.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, frame);
  const removed = [];
  const remove = f.dom.window.removeEventListener.bind(f.dom.window);
  f.dom.window.removeEventListener = (...args) => { removed.push(args); remove(...args); };
  f.bar.destroy();
  assert.equal(removed.filter(([type]) => type === 'blur').length, 1);
});

test('notice stays exposed while empty, announced and cleared', async t => {
  const dom = new JSDOM('<body></body>');
  const css = await readFile(new URL('../resonantos-side-panel-extension/src/styles/side-panel/base-layout.css', import.meta.url), 'utf8');
  const style = dom.window.document.createElement('style'); style.textContent = css;
  dom.window.document.head.append(style);
  let message = 'Page shared';
  const bar = mountEmbedBar({ documentRef: dom.window.document, parent: dom.window.document.body,
    mode: 'embed', workspaceVisible: async () => false, readApprovals: async () => null,
    sharePage: async () => message });
  t.after(() => { bar.destroy(); dom.window.close(); });
  await bar.ready;
  const notice = bar.root.querySelector('[role=status]');
  for (const text of ['', 'Page shared', '']) {
    message = text;
    if (text || notice.textContent) { bar.root.querySelector('[data-control=page]').click(); await settle(); }
    assert.equal(notice.textContent, text);
    assert.equal(notice.hasAttribute('hidden'), false);
    assert.equal(notice.getAttribute('aria-live'), 'polite');
    // A clipped notice keeps its full text on hover.
    assert.equal(notice.title, text);
    const computed = dom.window.getComputedStyle(notice);
    assert.notEqual(computed.display, 'none');
    assert.notEqual(computed.visibility, 'hidden');
    if (!text) assert.equal(computed.opacity, '0');
  }
});

test('menu arrows move in opposite directions and wrap across all choices; Home and End reach edges', async t => {
  const f = fixture(); t.after(() => { f.bar.destroy(); f.dom.window.close(); });
  await f.bar.ready;
  const menu = f.bar.root.querySelector('[role=menu]');
  // A third DOM choice prevents two-item wrapping from hiding a reversed ArrowUp.
  const extra = f.dom.window.document.createElement('button');
  extra.setAttribute('role', 'menuitemradio'); extra.textContent = 'Another assistant'; menu.append(extra);
  const choices = [...menu.querySelectorAll('[role=menuitemradio]')];
  f.bar.root.querySelector('[data-control=assistant]').click();
  const key = (value, index) => {
    choices[index].focus();
    choices[index].dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }));
    return f.dom.window.document.activeElement;
  };
  for (let i = 0; i < choices.length; i++) {
    assert.equal(key('ArrowUp', i), choices[(i - 1 + choices.length) % choices.length]);
    assert.equal(key('ArrowDown', i), choices[(i + 1) % choices.length]);
    assert.equal(key('Home', i), choices[0]);
    assert.equal(key('End', i), choices.at(-1));
  }
  // With focus outside the choices, ArrowUp lands on the last and ArrowDown on the first.
  const fromOutside = value => {
    f.bar.root.querySelector('[data-control=assistant]').focus();
    f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }));
    return f.dom.window.document.activeElement;
  };
  assert.equal(fromOutside('ArrowUp'), choices.at(-1));
  assert.equal(fromOutside('ArrowDown'), choices[0]);
});
