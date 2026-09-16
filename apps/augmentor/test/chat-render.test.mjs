// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

import test from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {marked} from 'marked'
import {createChatUI} from '../extension/chat-render.js'

for (const delivery of ['live','history']) {
  test(`${delivery}: internal context is hidden; real user text and the answer remain intact`,t=>{
    const dom=new JSDOM('<div id="log"></div>',{pretendToBeVisual:true})
    globalThis.window=dom.window;globalThis.document=dom.window.document
    globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window)
    globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window)
    window.marked=marked
    const log=document.querySelector('#log'),ui=createChatUI({log})
    t.after(()=>{ui.clear();dom.window.close()})
    const userText='Rewrite this sentence.\n<system-reminder>This is text I supplied.</system-reminder>'
    const message=(seq,source,text)=>({kind:'event',event:{seq,type:'user/message',data:{source,content:[{type:'text',text}]}}})
    const events=[
      message(0,{kind:'user'},userText),
      message(1,{kind:'agent-instructions',form:'instructions'},'INTERNAL workspace instructions'),
      message(2,{kind:'plugin',form:'snapshot'},'INTERNAL runtime context'),
      message(3,{kind:'future-context-source',form:'catalog'},'INTERNAL catalog'),
      {kind:'event',event:{seq:4,type:'assistant/chunk',data:{chunk:{type:'text-delta',text:'A clearer sentence.'}}}},
      {kind:'event',event:{seq:5,type:'assistant/message',data:{message:{content:[{type:'text',text:'A clearer sentence.'}]}}}},
      {kind:'event',event:{seq:6,type:'step/end',data:{turn:1,step:1}}},
    ]
    if(delivery==='live')for(const event of events)ui.applyLog([event])
    else ui.applyLog(events.filter(entry=>entry.event.type!=='assistant/chunk'))
    assert.equal(log.querySelectorAll('.msg.user').length,1)
    assert.match(log.querySelector('.msg.user .md').textContent,/This is text I supplied/)
    assert.doesNotMatch(log.textContent,/INTERNAL/)
    assert.equal(log.querySelector('.msg.assistant .md').textContent.trim(),'A clearer sentence.')
    assert.equal(ui.lastSeq,6)
    ui.applyLog(events);assert.equal(log.querySelectorAll('.msg.user').length,1)
    ui.applyLog([message(7,undefined,'A legacy human message')])
    assert.equal(log.querySelectorAll('.msg.user').length,2)
    ui.applyLog([{kind:'event',event:{seq:8,type:'turn/end',data:{reason:{kind:'error',error:{message:'Model unavailable <script>unsafe</script>'}}}}}])
    assert.match(log.querySelector('.err').textContent,/Model unavailable/)
    assert.equal(log.querySelector('.err script'),null)
  })
}
