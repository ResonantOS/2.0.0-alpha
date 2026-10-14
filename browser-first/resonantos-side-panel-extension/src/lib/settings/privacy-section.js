import { noteCard, settingsHeader } from "./settings-common.js";

function permissionRow({ title, boundary, status }) {
  const row = document.createElement("article");
  row.className = "settings-control-row";
  const copy = document.createElement("span");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("small");
  detail.textContent = boundary;
  copy.append(heading, detail);
  const badge = document.createElement("button");
  badge.type = "button";
  badge.disabled = true;
  badge.textContent = status;
  row.append(copy, badge);
  return row;
}

export function renderPrivacySection(container, context = {}) {
  const list = document.createElement("div");
  list.className = "settings-control-list";
  list.append(
    permissionRow({
      title: "Provider credentials",
      boundary: "Stored and used through host-mediated provider routes. Raw credentials should never render in the workspace.",
      status: "Vault mediated"
    }),
    permissionRow({
      title: "Living Archive writes",
      boundary: "Source intake, review, draft, verify, and promote remain separate. Add-ons cannot write trusted wiki pages directly.",
      status: "Two-tier writes"
    }),
    permissionRow({
      title: "Browser control",
      boundary: "Augmentor can act on pages only through typed actions, visible status, and approval gates for risky steps.",
      status: "Approval gated"
    }),
    permissionRow({
      title: "Wallet and payments",
      boundary: "Transaction signing, checkout, credential entry, and irreversible public actions are blocked or require explicit human approval.",
      status: "Human approval"
    }),
    permissionRow({
      title: "Diagnostics",
      boundary: "Support reports must redact bridge tokens, provider credentials, wallet material, and private path details.",
      status: "Redacted"
    })
  );

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Privacy and permissions",
      title: "Trust Boundaries",
      body: "Review the core safety boundaries that apply before add-ons, browser actions, providers, memory, or future wallet capabilities can operate."
    }),
    list,
    noteCard({
      title: "Default posture",
      body: "ResonantOS should expose capability, status, and audit trails to the human while keeping privileged operations behind explicit host boundaries.",
      tone: "warning"
    })
  );
  mountEmbedActivityCard({container,documentRef:container.ownerDocument,
    request:(path,options)=>{
      const bridge=typeof context.getBridgeRequest==='function'?context.getBridgeRequest():context.bridgeRequest;
      return typeof bridge==='function'?bridge(path,options):Promise.reject(Error('Activity unavailable'));
    }
  });
}

import { confirmEmbedAction } from '../embed-governance-dialog.js';
import { metadata, UUID, NOTICE_KEY } from '../generated/embed-governance-contract.js';
export function mountEmbedActivityCard({container,documentRef=globalThis.document,chromeApi=globalThis.chrome,request,confirm=options=>confirmEmbedAction(options)}) {
  const card=documentRef.createElement('section');card.className='settings-control-list embed-activity-card';card.dataset.embedActivity='true';
  const heading=documentRef.createElement('h3');heading.textContent='Embedded harness activity';
  const label=documentRef.createElement('label'),checkbox=documentRef.createElement('input');checkbox.type='checkbox';checkbox.disabled=true;checkbox.checked=false;
  label.append(checkbox,documentRef.createTextNode('Record harness activity'));
  const description=documentRef.createElement('p');description.textContent='Save conversation changes, reply starts and finishes, tool names and error flags, and shared page domains on this computer for 30 days. No prompts, replies, tool arguments or results are saved.';
  const status=documentRef.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Recording unavailable';
  const note=documentRef.createElement('p');note.textContent='Local metadata only. Harness events are reports from the outside harness, not ResonantOS approval receipts. Recording can miss events while the side panel is closed or disconnected.';
  const controls=documentRef.createElement('div'),list=documentRef.createElement('ol');list.hidden=true;
  const buttons={};for(const [key,text] of [['view','View activity'],['refresh','Refresh'],['older','Load older'],['delete','Delete activity']]){const b=documentRef.createElement('button');b.type='button';b.textContent=text;b.dataset.action=key;buttons[key]=b;controls.append(b);}
  buttons.older.disabled=true;card.append(heading,label,description,status,note,controls,list);container.append(card);
  let dead=false,sequence=0,pageSequence=0,snapshot=null,nextBefore=null,rows=[];
  const say=text=>{if(!dead)status.textContent=text;};
  function validSnapshot(s) {
    return s&&typeof s.recordingEnabled==='boolean'&&(s.writeEpoch===null||typeof s.writeEpoch==='string'&&UUID.test(s.writeEpoch))&&(s.noticeKey===null||typeof s.noticeKey==='string'&&NOTICE_KEY.test(s.noticeKey))&&typeof s.noticeAcknowledged==='boolean'&&typeof s.available==='boolean'&&[null,'storage-unavailable','retention-failed','log-full'].includes(s.problem);
  }
  function renderState(s) {
    if(!validSnapshot(s))throw Error('Invalid activity state');snapshot=s;
    checkbox.checked=s.recordingEnabled;checkbox.disabled=s.problem==='storage-unavailable'||(!s.available&&!s.recordingEnabled);
    container.dataset.noticeAcknowledged=String(s.noticeAcknowledged);
    container.dataset.writeEpoch=s.writeEpoch??'';
    const problems={'storage-unavailable':'Recording unavailable','retention-failed':'Retention cleanup failed','log-full':'Activity recording paused: local log is full'};
    say(problems[s.problem]??(s.recordingEnabled?'Recording is on':'Recording is off'));
  }
  function descriptionFor(event) {
    if(event.kind==='tool-finished')return `Tool: ${event.toolName} — ${event.error?'Error':'No error reported'}`;
    if(event.kind==='page-shared')return `Page shared: ${event.domain}`;
    return {'conversation-changed':'Conversation changed','reply-started':'Reply started','reply-finished':'Reply finished'}[event.kind];
  }
  function renderRows(){list.replaceChildren();list.hidden=false;for(const record of rows){const li=documentRef.createElement('li');li.textContent=`${record.recordedAt} · Augmentor · Self-governed · ${descriptionFor(record.event)}`;list.append(li);}if(!rows.length){const li=documentRef.createElement('li');li.textContent='No recorded activity';list.append(li);}buttons.older.disabled=!nextBefore;}
  async function refresh(){const seq=++sequence;try{const s=await request('/embed-governance/state');if(!dead&&seq===sequence)renderState(s);}catch{if(!dead&&seq===sequence){snapshot=null;checkbox.checked=false;checkbox.disabled=true;say('Recording unavailable');}}}
  async function load(older=false){const seq=++pageSequence;const anchor=older?nextBefore:null;try{
    const page=await request('/embed-governance/events'+(anchor?'?before='+encodeURIComponent(anchor):''));
    if(dead||seq!==pageSequence)return;
    if(!Array.isArray(page.events)||page.events.length>100||!(page.nextBefore===null||typeof page.nextBefore==='string'&&UUID.test(page.nextBefore)))throw Error();
    const clean=page.events.map(r=>{const event=metadata(r.event);if(!event||typeof r.recordedAt!=='string'||!Number.isFinite(Date.parse(r.recordedAt))||new Date(r.recordedAt).toISOString()!==r.recordedAt||r.harnessId!=='addon.augmentor-embed'||r.interfaceId!=='panel'||r.governance!=='self-governed')throw Error();return {recordedAt:r.recordedAt,event};});
    rows=older?[...rows,...clean]:clean;nextBefore=page.nextBefore;renderRows();
  }catch(e){if(dead||seq!==pageSequence)return;if(e?.code==='cursor-expired'){rows=[];nextBefore=null;list.replaceChildren();await load(false);}else say('Activity unavailable');}}
  checkbox.addEventListener('change',()=>{const enabled=checkbox.checked,seq=++sequence;checkbox.disabled=true;
    checkbox.checked=snapshot?.recordingEnabled??false;say('Saving recording preference');
    const changeId=crypto.randomUUID();
    const signal=pending=>chromeApi?.storage?.local?.set({'resonantos.embedRecordingChange':{id:changeId,pending}});
    void (async()=>{
      // Pause recipients before awaiting the durable host write; never store consent here.
      if(!enabled)try{await signal(true);}catch{ /* Host disablement still proceeds. */ }
      try{const s=await request('/embed-governance/recording',{method:'POST',body:{enabled}});if(!dead&&seq===sequence)renderState({...snapshot,...s});}
      catch{if(!dead&&seq===sequence){await refresh();say('Recording preference could not be saved');}}
      finally{try{await signal(false);}catch{ /* Recipients already paused stay fail-closed until remount if settlement fails. */ }}
    })();
  });
  buttons.view.addEventListener('click',()=>{void load();});buttons.refresh.addEventListener('click',()=>{void refresh();void load();});buttons.older.addEventListener('click',()=>{if(nextBefore)void load(true);});
  buttons.delete.addEventListener('click',()=>{void(async()=>{
    const recovery=snapshot?.problem==='storage-unavailable';
    let accepted;try{accepted=await confirm({documentRef,returnFocus:buttons.delete,heading:recovery?'Reset unreadable harness activity?':'Delete all recorded harness activity on this computer?',description:recovery?'This turns recording off and clears remembered first-share notices.':'This keeps your recording choice and first-share notices.',confirmLabel:'Delete activity'});}catch{say('Activity could not be deleted');return;}
    if(!accepted||dead)return;
    const seq=++sequence;++pageSequence;buttons.delete.disabled=true;
    try{const s=await request('/embed-governance/events/delete',{method:'POST',body:{}});if(dead||seq!==sequence)return;if(s.deleted!==true)throw Error();
      renderState({...snapshot,...s,problem:null});rows=[];nextBefore=null;renderRows();say('Activity deleted');
    }catch{if(!dead&&seq===sequence)say('Activity could not be deleted');}
    finally{if(!dead)buttons.delete.disabled=false;}
  })();});
  const ready=refresh();return {ready,refresh,destroy(){dead=true;sequence++;pageSequence++;card.remove();}};
}
