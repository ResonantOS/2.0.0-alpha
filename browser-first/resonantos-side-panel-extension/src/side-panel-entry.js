import { createEmbedGovernanceController } from './lib/embed-governance-controller.js';
import { confirmEmbedShare } from './lib/embed-governance-dialog.js';
import { validDescriptor } from './lib/generated/embed-governance-contract.js';
import { resolveBridgeConfig, initCapabilityTokens, createBridgeClient } from './lib/bridge-client.js';
import { createMainWorkspaceToggle } from './lib/main-workspace-toggle.js';
import { createEmbedBarActions } from './lib/embed-bar-actions.js';
import { mountEmbedBar } from './lib/embed-bar.js';
import { embedBarVisible } from './lib/embed-bar-model.js';

const RELAY_COMMANDS = new Set(['augmentor-prompt', 'augmentor-new-chat', 'augmentor-focus', 'augmentor-context']);
function bounded(work, ms = 8000) {
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Embed unavailable')), ms);
  })]).finally(() => clearTimeout(timer));
}
export async function selectAgentViewMode(search = '', storage = globalThis.chrome?.storage?.local) {
  const queryMode = new URLSearchParams(search).get('agentView');
  if (queryMode === 'embed' || queryMode === 'normal') return queryMode;
  try {
    const values = await storage?.get('resonantos.agentView');
    if (values?.['resonantos.agentView'] === 'embed') return 'embed';
  } catch { /* Unavailable preferences preserve normal startup. */ }
  return 'normal';
}
export async function createEmbedConnection() {
  const config = await resolveBridgeConfig();
  await initCapabilityTokens(config);
  return { bridgeUrl: config.bridgeUrl, request: createBridgeClient(config) };
}
export async function probeEmbedAvailability(getConnection = createEmbedConnection) {
  try {
    return await bounded(async () => {
      const { request } = await getConnection();
      const result = await request('/embed/status', { method: 'GET' });
      return result.available === true;
    });
  } catch { return false; }
}
function mountSidePanelBar({ mode, sendContext = () => false, beforeShare, isShareCurrent, onShared, documentRef = globalThis.document, windowRef = globalThis.window, chromeApi = globalThis.chrome, locationRef = globalThis.location } = {}) {
  const workspace = createMainWorkspaceToggle({ tabsApi: chromeApi?.tabs,
    windowsApi: chromeApi?.windows,
    getWorkspaceUrl: () => chromeApi.runtime.getURL('src/main-workspace.html') });
  const actions = createEmbedBarActions({ chromeApi, locationRef, sendContext, beforeShare, isShareCurrent, onShared });
  const bar = mountEmbedBar({ documentRef, parent: documentRef.body, mode,
    toggleWorkspace: workspace.toggle, workspaceVisible: workspace.isVisible,
    openWorkspace: workspace.open, ...actions });
  documentRef.documentElement.classList.add('has-embed-bar');
  const refresh = () => { void bar.refresh(); };
  const tabUpdated = (_tabId, changeInfo) => {
    if (changeInfo?.status === 'complete' || changeInfo?.url !== undefined) refresh();
  };
  const storageChanged = (changes, area) => {
    if (area === 'local' && (changes.augmentorBrowserJobs || changes.augmentorActiveBrowserJob)) refresh();
  };
  const events = mode === 'embed' ? [[chromeApi?.tabs?.onActivated, refresh],
    [chromeApi?.tabs?.onUpdated, tabUpdated], [chromeApi?.tabs?.onRemoved, refresh],
    [chromeApi?.storage?.onChanged, storageChanged]] : [];
  for (const [event, listener] of events) event?.addListener(listener);
  const destroy = bar.destroy;
  const onPageHide = () => bar.destroy();
  bar.destroy = () => {
    for (const [event, listener] of events) event?.removeListener(listener);
    windowRef.removeEventListener('pagehide', onPageHide);
    documentRef.documentElement.classList.remove('has-embed-bar');
    destroy();
  };
  windowRef.addEventListener('pagehide', onPageHide, { once: true });
  return bar;
}
export async function mountEmbedView({documentRef=globalThis.document,windowRef=globalThis.window,chromeApi=globalThis.chrome,locationRef=globalThis.location,getConnection=createEmbedConnection}={}) {
  documentRef.documentElement.classList.add('embed-mode');
  const root=documentRef.createElement('section');root.id='embed-root';documentRef.body.prepend(root);
  let frame=null,origin='',online=false,connection=null,descriptor=null,disposed=false;
  const state={ready:false,last:[],send(message){
    if(disposed||!state.ready||!online||!frame?.contentWindow||!RELAY_COMMANDS.has(message?.type))return false;
    try{if(message.type==='augmentor-context'&&new TextEncoder().encode(JSON.stringify(message)).byteLength>16000)return false;frame.contentWindow.postMessage(message,origin);return true;}catch{return false;}
  }};
  const controller=createEmbedGovernanceController({windowRef,chromeApi,
    request:(path,options)=>connection?connection.request(path,options):Promise.reject(Error('Activity unavailable')),
    announce:text=>bar.announce(text),
    confirmShare:label=>confirmEmbedShare({documentRef,label,returnFocus:bar.root.querySelector('[data-control=page]')})
  });
  state.last=controller.history;windowRef.__resonantosEmbed=state;
  const bar=mountSidePanelBar({mode:'embed',documentRef,windowRef,chromeApi,locationRef,
    sendContext:message=>state.send(message),beforeShare:controller.beginShare,isShareCurrent:controller.currentShare,onShared:controller.didShare});
  const offline=()=>{state.ready=false;online=false;bar.setStatus(null);controller.relay({source:frame?.contentWindow,origin,data:{type:'augmentor-status',online:false,busy:false}});};
  const relay=event=>{
    if(disposed||!frame||event.source!==frame.contentWindow||event.origin!==origin||!event.data||typeof event.data!=='object')return;
    if(event.data.type==='augmentor-ready')state.ready=true;
    if(event.data.type==='augmentor-status'&&typeof event.data.online==='boolean'&&typeof event.data.busy==='boolean'){
      online=event.data.online;bar.setStatus({online,busy:event.data.busy});
    }
    if(['augmentor-ready','augmentor-status','augmentor-event'].includes(event.data.type))controller.relay(event);
  };
  const bridgeChanged=(changes,area)=>{if(area==='local'&&changes.bridgeTargetOverride){offline();controller.destroy();descriptor=null;}};
  windowRef.addEventListener('message',relay);chromeApi?.storage?.onChanged?.addListener(bridgeChanged);
  const destroy=bar.destroy;
  bar.destroy=()=>{if(disposed)return;disposed=true;windowRef.removeEventListener('message',relay);chromeApi?.storage?.onChanged?.removeListener(bridgeChanged);controller.destroy();offline();destroy();};
  try {
    connection=await bounded(getConnection);
    const session=await bounded(()=>connection.request('/embed/session',{method:'POST',body:{}}));
    if(disposed)return {bar,root,state};
    if(typeof session.hostPath!=='string'||!/^\/embed-host\/\?ticket=[A-Za-z0-9_-]{43}$/.test(session.hostPath)||!validDescriptor(session.harness))throw Error('Invalid embed session');
    descriptor=session.harness;origin=new URL(connection.bridgeUrl).origin;bar.setDescriptor(descriptor);
    frame=documentRef.createElement('iframe');frame.title=descriptor.label;frame.allow='clipboard-write';frame.addEventListener('error',offline);
    frame.src=connection.bridgeUrl.replace(/\/$/,'')+session.hostPath;root.append(frame);
    controller.mount({frame:frame.contentWindow,origin,descriptor});
  }catch{offline();root.textContent='Unable to open the embedded chat. Check that the PoC bridge is running and try again.';}
  return {bar,root,state};
}
export async function bootSidePanel({ search = globalThis.location?.search ?? '',
  storage = globalThis.chrome?.storage?.local,
  loadNormal = () => import('./side-panel.js'), mountEmbed = mountEmbedView,
  probeAvailability = probeEmbedAvailability,
  mountNormalBar = () => mountSidePanelBar({ mode: 'normal' }) } = {}) {
  const mode = await selectAgentViewMode(search, storage);
  if (mode === 'embed') return mountEmbed();
  const normal = await loadNormal();
  let available = false;
  try { available = await probeAvailability(); } catch { /* Hide unavailable normal-mode affordance. */ }
  if (embedBarVisible(mode, available)) mountNormalBar();
  return normal;
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') void bootSidePanel();
