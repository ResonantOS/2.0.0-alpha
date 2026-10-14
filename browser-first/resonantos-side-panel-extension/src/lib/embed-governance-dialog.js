let sequence=0;
export function confirmEmbedAction({documentRef=globalThis.document,heading,description,confirmLabel,returnFocus=documentRef.activeElement}) {
  return new Promise(resolve=>{
    const overlay=documentRef.createElement('div');overlay.className='embed-dialog-overlay';
    const dialog=documentRef.createElement('section');dialog.className='embed-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
    const title=documentRef.createElement('h2'),body=documentRef.createElement('p');
    const id='embed-dialog-'+(++sequence);title.id=id+'-title';body.id=id+'-body';title.textContent=heading;body.textContent=description;
    dialog.setAttribute('aria-labelledby',title.id);dialog.setAttribute('aria-describedby',body.id);
    const cancel=documentRef.createElement('button'),confirm=documentRef.createElement('button');
    cancel.type=confirm.type='button';cancel.textContent='Cancel';confirm.textContent=confirmLabel;confirm.dataset.confirm='true';
    dialog.append(title,body,cancel,confirm);overlay.append(dialog);documentRef.body.append(overlay);
    let done=false;
    const finish=value=>{if(done)return;done=true;documentRef.removeEventListener('keydown',key,true);documentRef.removeEventListener('focusin',focus,true);documentRef.defaultView?.removeEventListener('pagehide',hide);overlay.remove();returnFocus?.focus?.();resolve(value);};
    const key=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}
      if(event.key==='Tab'){event.preventDefault();(documentRef.activeElement===cancel?confirm:cancel).focus();}
    };
    const focus=event=>{if(!dialog.contains(event.target))cancel.focus();};
    const hide=()=>finish(false);
    cancel.addEventListener('click',()=>finish(false));confirm.addEventListener('click',()=>finish(true));
    documentRef.addEventListener('keydown',key,true);documentRef.addEventListener('focusin',focus,true);documentRef.defaultView?.addEventListener('pagehide',hide,{once:true});cancel.focus();
  });
}
export function confirmEmbedShare({documentRef,label,returnFocus}) {
  return confirmEmbedAction({documentRef,returnFocus,heading:`Share this page with ${label}?`,description:`${label} runs outside ResonantOS approvals. Its own approvals cover its tools. Sharing sends this page's title and address to ${label}. It does not give ${label} permission to use ResonantOS tools or control this page.`,confirmLabel:'Share page'});
}
