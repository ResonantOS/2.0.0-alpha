import { LIMITS, UUID, metadata, domainFromUrl, validDescriptor } from './generated/embed-governance-contract.js';
export function createEmbedGovernanceController({request,windowRef=globalThis.window,chromeApi=globalThis.chrome,confirmShare,announce=()=>{},uuid=()=>crypto.randomUUID(),setTimeoutImpl=setTimeout,clearTimeoutImpl=clearTimeout,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}) {
  let frame=null,origin='',descriptor=null,enabled=false,epoch=null,keyKnown=null,ack=false,localAck=false,stale=false,conversation=null,reply=null,closed=false,generation=0,mountGeneration=0,readSequence=0,failure=false;
  const history=[],queue=[],pending=new Set(),noticeWrites=new Set(),recordingChanges=new Set();let pumping=false;
  function tell(text){try{announce(text);}catch{}}
  function failed(){if(!failure){failure=true;tell('Activity was not recorded');}}
  function ring(value){history.push(value);if(history.length>LIMITS.history)history.splice(0,history.length-LIMITS.history);}
  function clear(cancelNotices=false){generation++;queue.length=0;for(const ac of pending)ac.abort();pending.clear();if(cancelNotices){for(const ac of noticeWrites)ac.abort();noticeWrites.clear();}history.splice(0,history.length,...history.filter(v=>v.type==='augmentor-ready'||v.type==='augmentor-status'));}
  async function bounded(path,options={}) {
    const ac=new AbortController(),requests=path==='/embed-governance/notice'?noticeWrites:pending;requests.add(ac);let timer;
    const timeout=new Promise((_,reject)=>{
      ac.signal.addEventListener('abort',()=>reject(Error('Activity unavailable')),{once:true});
      timer=setTimeoutImpl(()=>ac.abort(),LIMITS.timeout);
    });
    try{return await Promise.race([Promise.resolve().then(()=>{if(ac.signal.aborted)throw Error('Activity unavailable');return request(path,{...options,signal:ac.signal});}),timeout]);}
    finally{clearTimeoutImpl(timer);requests.delete(ac);}
  }
  async function refresh() {
    if(closed||recordingChanges.size)return;
    const seq=++readSequence,gen=generation;
    try {
      const s=await bounded('/embed-governance/state');
      if(closed||seq!==readSequence||gen!==generation)return;
      if(typeof s?.recordingEnabled!=='boolean'||!(s.writeEpoch===null||typeof s.writeEpoch==='string'&&UUID.test(s.writeEpoch))||typeof s.noticeAcknowledged!=='boolean'||s.noticeVersion!==1)throw Error();
      keyKnown=s.noticeKey;
      if(descriptor&&s.noticeKey!==descriptor.noticeKey){stale=true;ack=false;enabled=false;epoch=null;clear();return;}
      if(!s.recordingEnabled||!s.available||s.problem){enabled=false;epoch=null;clear();}
      else {if(!enabled||epoch!==s.writeEpoch)clear();enabled=true;epoch=s.writeEpoch;}
      ack=localAck||s.noticeAcknowledged;
      failure=false;
    }catch{if(!closed&&seq===readSequence){enabled=false;epoch=null;keyKnown=null;ack=localAck;clear();failed();}}
  }
  async function pump() {
    if(pumping||closed)return;pumping=true;
    try {
      while(queue.length&&enabled&&!closed) {
        const item=queue.shift(),gen=generation;
        try {
          const result=await bounded('/embed-governance/events',{method:'POST',body:item});
          if(gen!==generation||closed)continue;
          if(result.recorded===true){failure=false;continue;}
          failed();
          if(['stale-epoch','disabled','unavailable'].includes(result.reason)){enabled=false;clear();await refresh();}
        }catch{if(gen===generation&&!closed)failed();}
      }
    }finally{pumping=false;if(queue.length&&enabled&&!closed)void pump();}
  }
  function observe(value) {
    try {
      if(!enabled||!epoch||closed)return;
      const event=metadata(value);if(!event)return;
      ring(event);
      if(queue.length>=LIMITS.queue){failed();return;}
      queue.push({writeEpoch:epoch,eventId:uuid(),event});void pump();
    }catch{failed();}
  }
  function change(id,explicit) {
    if(typeof id!=='string'||[...id].length<1||[...id].length>128||/[\x00-\x1f\x7f]/.test(id))return;
    if(id!==conversation){if(conversation!==null||explicit){observe({kind:'conversation-changed'});reply=null;}conversation=id;}
  }
  function relay(event) {
    try {
      if(closed||!frame||event.source!==frame||event.origin!==origin)return;
      const data=event.data;if(!data||typeof data!=='object')return;
      if(data.type==='augmentor-ready'){ring({type:'augmentor-ready'});return;}
      if(data.type==='augmentor-status') {
        if(typeof data.online!=='boolean'||typeof data.busy!=='boolean')return;
        ring({type:'augmentor-status',online:data.online,busy:data.busy});
        if(!data.online){conversation=null;reply=null;return;}
        change(data.sessionId,false);return;
      }
      if(data.type!=='augmentor-event')return;
      if(data.event==='session.changed')change(data.data?.sessionId,true);
      else if(data.event==='turn.started'&&reply!=='started'){reply='started';observe({kind:'reply-started'});}
      else if(data.event==='turn.finished'&&reply!=='finished'){reply='finished';observe({kind:'reply-finished'});}
      else if(data.event==='tool.completed')observe({kind:'tool-finished',toolName:data.data?.tool,error:data.data?.isError});
    }catch{failed();}
  }
  function mount(value) {
    if(closed)return;mountGeneration++;clear(true);readSequence++;conversation=null;reply=null;ack=false;localAck=false;keyKnown=null;stale=false;enabled=false;epoch=null;history.length=0;
    frame=value?.frame??null;origin=value?.origin??'';descriptor=validDescriptor(value?.descriptor)?{...value.descriptor}:null;
    void refresh();
  }
  function currentShare(ticket){return !closed&&!stale&&!!descriptor&&ticket?.frame===frame&&ticket?.noticeKey===descriptor.noticeKey;}
  async function beginShare() {
    try {
      if(closed||!frame||!descriptor||stale)return 'Assistant unavailable';
      const mounted=frame,key=descriptor.noticeKey;
      await refresh();
      if(closed||frame!==mounted||descriptor?.noticeKey!==key||stale)return 'Assistant unavailable';
      const remember=!ack;
      if(remember&&await confirmShare(descriptor.label)!==true)return '';
      const ticket={frame:mounted,noticeKey:key,remember};
      return currentShare(ticket)?ticket:'Assistant unavailable';
    }catch{return 'Assistant unavailable';}
  }
  function didShare(ticket,url) {
    try {
      if(!currentShare(ticket))return;
      if(ticket.remember){ack=true;localAck=true;const gen=mountGeneration;
        void bounded('/embed-governance/notice',{method:'POST',body:{noticeKey:ticket.noticeKey,version:1}}).catch(()=>{
          if(!closed&&gen===mountGeneration)tell('Notice preference could not be saved. It may appear again.');
        });
      }
      const domain=domainFromUrl(url);if(domain)observe({kind:'page-shared',domain});
    }catch{failed();}
  }
  function stopRecording(){enabled=false;epoch=null;readSequence++;clear();}
  function destroy(){if(closed)return;closed=true;mountGeneration++;stopRecording();clear(true);history.length=0;clearIntervalImpl(timer);windowRef?.removeEventListener('focus',focus);windowRef?.removeEventListener('pagehide',destroy);chromeApi?.storage?.onChanged?.removeListener(recordingChanged);recordingChanges.clear();}
  const recordingChanged=(changes,area)=>{
    if(closed||area!=='local')return;
    const change=changes['resonantos.embedRecordingChange']?.newValue;
    if(!change||typeof change.id!=='string'||!UUID.test(change.id)||typeof change.pending!=='boolean')return;
    if(change.pending){recordingChanges.add(change.id);stopRecording();}
    else {recordingChanges.delete(change.id);void refresh();}
  };
  const focus=()=>{void refresh();};
  const timer=setIntervalImpl(focus,LIMITS.poll);
  windowRef?.addEventListener('focus',focus);windowRef?.addEventListener('pagehide',destroy);chromeApi?.storage?.onChanged?.addListener(recordingChanged);
  return {mount,relay,refresh,beginShare,currentShare,didShare,stopRecording,destroy,history};
}
