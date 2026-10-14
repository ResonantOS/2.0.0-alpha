import { redactTraceText } from './trace-redaction.js';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const NOTICE_KEY = /^augmentor-v1-[0-9a-f]{64}$/;
export const LIMITS = Object.freeze({ retention:2592000000, prune:3600000, records:10000, state:10*1024*1024, record:1024, page:100, queue:32, timeout:2000, poll:5000, history:50 });
export const ERRORS = Object.freeze({
  'invalid-request':[400,'Invalid activity request.'], unauthorized:[401,'Bridge authentication required.'], forbidden:[403,'Activity access denied.'],
  'unknown-route':[404,'Activity route unavailable.'], 'method-not-allowed':[405,'Activity method unavailable.'],
  'cursor-expired':[409,'Activity changed. Refresh the list.'], 'request-too-large':[413,'Activity request too large.'],
  'storage-unavailable':[503,'Activity storage unavailable.']
});
export function activityError(code) { const e=new Error('Activity request failed.'); e.code=Object.hasOwn(ERRORS,code)?code:'storage-unavailable'; return e; }
export function publicActivityError(error) {
  const code=Object.hasOwn(ERRORS,error?.code)?error.code:'storage-unavailable';
  return {status:ERRORS[code][0],payload:{ok:false,code,error:ERRORS[code][1]}};
}
export function exact(value, keys) {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors=Object.getOwnPropertyDescriptors(value), names=Object.keys(descriptors);
  return names.length===keys.length && keys.every(k => Object.hasOwn(descriptors,k) && Object.hasOwn(descriptors[k],'value') && descriptors[k].enumerable);
}
export function validDescriptor(d) {
  return exact(d,['harnessId','interfaceId','label','governance','noticeKey']) && d.harnessId==='addon.augmentor-embed' && d.interfaceId==='panel' && d.label==='Augmentor' && d.governance==='self-governed' && typeof d.noticeKey==='string' && NOTICE_KEY.test(d.noticeKey);
}
function bracketHostname(hostname) {
  return hostname.includes(':')&&!hostname.startsWith('[')?`[${hostname}]`:hostname;
}
export function validDomain(value) {
  if (typeof value!=='string' || !/^[\x21-\x7e]{1,253}$/.test(value) || /[@/?#\\]/.test(value) || value.endsWith('.') || value!==value.toLowerCase()) return false;
  try { const u=new URL(`http://${value}/`); return !u.username && !u.password && !u.port && bracketHostname(u.hostname)===value && u.pathname==='/'; } catch { return false; }
}
export function domainFromUrl(value) {
  try { const u=new URL(value); if (!['http:','https:'].includes(u.protocol)) return null;
    const d=bracketHostname(u.hostname).toLowerCase().replace(/\.$/,''); return validDomain(d)?d:null;
  } catch { return null; }
}
export function metadata(value) {
  try {
    if (exact(value,['kind']) && ['conversation-changed','reply-started','reply-finished'].includes(value.kind)) return {kind:value.kind};
    if (exact(value,['kind','toolName','error']) && value.kind==='tool-finished' && typeof value.toolName==='string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value.toolName) && typeof value.error==='boolean' && redactTraceText(value.toolName)===value.toolName) return {kind:'tool-finished',toolName:value.toolName,error:value.error};
    if (exact(value,['kind','domain']) && value.kind==='page-shared' && validDomain(value.domain)) return {kind:'page-shared',domain:value.domain};
  } catch { return null; }
  return null;
}
