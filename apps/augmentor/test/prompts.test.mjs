// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {JSDOM} from 'jsdom'
import {promptLibrary} from '../shared/prompts.mjs'
import {attachPromptLibrary} from '../extension/prompt-library.mjs'

const section=()=>({ns:'prompt-library',revision:3,value:{prompts:[{id:'1',name:'summary',content:'Summarise this.\nKeep details.'},{id:'2',name:'translate',content:'Translate into Italian.'}]}})
test('bridge reads only the DSH catalog and cannot mutate or leak other settings',async()=>{
  const calls=[]
  const dsh=async(method,payload)=>{calls.push({method,payload});return {namespaces:[{ns:'unrelated',value:{private:'not for the extension'}},section()]}}
  assert.deepEqual(await promptLibrary({action:'list'},dsh),{ok:true,library:{revision:3,prompts:section().value.prompts}})
  assert.deepEqual(calls,[{method:'settings.describe',payload:{}}])
  assert.equal((await promptLibrary({action:'save'},dsh)).ok,false);assert.equal(calls.length,1)
  assert.equal((await promptLibrary({},async()=>({namespaces:[]}))).ok,false)
  assert.equal((await promptLibrary({},async()=>{throw new Error('offline')})).ok,false)
})

test('real native-messaging pipe reads the DSH Prompt library plugin',async t=>{
  const server=createServer(async(req,res)=>{
    let bytes='';for await(const chunk of req)bytes+=chunk
    if(req.url!=='/api/settings/describe'){res.writeHead(404);res.end('{}');return}
    const msg=JSON.parse(bytes)
    assert.deepEqual(msg.payload,{args:{}})
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:msg.rpcId,result:{ok:true,value:{namespaces:[section()]}}}))
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()})
  const pipe=spawn(process.execPath,[fileURLToPath(new URL('../pipe.mjs',import.meta.url))],{
    env:{...process.env,DSH_AUGMENTOR_URL:'http://127.0.0.1:'+server.address().port},stdio:['pipe','pipe','pipe']})
  t.after(()=>pipe.kill());pipe.stderr.resume()
  const answer=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Native prompt request timed out')),4000);let buffer=Buffer.alloc(0)
    pipe.stdout.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4||buffer.length<buffer.readUInt32LE(0)+4)return
      clearTimeout(timer);resolve(JSON.parse(buffer.subarray(4,buffer.readUInt32LE(0)+4)))
    })
  })
  const body=Buffer.from(JSON.stringify({id:'prompt-list',method:'augmentor/prompts',params:{action:'list'}})),header=Buffer.alloc(4)
  header.writeUInt32LE(body.length);pipe.stdin.write(Buffer.concat([header,body]))
  assert.deepEqual((await answer).result,{ok:true,library:{revision:3,prompts:section().value.prompts}})
})

test('slash menu inserts a plain draft without sending and settings opens DSH',async t=>{
  const dom=new JSDOM('<textarea id="input"></textarea><button id="settings">Settings</button>',{pretendToBeVisual:true});t.after(()=>dom.window.close())
  const doc=dom.window.document,input=doc.querySelector('#input');let sent=0,opened=0
  const view=attachPromptLibrary({input,settingsButton:doc.querySelector('#settings'),send:async type=>{
    if(type==='promptSettings'){opened++;return {ok:true}}
    return {ok:true,library:{revision:3,prompts:section().value.prompts}}
  }})
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.defaultPrevented)sent++})
  input.focus();input.value='/sum';input.setSelectionRange(4,4);input.dispatchEvent(new dom.window.Event('input'))
  await new Promise(r=>setTimeout(r,10))
  assert.equal(view.menu.querySelectorAll('button').length,1)
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  assert.equal(input.value,'Summarise this.\nKeep details.');assert.equal(sent,0)
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.equal(sent,1)
  doc.querySelector('#settings').click();assert.equal(opened,1)
  assert.equal(doc.querySelector('dialog'),null)
  assert.match(doc.querySelector('#settings').title,/DSH.*Settings.*Prompt library/)
})
