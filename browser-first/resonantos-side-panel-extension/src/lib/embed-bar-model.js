import { safeContextText, safeContextUrl } from './chat-turn-controller.js';
import { mainBrowserJobSnapshot } from './main-workspace-browser-jobs.js';

export function embedBarVisible(mode, available) {
  return mode === 'embed' || (mode === 'normal' && available === true);
}
export function embedStatusLabel(status) {
  if (status?.online !== true) return 'Offline';
  return status.busy === true ? 'Busy' : 'Online · idle';
}
export function pageContextMessage(tab) {
  if (!/^https?:\/\//i.test(tab?.url ?? '')) return null;
  const url = safeContextUrl(tab.url);
  if (!url) return null;
  const message = { type: 'augmentor-context', context: {
    source: 'resonantos', page: { title: safeContextText(tab.title, 1000), url }
  } };
  return new TextEncoder().encode(JSON.stringify(message)).byteLength <= 16000 ? message : null;
}
export function pendingApprovalCount(history) {
  if (history?.historyState !== 'ready') return null;
  return mainBrowserJobSnapshot(history).approvalJobs.length;
}
export function agentViewUrl(href, mode) {
  if (!['embed', 'normal'].includes(mode)) throw new Error('Invalid assistant');
  const url = new URL(href);
  if (url.searchParams.has('agentView')) url.searchParams.set('agentView', mode);
  return url.href;
}
