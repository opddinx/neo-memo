import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, initStore } from '../src/store/index.mjs';
import { pullSlack,pullDiscord,pullXBookmarks,importXPage } from '../src/adapters/pull.mjs';
import { ConnectorState } from '../src/core/connector-state.mjs';
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'neo-adapter-')),cache=`${root}-cache`;t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(cache,{recursive:true,force:true})]));const store=await initStore(root);store.checkpoints=new ConnectorState(cache);return store;}
const slackMessage=(ts,text)=>({ts,text,user:'U12345'});
test('Slack pages and replay deduplicate; channel cursor stored after capture',async t=>{
 const s=await setup(t),calls=[];
 const api=async url=>{const p=new URL(url).searchParams;calls.push(p);return p.get('cursor')?{ok:true,messages:[slackMessage('1.000001','https://example.com/one 一つ目')],response_metadata:{}}:{ok:true,messages:[slackMessage('2.000001','https://example.com/two 二つ目')],has_more:true,response_metadata:{next_cursor:'next'}};};
 const r=await pullSlack(s,{token:'fake',channel:'C12345',api,delay:0});assert.equal(r.count,2);assert.equal(s.items.size,2);assert.equal((await s.checkpoints.read()).sources['slack:C12345'].high,'2.000001');
 const repeated=await pullSlack(s,{token:'fake',channel:'C12345',api,delay:0});assert.equal(repeated.count,0);
});
test('Slack interrupted paging resumes without skipping the older page',async t=>{
 const s=await setup(t);let fail=true;
 const api=async url=>new URL(url).searchParams.get('cursor')?(fail?Promise.reject(new Error('offline')):{ok:true,messages:[slackMessage('1.000001','https://example.com/old')],response_metadata:{}}):{ok:true,messages:[slackMessage('3.000001','https://example.com/new')],has_more:true,response_metadata:{next_cursor:'continue'}};
 await assert.rejects(pullSlack(s,{token:'f',channel:'C12345',api,delay:0}));assert.equal(s.items.size,1);assert.equal((await s.checkpoints.read()).sources['slack:C12345'].high,'0');
 fail=false;await pullSlack(s,{token:'f',channel:'C12345',api,delay:0});assert.equal(s.items.size,2);assert.equal((await s.checkpoints.read()).sources['slack:C12345'].high,'3.000001');
});
test('Storage failure before checkpoint never advances source cursor',async t=>{
 const s=await setup(t);const capture=s.capture.bind(s);let calls=0;s.capture=async args=>{if(++calls===2)throw new Error('disk full');return capture(args);};
 const api=async()=>({ok:true,messages:[slackMessage('2.000001','https://example.com/2'),slackMessage('1.000001','https://example.com/1')],response_metadata:{}});
 await assert.rejects(pullSlack(s,{token:'f',channel:'C12345',api,delay:0}));assert.equal((await s.checkpoints.read()).sources['slack:C12345'],undefined);
 s.capture=capture;await pullSlack(s,{token:'f',channel:'C12345',api,delay:0});assert.equal(s.items.size,2);assert.ok([...s.items.values()].every(i=>i.captures.length===1));
});
test('Slack user filter imports only user messages, not other members or bots',async t=>{
 const s=await setup(t);await pullSlack(s,{token:'f',channel:'C12345',user:'U12345',delay:0,api:async()=>({ok:true,messages:[{ts:'3.000001',text:'bot',bot_id:'B1'},{ts:'2.000001',text:'other',user:'U54321'},slackMessage('1.000001','my thought')],response_metadata:{}})});assert.equal(s.items.size,1);
});
test('Slack invalid_cursor clears unfinished scan for safe replay',async t=>{
 const s=await setup(t);await s.checkpoints.write({schema:1,sources:{'slack:C12345':{high:'1.0',scan:{base:'1.0',latest:'10.0',cursor:'expired',high:'2.0'}}}});
 await assert.rejects(pullSlack(s,{token:'f',channel:'C12345',api:async()=>({ok:false,error:'invalid_cursor'})}));assert.equal((await s.checkpoints.read()).sources['slack:C12345'].scan,undefined);
});
test('Discord REST import and idempotent repeat',async t=>{
 const s=await setup(t),msgs=[{id:'200',type:0,content:'https://example.com/a メモ',author:{id:'1'},timestamp:'2026-09-01T10:00:00Z'}];
 await pullDiscord(s,{token:'f',channel:'123456',api:async()=>msgs});assert.equal(s.items.size,1);
 await pullDiscord(s,{token:'f',channel:'123456',api:async()=>msgs});assert.equal([...s.items.values()][0].captures.length,1);
});
test('Discord missing MESSAGE CONTENT INTENT does not advance state',async t=>{
 const s=await setup(t);await assert.rejects(pullDiscord(s,{token:'f',channel:'123456',api:async()=>[{id:'200',type:0,content:'',attachments:[],author:{id:'1'}}]}),/INTENT/);assert.equal((await s.checkpoints.read()).sources['discord:123456'],undefined);
});
test('Discord scans backwards across 100-message page without skipping older entries',async t=>{
 const s=await setup(t);const make=id=>({id:String(id),type:0,content:`https://example.com/${id}`,author:{id:'1'},timestamp:'2026-09-01T10:00:00Z'});
 const api=async url=>new URL(url).searchParams.has('before')?[make(1)]:Array.from({length:100},(_,i)=>make(i+2));
 const r=await pullDiscord(s,{token:'f',channel:'123456',api,delay:0});assert.equal(r.count,101);assert.equal(s.items.size,101);assert.equal((await s.checkpoints.read()).sources['discord:123456'].high,'101');
});
test('X JSON import enriches Slack capture while preserving human notes',async t=>{
 const s=await setup(t);await s.capture({input:'https://x.com/a/status/12345',note:'my reason'});
 await importXPage(s,{data:[{id:'12345',text:'Some post',author_id:'10'}],includes:{users:[{id:'10',name:'Test',username:'test'}]}});
 assert.equal(s.items.size,1);const it=[...s.items.values()][0];assert.equal(it.title,'Some post');assert.equal(it.captures[0].note,'my reason');assert.equal(it.author,'Test (@test)');
});
test('X cost-bounded pagination checkpoints exactly one page',async t=>{
 const s=await setup(t);let calls=0;
 const r=await pullXBookmarks(s,{token:'f',userId:'12345',maxPages:1,api:async()=>{calls++;return {data:[{id:'1000',text:'post'}],meta:{next_token:'page2'}};}});
 assert.equal(calls,1);assert.equal(r.more,true);assert.equal((await s.checkpoints.read()).sources['x-bookmarks:12345'].next_token,'page2');
});
test('Paid X single-post lookup updates content without inventing a new capture',async t=>{
 const {lookupXPost}=await import('../src/adapters/pull.mjs');const s=await setup(t);const [r]=await s.capture({input:'https://x.com/a/status/123456',note:'my note'});
 await lookupXPost(s,r.id,{token:'fake',api:async()=>({data:{id:'123456',text:'Full post text',author_id:'1'},includes:{users:[{id:'1',name:'A',username:'a'}]}})});
 const it=s.get(r.id);assert.equal(it.source_text,'Full post text');assert.equal(it.captures.length,1);assert.equal(it.captures[0].note,'my note');
});
test('X bookmark re-import respects a manually edited title',async t=>{
 const s=await setup(t);const [r]=await s.capture({input:'https://x.com/a/status/12345'});await s.update(r.id,{title:'My own title'});
 await importXPage(s,{data:[{id:'12345',text:'New API content'}]});assert.equal(s.get(r.id).title,'My own title');assert.equal(s.get(r.id).source_text,'New API content');
});
