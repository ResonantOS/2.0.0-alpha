import { resolveBridgeConfig, initCapabilityTokens, createBridgeClient } from './lib/bridge-client.js';

export async function selectAgentViewMode(search = '', storage = globalThis.chrome?.storage?.local) {
  if (new URLSearchParams(search).get('agentView') === 'embed') return 'embed';
  try {
    const values = await storage?.get('resonantos.agentView');
    if (values?.['resonantos.agentView'] === 'embed') return 'embed';
  } catch { /* Unavailable preferences preserve normal startup. */ }
  return 'normal';
}

export async function mountEmbedView() {
  document.documentElement.classList.add('embed-mode');
  const root = document.createElement('section');
  root.id = 'embed-root';
  document.body.append(root);
  try {
    const config = await resolveBridgeConfig();
    await initCapabilityTokens(config);
    const { hostPath } = await createBridgeClient(config)('/embed/session', { method: 'POST', body: {} });
    if (typeof hostPath !== 'string' || !/^\/embed-host\/\?ticket=[A-Za-z0-9_-]{43}$/.test(hostPath)) throw new Error('Invalid embed session');
    const origin = new URL(config.bridgeUrl).origin;
    const iframe = document.createElement('iframe');
    iframe.title = 'Augmentor';
    iframe.allow = 'clipboard-write';
    const state = {
      ready: false,
      last: [],
      send(msg) { iframe.contentWindow?.postMessage(msg, origin); },
    };
    window.__resonantosEmbed = state;
    window.addEventListener('message', event => {
      if (event.source !== iframe.contentWindow || event.origin !== origin) return;
      if (!event.data || typeof event.data !== 'object') return;
      state.last.push(event.data);
      if (state.last.length > 50) state.last.splice(0, state.last.length - 50);
      if (event.data.type === 'augmentor-ready') state.ready = true;
    });
    // Install the relay listener before navigation; ready may arrive immediately.
    iframe.src = `${config.bridgeUrl.replace(/\/$/, '')}${hostPath}`;
    root.append(iframe);
  } catch {
    root.textContent = 'Unable to open the embedded chat. Check that the PoC bridge is running and try again.';
  }
}

export async function bootSidePanel({
  search = globalThis.location?.search ?? '',
  storage = globalThis.chrome?.storage?.local,
  loadNormal = () => import('./side-panel.js'),
  mountEmbed = mountEmbedView,
} = {}) {
  if (await selectAgentViewMode(search, storage) === 'embed') return mountEmbed();
  return loadNormal();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') void bootSidePanel();
