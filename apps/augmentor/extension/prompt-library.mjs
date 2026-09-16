// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

export function slashQuery(text, position) {
  const match=/^\/([a-zA-Z0-9_-]*)$/.exec(text.slice(0,position))
  return match ? match[1].toLowerCase() : null
}
export function matchPrompts(prompts, query) {
  return prompts.filter(p=>p.name.includes(query)).sort((a,b)=>
    Number(!a.name.startsWith(query))-Number(!b.name.startsWith(query)) || a.name.localeCompare(b.name))
}

export function attachPromptLibrary({input, send, settingsButton}) {
  const doc=input.ownerDocument, win=doc.defaultView
  const menu=doc.createElement('div');menu.id='prompt-completions';menu.hidden=true
  menu.setAttribute('role','listbox');menu.setAttribute('aria-label','Saved prompts');doc.body.append(menu)
  let library={revision:0,prompts:[]}, loaded=false, pending=null, errorText=''
  let choices=[], selected=0, dismissed=null, lastRead=0
  const hide=()=>{menu.hidden=true;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false')}
  input.setAttribute('aria-controls',menu.id);input.setAttribute('aria-autocomplete','list')
  const request=async payload=>{
    const result=await send('prompts',{request:payload})
    if(!result?.ok)throw new Error(result?.error??'Prompt library unavailable. Reload the Augmentor extension to load its update.')
    library=result.library;loaded=true;errorText='';lastRead=Date.now();return library
  }
  const load=()=>pending??(pending=request({action:'list'}).finally(()=>pending=null))
  const positionMenu=()=>{
    const r=input.getBoundingClientRect();menu.style.width=Math.max(230,r.width)+'px'
    menu.style.left=Math.max(8,Math.min(r.left,win.innerWidth-menu.offsetWidth-8))+'px'
    menu.style.top=Math.max(8,r.top-menu.offsetHeight-5)+'px'
  }
  const paint=()=>{
    const query=slashQuery(input.value,input.selectionStart)
    if(query===null||doc.activeElement!==input||dismissed===input.value){hide();return}
    choices=errorText?[]:matchPrompts(library.prompts,query);selected=Math.min(selected,Math.max(0,choices.length-1))
    menu.replaceChildren();menu.hidden=false;input.setAttribute('aria-expanded','true')
    if(!choices.length){const note=doc.createElement('p');note.textContent=errorText || (loaded ? (library.prompts.length ? 'No matching prompts' : 'Add prompts in DSH Settings → Prompt library') : 'Loading DSH prompts…');menu.append(note)}
    choices.forEach((p,index)=>{
      const row=doc.createElement('button');row.type='button';row.id='saved-prompt-'+index;row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===selected))
      row.textContent='/'+p.name+'\n'+p.content.replace(/\s+/g,' ').slice(0,75)
      row.addEventListener('mousedown',event=>event.preventDefault());row.addEventListener('click',()=>choose(index));menu.append(row)
    })
    if(choices.length){input.setAttribute('aria-activedescendant','saved-prompt-'+selected);menu.children[selected]?.scrollIntoView?.({block:'nearest'})}
    positionMenu()
  }
  const choose=index=>{
    const item=choices[index];if(!item||slashQuery(input.value,input.selectionStart)===null)return
    let end=input.selectionStart;while(/[a-zA-Z0-9_-]/.test(input.value[end]??'')&&end<input.value.length)end++
    input.setRangeText(item.content,0,end,'end');hide();input.dispatchEvent(new win.Event('input',{bubbles:true}));input.focus()
  }
  const refresh=()=>{
    if(slashQuery(input.value,input.selectionStart)===null){hide();return}
    paint()
    if(Date.now()-lastRead>1000)load().then(paint).catch(error=>{
      errorText=error.message;lastRead=Date.now();paint()
    })
  }
  input.addEventListener('input',()=>{dismissed=null;selected=0;refresh()})
  input.addEventListener('click',refresh);input.addEventListener('focus',refresh)
  input.addEventListener('keydown',event=>{
    if(event.isComposing||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return
    if(menu.hidden)return
    if(['ArrowUp','ArrowDown','Enter','Tab','Escape'].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation()
      if(event.key==='Escape'){dismissed=input.value;hide()}
      else if(event.key==='Enter'||event.key==='Tab'){if(!event.repeat)choose(selected)}
      else if(choices.length){selected=(selected+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;paint()}
    }
  },true)
  input.addEventListener('blur',hide);win.addEventListener('resize',hide)
  settingsButton.title='Open DSH → Settings → Prompt library'
  settingsButton.setAttribute('aria-label',settingsButton.title)
  settingsButton.addEventListener('click',()=>{
    hide();send('promptSettings').catch(error=>{settingsButton.title=error.message})
  })
  const timer=win.setInterval(()=>{if(!menu.hidden)refresh()},1500)
  win.addEventListener('pagehide',()=>win.clearInterval(timer),{once:true})
  return {menu,refresh}
}
