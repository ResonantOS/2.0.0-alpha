import { embedStatusLabel } from './embed-bar-model.js';

export function mountEmbedBar({ documentRef, parent, mode, toggleWorkspace,
  workspaceVisible, openWorkspace, selectAssistant, sharePage, readApprovals }) {
  const root = documentRef.createElement('nav');
  root.id = 'resonantos-bar';
  root.className = 'embed-bar';
  root.setAttribute('aria-label', 'ResonantOS');
  const notice = documentRef.createElement('span');
  notice.className = 'embed-bar-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.hidden = true;
  let disposed = false;
  const announce = text => {
    if (disposed) return;
    notice.textContent = text;
    notice.title = text;
    notice.hidden = !text;
  };
  function button(name, control, path) {
    const node = documentRef.createElement('button');
    node.type = 'button'; node.title = name;
    node.setAttribute('aria-label', name);
    node.dataset.control = control;
    const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const shape = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path); svg.append(shape); node.append(svg); root.append(node);
    return node;
  }
  const run = (action, failure) => Promise.resolve().then(action).catch(() => announce(failure));
  let workspace, approvals, status;
  if (mode === 'embed') {
    workspace = button('Workspace', 'workspace', 'M3 4h18v16H3z M9 4v16');
    workspace.setAttribute('aria-pressed', 'false');
    workspace.addEventListener('click', () => run(async () => {
      workspace.setAttribute('aria-pressed', String(await toggleWorkspace()));
    }, 'Workspace unavailable'));
  }
  const assistant = button('Assistant', 'assistant', 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4');
  assistant.setAttribute('aria-haspopup', 'menu');
  assistant.setAttribute('aria-expanded', 'false');
  assistant.setAttribute('aria-controls', 'embed-assistant-menu');
  const menu = documentRef.createElement('div');
  menu.id = 'embed-assistant-menu'; menu.className = 'embed-assistant-menu';
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Assistant'); menu.hidden = true;
  const choices = [];
  function closeMenu() { menu.hidden = true; assistant.setAttribute('aria-expanded', 'false'); }
  for (const [value, label] of [['embed', 'Augmentor'], ['normal', 'ResonantOS']]) {
    const choice = documentRef.createElement('button');
    choice.type = 'button'; choice.textContent = label; choice.title = label;
    choice.dataset.mode = value; choice.setAttribute('aria-label', label);
    choice.setAttribute('role', 'menuitemradio');
    choice.setAttribute('aria-checked', String(mode === value));
    choice.addEventListener('click', () => {
      closeMenu(); assistant.focus();
      void run(() => selectAssistant(value), 'Assistant switch unavailable');
    });
    choices.push(choice); menu.append(choice);
  }
  assistant.addEventListener('click', () => {
    if (!menu.hidden) { closeMenu(); return; }
    menu.hidden = false; assistant.setAttribute('aria-expanded', 'true');
    choices[mode === 'embed' ? 0 : 1].focus();
  });
  const keydown = event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault(); closeMenu(); assistant.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = choices.indexOf(documentRef.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (current + 1) % 2;
      choices[index].focus();
    } else if (event.key === 'Tab') closeMenu();
  };
  const outside = event => { if (!root.contains(event.target)) closeMenu(); };
  documentRef.addEventListener('keydown', keydown);
  documentRef.addEventListener('pointerdown', outside);
  if (mode === 'embed') {
    const page = button('Page', 'page', 'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6');
    page.addEventListener('click', () => {
      if (page.disabled) return;
      page.disabled = true;
      void run(async () => announce(await sharePage()), 'Page context unavailable')
        .finally(() => { page.disabled = false; });
    });
    approvals = button('Approvals unavailable', 'approvals', 'M5 4h14v16H5z M8 12l3 3 5-6');
    const count = documentRef.createElement('span'); count.className = 'embed-approval-count';
    count.setAttribute('aria-hidden', 'true'); count.textContent = '—'; approvals.append(count);
    approvals.addEventListener('click', () => run(() => openWorkspace(), 'Workspace unavailable'));
    status = documentRef.createElement('span'); status.dataset.control = 'status';
    status.className = 'embed-bar-status'; status.setAttribute('aria-live', 'polite');
    root.append(status);
  }
  root.append(menu, notice);
  parent.prepend(root);
  function setStatus(value) {
    if (!status || disposed) return;
    const label = embedStatusLabel(value);
    status.textContent = label; status.title = label;
    status.setAttribute('aria-label', `Status: ${label}`);
    status.dataset.state = value?.online === true ? (value.busy === true ? 'busy' : 'online') : 'offline';
  }
  async function refresh() {
    if (mode !== 'embed' || disposed) return;
    const [visible, count] = await Promise.all([
      Promise.resolve().then(workspaceVisible).catch(() => false),
      Promise.resolve().then(readApprovals).catch(() => null)
    ]);
    if (disposed) return;
    workspace.setAttribute('aria-pressed', String(visible));
    const label = count === null ? 'Approvals unavailable' : `Approvals: ${count} pending`;
    approvals.title = label; approvals.setAttribute('aria-label', label);
    approvals.querySelector('span').textContent = count === null ? '—' : String(count);
  }
  setStatus(null);
  const ready = refresh();
  return { root, ready, refresh, setStatus, destroy() {
    disposed = true;
    documentRef.removeEventListener('keydown', keydown);
    documentRef.removeEventListener('pointerdown', outside);
    root.remove();
  } };
}
