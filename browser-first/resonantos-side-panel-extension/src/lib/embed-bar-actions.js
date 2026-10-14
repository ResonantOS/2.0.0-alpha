import { createBrowserPageActions } from './browser-page-actions.js';
import { isControllableTabUrl } from './control-target-classification.js';
import { createSitePermissionStore } from './site-permission-store.js';
import { SIDE_PANEL_STORAGE_KEYS } from './side-panel-dom.js';
import { createMainWorkspaceBrowserJobController } from './main-workspace-browser-job-controller.js';
import { pageContextMessage, pendingApprovalCount, agentViewUrl } from './embed-bar-model.js';

export function createEmbedBarActions({ chromeApi, locationRef, sendContext, beforeShare = async () => 'Assistant unavailable', isShareCurrent = () => false, onShared = () => {} }) {
  let controlledTabId = null;
  // Construct the existing resolver; no capture or mutation methods are called.
  const { activeTab } = createBrowserPageActions({
    chrome: chromeApi,
    getControlledTabId: () => controlledTabId,
    setControlledTabId: value => { controlledTabId = value; },
    isReadableBrowserTab: tab => isControllableTabUrl(tab?.url)
  });
  const { permissionForUrl } = createSitePermissionStore({
    storage: chromeApi?.storage?.local,
    sitePermissionStorageKey: SIDE_PANEL_STORAGE_KEYS.sitePermissions
  });
  const { readJobs } = createMainWorkspaceBrowserJobController({
    storage: chromeApi?.storage?.local, storageKeys: SIDE_PANEL_STORAGE_KEYS
  });
  async function candidate() {
    let tab;try{tab=await activeTab();}catch{return 'No readable page';}
    if(!isControllableTabUrl(tab?.url))return 'No readable page';
    let mode;try{mode=await permissionForUrl(tab.url);}catch{return 'Site permissions unavailable';}
    if(mode==='blocked')return 'Page sharing blocked';
    if(!['read-only','ask-before-action','trusted-for-safe-actions'].includes(mode))return 'Site permissions unavailable';
    const message=pageContextMessage(tab);if(!message)return 'Page context unavailable';
    return {tabId:tab.id,url:message.context.page.url,message};
  }
  async function sharePage() {
    const first=await candidate();if(typeof first==='string')return first;
    let ticket;try{ticket=await beforeShare();}catch{return 'Assistant unavailable';}
    if(typeof ticket==='string')return ticket;
    if(!ticket)return 'Assistant unavailable';
    const final=await candidate();if(typeof final==='string')return final;
    if(first.tabId!==final.tabId||first.url!==final.url)return 'Page changed. Select Page again.';
    if(!isShareCurrent(ticket))return 'Assistant unavailable';
    // No await between the final checks and this one local dispatch.
    try{if(sendContext(final.message)!==true)return 'Assistant offline';}catch{return 'Assistant offline';}
    try{onShared(ticket,final.url);}catch{ /* A successful share is independent of recording. */ }
    return 'Page shared';
  }
  async function selectAssistant(mode) {
    const nextUrl = agentViewUrl(locationRef.href, mode);
    if (typeof chromeApi?.storage?.local?.set !== 'function') throw new Error('Preferences unavailable');
    await chromeApi.storage.local.set({ 'resonantos.agentView': mode });
    locationRef.assign(nextUrl);
  }
  async function readApprovals() { return pendingApprovalCount(await readJobs()); }
  return { sharePage, selectAssistant, readApprovals };
}
