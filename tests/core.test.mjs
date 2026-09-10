import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, encodeItem, decodeItem, initStore, validateStore, migrateStore, migrateV1Store, memoText } from '../src/store/index.mjs';
import { normalizeURL, extractCapture } from '../src/core/urls.mjs';
import { MemoService } from '../src/core/service.mjs';
import { parseMetadata, robotsAllowed, enrichItem, aiAnnotate, fetchMetadata } from '../src/core/metadata.mjs';
import { isPublicIP, requestBytes, apiJSON } from '../src/core/net.mjs';
import { withFileLock } from '../src/core/util.mjs';
import { ConnectorState } from '../src/core/connector-state.mjs';
import { fetchXOEmbed, parseXOEmbed, enrichXItem, X_OEMBED_ENDPOINT } from '../src/enrichment/x-oembed.mjs';

const exec = promisify(execFile);

async function store(t) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'neo-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return initStore(root);}
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1kAAAAASUVORK5CYII=','base64');
test('X URLs collapse by post ID, including i/web/status',()=>{
 for(const u of ['https://x.com/name/status/123456789?s=20','https://twitter.com/other/status/123456789/photo/1','https://mobile.twitter.com/a/status/123456789','https://x.com/i/web/status/123456789'])assert.equal(normalizeURL(u).key,'x:123456789');
});
test('X oEmbed accepts x.com and twitter.com status URLs and rejects non-status URLs',async()=>{
 const seen=[];const transport=async url=>{seen.push(new URL(url));return {status:200,headers:{},buffer:Buffer.from(JSON.stringify({author_name:'Ada',html:'<blockquote><p>Useful post</p></blockquote><script src="x"></script>'}))};};
 for(const url of ['https://x.com/ada/status/12345','https://twitter.com/ada/status/12345']){const result=await fetchXOEmbed(url,{transport});assert.equal(result.externalId,'12345');assert.equal(result.sourceText,'Useful post');}
 assert.ok(seen.every(url=>url.origin+url.pathname===X_OEMBED_ENDPOINT&&url.searchParams.get('omit_script')==='true'));
 await assert.rejects(fetchXOEmbed('https://x.com/ada',{transport}),/status URL/);
});
test('X oEmbed extracts text and author without storing markup in user content',async()=>{
 const parsed=parseXOEmbed({author_name:'Ada Lovelace',html:'<blockquote class="twitter-tweet"><p>Hello &amp; welcome<br>Line 2 <a href="https://t.co/x">link</a><script>bad()</script></p>&mdash; Ada</blockquote><script src="embed.js"></script>'});
 assert.equal(parsed.sourceText,'Hello & welcome\nLine 2 link');assert.equal(parsed.creator,'Ada Lovelace');assert.ok(!/[<>]|bad\(\)/.test(parsed.sourceText));
 const item={schema:3,id:'x-oembed-item',type:'x',title:'',memoEntries:[{id:'memo-entry-one',content:'my canonical memo',createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z'}],source:{kind:'x',url:'https://x.com/ada/status/12345',externalId:'12345'},summary:'',tags:[],assets:[],createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',captures:[],ai_tags:[],archived:false,enrichment:{status:'pending',attempts:0}};
 const enriched=await enrichXItem(item,{transport:async()=>({status:200,headers:{},buffer:Buffer.from(JSON.stringify({author_name:'Ada',html:'<blockquote><p>Source text</p></blockquote>'}))})});assert.equal(memoText(enriched),'my canonical memo');assert.deepEqual(enriched.memoEntries,item.memoEntries);assert.equal(enriched.source.creator,'Ada');assert.equal(enriched.source_text,'Source text');assert.equal(enriched.description,'Source text');assert.equal(enriched.enrichment.adapter,'x-oembed');
});
test('X oEmbed failure preserves capture and can be retried later without paid API',async t=>{
 const s=await store(t),calls=[];const service=await new MemoService(s.root,{xOEmbedTransport:async url=>{calls.push(url);throw new Error('offline');},adapterOptions:{api:async()=>{throw new Error('paid X API must not run');}}}).init();
 const [saved]=await service.capture({input:'https://twitter.com/ada/status/555 この見せ方よさそう',source:'slack:C1',event_id:'m1'});let item=await service.enrich(saved.id);assert.equal(item.enrichment.status,'failed');assert.equal(item.captures[0].note,'この見せ方よさそう');assert.deepEqual(item.memoEntries,[]);assert.equal(calls.length,1);
 service.options.xOEmbedTransport=async()=>({status:200,headers:{},buffer:Buffer.from(JSON.stringify({author_name:'Ada',html:'<blockquote><p>Later online</p></blockquote>'}))});const [retry]=await service.enrichPendingX();assert.equal(retry.status,'ready');item=await service.get(saved.id);assert.equal(item.source_text,'Later online');assert.equal(item.captures[0].note,'この見せ方よさそう');
});
test('Only known tracking parameters removed; semantic query and fragments retained',()=>{
 assert.equal(normalizeURL('https://example.com/a?utm_source=x&id=2&ref=method#part').url,'https://example.com/a?id=2&ref=method#part');
 assert.notEqual(normalizeURL('https://example.com/?id=1').key,normalizeURL('https://example.com/?id=2').key);
 assert.throws(()=>normalizeURL('file:///etc/passwd')); assert.throws(()=>normalizeURL('https://me:secret@example.com/'));
});
test('Slack formatting, multiple URLs, full-width punctuation and balanced parentheses',()=>{
 const r=extractCapture('<https://example.com/a|Title> いいね\nhttps://example.com/f_(x)。');
 assert.equal(r.urls.length,2);assert.equal(r.urls[1].url,'https://example.com/f_(x)');assert.match(r.note,/いいね/);
});
test('Duplicate card accumulates provenance; replay is idempotent',async t=>{
 const s=await store(t);
 const a=await s.capture({input:'https://x.com/a/status/12345 配色の参考',source:'slack:C12345',event_id:'1'});
 await s.capture({input:'https://twitter.com/b/status/12345 形の参考',source:'discord:12345',event_id:'2'});
 await s.capture({input:'https://x.com/a/status/12345 配色の参考',source:'slack:C12345',event_id:'1'});
 assert.equal(s.items.size,1);assert.equal(s.get(a[0].id).captures.length,2);
});
test('Offline note without URL and Japanese search survive reload',async t=>{
 const s=await store(t);const [r]=await s.capture({input:'水面を照らす色について考える',source:'cli'});
 await s.update(r.id,{content:'触覚にも応用できるか。',tags:['光学']});await s.reload();
 assert.equal(s.list({query:'水面 触覚'})[0].id,r.id);assert.equal(s.list({query:'光学'}).length,1);
});
test('Quick Note stores URL-free user text as its first canonical memo entry',async t=>{
 const s=await store(t),item=await s.createNote('思いついた内容');assert.equal(item.type,'note');assert.equal(item.memoEntries.length,1);assert.equal(memoText(item),'思いついた内容');assert.equal(item.source,undefined);assert.equal(memoText(s.get(item.id)),'思いついた内容');
});
test('Reading Note requires a book and accepts optional/free-form locator',async t=>{
 const s=await store(t);await assert.rejects(s.createReadingNote({content:'memo'}),/book/i);
 const without=await s.createReadingNote({book:'The Design of Everyday Things',content:'制約について'});assert.equal(without.source.locator,undefined);
 const withLocator=await s.createReadingNote({book:'The Design of Everyday Things',creator:'Don Norman',location:'Kindle 1832 / §4.2',content:'物理的制約そのものより...'});
 assert.equal(withLocator.source.kind,'book');assert.equal(withLocator.source.locator,'Kindle 1832 / §4.2');assert.equal(withLocator.title,'');
});
test('Book title search returns multiple notes from the same book',async t=>{
 const s=await store(t);await s.createReadingNote({book:'Designing Interfaces',location:'p.10',content:'one'});await s.createReadingNote({book:'Designing Interfaces',content:'two'});await s.createReadingNote({book:'Other Book',content:'three'});
 const found=s.list({query:'Designing Interfaces'});assert.equal(found.length,2);assert.ok(found.every(item=>item.source.title==='Designing Interfaces'));
});
test('Memo entries append in order, retain stable IDs, edit independently, and all remain searchable',async t=>{
 const s=await store(t),item=await s.createNote('最初の文章'),first=item.memoEntries[0];
 await s.appendMemoEntry(item.id,'二回目の追記');let current=s.get(item.id);assert.equal(current.memoEntries.length,2);assert.equal(current.memoEntries[0].id,first.id);assert.equal(current.memoEntries[0].createdAt,first.createdAt);const second=current.memoEntries[1];
 await s.updateMemoEntry(item.id,first.id,'修正した最初の文章');current=s.get(item.id);assert.equal(current.memoEntries[0].id,first.id);assert.equal(current.memoEntries[1].id,second.id);assert.equal(current.memoEntries[1].content,'二回目の追記');assert.equal(s.list({query:'修正した'}).length,1);assert.equal(s.list({query:'二回目'}).length,1);
 await assert.rejects(s.update(item.id,{content:'old client overwrite'}),/cannot overwrite multiple memo entries/);assert.equal(s.get(item.id).memoEntries.length,2);
});
test('Markdown round trip preserves arbitrary body including YAML-like separators',async t=>{
 const s=await store(t);const [r]=await s.capture({input:'hello'});const it=s.get(r.id);it.memoEntries[0].content='## Notes\n\n---\nnot metadata\n<script>alert(1)</script>';
 assert.deepEqual(decodeItem(encodeItem(it)),it);
});
test('Corrupt metadata is not silently discarded',()=>{assert.throws(()=>decodeItem('---\n{bad\n---\nbody'));});
test('Manual tags and notes survive AI re-annotation',async t=>{
 const s=await store(t);const [r]=await s.capture({input:'https://example.com',note:'private reason'});
 await s.update(r.id,{content:'secret draft',tags:['必読']});let request;
 const api=async(_url,o)=>{request=o.body;return {status:'completed',output:[{content:[{type:'output_text',text:'{"summary":"説明は短い。","tags":["形状"]}'}]}]};};
 await aiAnnotate(s,r.id,{key:'fake',model:'test-model',api});
 const it=s.get(r.id);assert.deepEqual(it.tags,['必読']);assert.equal(memoText(it),'secret draft');assert.deepEqual(it.ai_tags,['形状']);assert.equal(request.store,false);assert.ok(!request.input.includes('secret draft'));assert.ok(!request.input.includes('private reason'));
});
test('Incomplete AI response leaves stored content unchanged',async t=>{
 const s=await store(t);const [r]=await s.capture({input:'https://incomplete-ai.example/a'});await assert.rejects(aiAnnotate(s,r.id,{key:'fake',model:'m',api:async()=>({status:'incomplete',output:[]})}));assert.equal(s.get(r.id).summary,'');
});
test('Content-addressed image store deduplicates and rejects SVG',async t=>{
 const s=await store(t);const a=await s.saveAsset(PNG),b=await s.saveAsset(PNG);assert.equal(a,b);await assert.rejects(s.saveAsset(Buffer.from('<svg onload="alert(1)"></svg>')));
});
test('Store can be initialized at any absolute path and validates its schema',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'anywhere-'));const root=path.join(parent,'unrelated','data-store');t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const s=await initStore(root), meta=await validateStore(root);assert.equal(s.root,path.resolve(root));assert.equal(meta.format,'neo-memo-store');assert.equal(meta.schemaVersion,3);assert.match(meta.storeId,/^[0-9a-f-]{36}$/i);
 await fs.writeFile(path.join(root,'neo-memo-store.json'),JSON.stringify({...meta,schemaVersion:999}));await assert.rejects(validateStore(root),/Unsupported/);
});
test('Store rejects missing or invalid marker instead of creating data implicitly',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'not-a-store-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await assert.rejects(new Store(root).init(),/Not a Neo Memo Store/);
 await fs.writeFile(path.join(root,'neo-memo-store.json'),'{}');await assert.rejects(validateStore(root),/format/);
});
test('CLI --store takes priority over NEO_MEMO_STORE and missing Store is explicit',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'cli-store-')), selected=path.join(parent,'selected'), envStore=path.join(parent,'environment');t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const cli=path.resolve('bin/neo-memo.mjs');
 await exec(process.execPath,[cli,'init','store','--store',selected],{env:{...process.env,NEO_MEMO_STORE:envStore}});
 const {stdout}=await exec(process.execPath,[cli,'status','--store',selected],{env:{...process.env,NEO_MEMO_STORE:envStore}});assert.equal(JSON.parse(stdout).root,path.resolve(selected));await assert.rejects(fs.access(envStore));
 await assert.rejects(exec(process.execPath,[cli,'list'],{env:{...process.env,NEO_MEMO_STORE:''}}),/Store is not set/);
});
test('CLI add-note and add-reading-note write the generalized model',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cli-notes-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const cli=path.resolve('bin/neo-memo.mjs');await exec(process.execPath,[cli,'init','store','--store',root]);
 const quick=JSON.parse((await exec(process.execPath,[cli,'add-note','思いついた内容','--store',root])).stdout);assert.equal(quick.type,'note');assert.equal(quick.memoEntries[0].content,'思いついた内容');
 await assert.rejects(exec(process.execPath,[cli,'add-reading-note','memo','--store',root]),/book/i);
 const reading=JSON.parse((await exec(process.execPath,[cli,'add-reading-note','--book','The Design of Everyday Things','--location','pp.142-145','--creator','Don Norman','物理的制約','--store',root])).stdout);assert.equal(reading.source.title,'The Design of Everyday Things');assert.equal(reading.source.locator,'pp.142-145');assert.equal(reading.memoEntries[0].content,'物理的制約');
 const appended=JSON.parse((await exec(process.execPath,[cli,'note',reading.id,'追記内容','--store',root])).stdout);assert.equal(appended.memoEntries.length,2);assert.equal(appended.memoEntries[1].content,'追記内容');
});
test('Item IDs are URL-independent and remain immutable after edits',async t=>{
 const s=await store(t);const [created]=await s.capture({input:'https://example.com/immutable'});const before=s.get(created.id);
 assert.match(before.id,/^[0-9A-HJKMNP-TV-Z]{26}$/);await s.update(before.id,{title:'Changed title',memo:'Changed memo'});assert.equal(s.get(before.id).id,before.id);
 await s.capture({input:'https://example.com/immutable',note:'duplicate'});assert.equal(s.list().length,1);assert.equal(s.list()[0].id,before.id);
});
test('Asset identifiers resolve without exposing a Store-relative path',async t=>{
 const s=await store(t);const id=await s.saveAsset(PNG);assert.match(id,/^sha256:[a-f0-9]{64}$/);const resolved=await s.resolveAsset(id);assert.match(resolved,/assets[\\/][a-f0-9]{2}[\\/][a-f0-9]{64}\.png$/);
});
test('v1 data migrates in place while preserving items, IDs, and assets',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-store-')),cache=`${root}-cache`;t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(cache,{recursive:true,force:true})]));
 await fs.mkdir(path.join(root,'items'),{recursive:true});await fs.mkdir(path.join(root,'assets','aa'),{recursive:true});await fs.mkdir(path.join(root,'state'),{recursive:true});
 const legacyId='legacy-item-0001', digest='a'.repeat(64), legacy={schema:1,id:legacyId,key:'url:https://example.com',url:'https://example.com',original_url:'https://example.com',external_id:'article-42',type:'web',title:'Legacy',description:'',summary:'',summary_basis:'',author:'Author',saved_at:'2020-01-01T00:00:00.000Z',updated_at:'2020-01-02T00:00:00.000Z',tags:['kept'],ai_tags:[],captures:[{source:'slack:C1',event_id:'e1',at:'2020-01-01T00:00:00.000Z',note:'why',source_url:''}],preview:`assets/aa/${digest}.png`,preview_url:'',archived:false,enrichment:{status:'ready',attempts:0},memo:'user memo'};
 const legacyCheckpoint={schema:1,sources:{'slack:C12345':{high:'42.0'}}};await fs.writeFile(path.join(root,'neo-memo.json'),JSON.stringify({schema:1}));await fs.writeFile(path.join(root,'state','sources.json'),JSON.stringify(legacyCheckpoint));await fs.writeFile(path.join(root,'items',`${legacyId}.md`),encodeItem(legacy));await fs.writeFile(path.join(root,'assets','aa',`${digest}.png`),PNG);
 const checkpoints=new ConnectorState(cache),s=await migrateV1Store(root,{checkpoints}),item=s.get(legacyId);assert.equal(item.id,legacyId);assert.equal(item.schema,3);assert.equal(memoText(item),'user memo');assert.equal(item.memoEntries[0].createdAt,'2020-01-01T00:00:00.000Z');assert.equal(item.source.url,'https://example.com');assert.equal(item.source.externalId,'article-42');assert.equal(item.source.creator,'Author');assert.equal(item.createdAt,'2020-01-01T00:00:00.000Z');assert.equal(item.updatedAt,'2020-01-02T00:00:00.000Z');assert.equal(item.captures[0].note,'why');assert.deepEqual(item.tags,['kept']);assert.deepEqual(item.assets,[`sha256:${digest}`]);assert.equal(item.preview,`sha256:${digest}`);assert.equal(await s.resolveAsset(`sha256:${digest}`),path.join(root,'assets','aa',`${digest}.png`));assert.deepEqual(await checkpoints.read(),legacyCheckpoint);await assert.rejects(fs.access(path.join(root,'state')));
});
test('schema v1 marker migrates explicitly without changing storeId or item ID',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'marker-v1-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'items'),{recursive:true});await fs.mkdir(path.join(root,'assets'));const storeId='11111111-1111-4111-8111-111111111111',id='legacy-marker-item';await fs.writeFile(path.join(root,'neo-memo-store.json'),JSON.stringify({format:'neo-memo-store',schemaVersion:1,storeId}));await fs.writeFile(path.join(root,'items',`${id}.md`),encodeItem({schema:1,id,key:'note:old',url:'',original_url:'',type:'memo',title:'old',saved_at:'2020-01-01T00:00:00.000Z',updated_at:'2020-01-01T00:00:00.000Z',tags:[],ai_tags:[],captures:[{source:'cli',event_id:'1',at:'2020-01-01T00:00:00.000Z',note:'original',source_url:''}],memo:'edited',preview:'',archived:false}));
 await assert.rejects(new Store(root).init(),/Unsupported/);const s=await migrateV1Store(root);assert.equal((await validateStore(root)).storeId,storeId);assert.equal(s.get(id).id,id);assert.equal(memoText(s.get(id)),'edited');
});
test('schema v2 migrates content to one memo entry without changing item identity or related data',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'marker-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'items'),{recursive:true});await fs.mkdir(path.join(root,'assets'));const storeId='22222222-2222-4222-8222-222222222222',id='schema-v2-item',stamp='2022-02-02T02:02:02.000Z';
 await fs.writeFile(path.join(root,'neo-memo-store.json'),JSON.stringify({format:'neo-memo-store',schemaVersion:2,storeId}));await fs.writeFile(path.join(root,'items',`${id}.md`),encodeItem({schema:2,id,type:'reading_note',title:'',content:'既存本文',source:{kind:'book',title:'Existing Book'},summary:'summary',tags:['kept'],assets:[],createdAt:stamp,updatedAt:stamp,captures:[{source:'manual',event_id:'e',at:stamp,note:'why',source_url:''}],ai_tags:[],archived:false}));
 await assert.rejects(new Store(root).init(),/Unsupported/);const s=await migrateStore(root),item=s.get(id);assert.equal((await validateStore(root)).schemaVersion,3);assert.equal(item.id,id);assert.equal(item.memoEntries.length,1);assert.equal(item.memoEntries[0].content,'既存本文');assert.equal(item.memoEntries[0].createdAt,stamp);assert.equal(item.source.title,'Existing Book');assert.equal(item.captures[0].note,'why');assert.deepEqual(item.tags,['kept']);assert.match(await fs.readFile(path.join(root,'README.md'),'utf8'),/memoEntries/);
});
test('Metadata parser is passive, decodes attributes, resolves image and ignores scripts',()=>{
 const r=parseMetadata('<head><script>"<meta property=\"og:title\" content=\"evil\">"</script><title>Fallback</title><meta property="og:title" content="A &amp; B"><meta name=description content="line &#x65e5;"><meta property="og:image" content="/a.png"></head>','https://example.com/p');
 assert.equal(r.title,'A & B');assert.equal(r.description,'line 日');assert.equal(r.preview_url,'https://example.com/a.png');
});
test('robots respects named agent, longest match, wildcard and allow on ties',()=>{
 assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/open','/private/a'),false);
 assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/open','/private/open/a'),true);
 assert.equal(robotsAllowed('User-agent: *\nDisallow: /\nUser-agent: NeoMemo\nAllow: /','/a'),true);
 assert.equal(robotsAllowed('User-agent: *\nDisallow: /*.pdf$','/a.pdf'),false);
});
test('Metadata networking failure preserves URL and note with retryable status',async t=>{
 const s=await store(t);const [r]=await s.capture({input:'https://offline.example.org/a',note:'save this first'});
 const it=await enrichItem(s,r.id,{fetcher:async()=>{throw new Error('offline');}});
 assert.equal(it.enrichment.status,'failed');assert.equal(it.captures[0].note,'save this first');assert.equal(it.url,'https://offline.example.org/a');
});
test('Metadata follows redirects only after checking target robots',async()=>{
 const seen=[];const fetcher=async(url)=>{seen.push(url);if(url.endsWith('robots.txt'))return {status:200,headers:{},buffer:Buffer.from('User-agent: *\nAllow: /')};if(url==='https://redirect-tests.example/a')return {status:301,headers:{location:'https://target-tests.example/b'},buffer:Buffer.alloc(0)};return {status:200,headers:{'content-type':'text/html'},buffer:Buffer.from('<title>Target</title>'),url};};
 const r=await fetchMetadata('https://redirect-tests.example/a',fetcher);assert.equal(r.title,'Target');assert.ok(seen.indexOf('https://target-tests.example/robots.txt')<seen.indexOf('https://target-tests.example/b'));
});
test('Local/private IPs and credentialed URLs cannot be fetched',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(isPublicIP(ip),false,ip);
 assert.equal(isPublicIP('8.8.8.8'),true);
 await assert.rejects(requestBytes('http://127.0.0.1/'));await assert.rejects(requestBytes('https://user:pass@example.com/'));
});
test('429 is reported without losing control or waiting minutes',async()=>{
 await assert.rejects(apiJSON('https://api.example/',{transport:async()=>({status:429,headers:{'retry-after':'60'},buffer:Buffer.from('{}')})}),e=>e.retryAfter===60);
});
test('New Store initialization refuses existing files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'neo-nonempty-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'important.txt'),'x');await assert.rejects(initStore(root));
});
test('Symlinked cards are rejected',async t=>{
 if(process.platform==='win32')return t.skip('requires symlink privilege');
 const s=await store(t);await fs.symlink('/etc/passwd',path.join(s.root,'items','aaaaaa.md'));await assert.rejects(s.reload(),/シンボリック/);
});
test('Local service commits captured notes, exports and starts from saved data',async t=>{
 const s=await store(t);const service=await new MemoService(s.root).init();const [r]=await service.capture({input:'https://example.com 構造の参考'});
 const status=await service.status();assert.ok(status.git.head);assert.equal(status.git.dirty,false);assert.equal(status.gitWarning,'');
 const second=await new MemoService(s.root).init();assert.equal((await second.exportJSON()).items[0].id,r.id);
});
test('Cache is independent from Store and can be deleted before reopening',async t=>{
 const s=await store(t);const cache=path.join(os.tmpdir(),`neo-cache-test-${Date.now()}`);t.after(()=>fs.rm(cache,{recursive:true,force:true}));
 const service=await new MemoService(s.root,{cachePath:cache}).init();await service.capture({input:'cache independent'});assert.ok(await fs.stat(cache));
 await fs.rm(cache,{recursive:true,force:true});const reopened=await new MemoService(s.root,{cachePath:cache}).init();assert.equal((await reopened.list()).length,1);assert.notEqual(reopened.cacheRoot,reopened.root);
});
test('App working directory and Store can be unrelated absolute locations',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'separate-layout-')),appPath=path.join(parent,'application','checkout'),storePath=path.join(parent,'mounted','personal-store'),cachePath=path.join(parent,'runtime','cache');t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 await fs.mkdir(appPath,{recursive:true});const service=await new MemoService(storePath,{cachePath}).initStore();const [created]=await service.capture({input:'https://example.com/separate',note:'canonical provenance'});assert.equal((await service.get(created.id)).captures[0].note,'canonical provenance');assert.ok(!path.relative(appPath,storePath).startsWith('data'));assert.deepEqual((await fs.readdir(storePath)).filter(name=>['neo-memo-store.json','items','assets'].includes(name)).sort(),['assets','items','neo-memo-store.json']);
});
test('Writer lock serializes two independent service processes/instances',async t=>{
 const s=await store(t),a=await new MemoService(s.root).init(),b=await new MemoService(s.root).init();
 await Promise.all([a.capture({input:'https://example.com/a',note:'one'}),b.capture({input:'https://example.com/a',note:'two'})]);
 const items=await a.list();assert.equal(items.length,1);assert.equal(items[0].captures.length,2);
});
test('Capture stays available while an importer is waiting on the network',async t=>{
 const s=await store(t);let release,started;
 const signal=new Promise(r=>started=r),waiting=new Promise(r=>release=r);
 const service=await new MemoService(s.root,{adapterOptions:{delay:0,api:async()=>{started();await waiting;return {ok:true,messages:[],response_metadata:{}};}}}).init();
 const pulling=service.pull({slack:{channels:['C12345']}},{slack:'fake'});await signal;
 const [saved]=await Promise.race([service.capture({input:'ネット待ち中にも保存'}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('capture blocked by network')),5000))]);
 assert.ok(saved.id);release();await pulling;
});
test('Metadata response cannot overwrite concurrent human edits',async t=>{
 const s=await store(t);let release,started;
 const signal=new Promise(r=>started=r),waiting=new Promise(r=>release=r);
 const fetcher=async(url)=>{if(url.endsWith('robots.txt'))return {status:200,headers:{},buffer:Buffer.from('User-agent: *\nAllow: /')};started();await waiting;return {status:200,headers:{'content-type':'text/html'},url,buffer:Buffer.from('<title>Original page title</title><meta name="description" content="remote description">')};};
 const service=await new MemoService(s.root,{fetcher}).init();const [r]=await service.capture({input:'https://concurrent-metadata.example/a'});
 const pending=service.enrich(r.id);await signal;await service.update(r.id,{title:'自分で付けた題',content:'編集中の文章',tags:['自分のタグ']});release();await pending;
 const it=await service.get(r.id);assert.equal(it.title,'自分で付けた題');assert.equal(memoText(it),'編集中の文章');assert.deepEqual(it.tags,['自分のタグ']);assert.equal(it.description,'remote description');
});
test('AI response cannot overwrite concurrent memo or manual tags',async t=>{
 const s=await store(t);let release,started;
 const signal=new Promise(r=>started=r),waiting=new Promise(r=>release=r);
 const service=await new MemoService(s.root,{aiOptions:{api:async()=>{started();await waiting;return {status:'completed',output:[{content:[{type:'output_text',text:'{"summary":"summary","tags":["AI tag"]}'}]}]};}}}).init();
 const [r]=await service.capture({input:'https://ai-concurrent.example/test'});const pending=service.ai(r.id,{ai:{model:'fake'}},{openai:'fake'});await signal;await service.update(r.id,{content:'new memo',tags:['human']});release();await pending;const it=await service.get(r.id);assert.equal(memoText(it),'new memo');assert.deepEqual(it.tags,['human']);assert.deepEqual(it.ai_tags,['AI tag']);
});
test('Pure private memo cannot be sent to AI without explicit notes consent',async t=>{
 const s=await store(t);const [r]=await s.capture({input:'private local thought'});let called=false;
 await assert.rejects(aiAnnotate(s,r.id,{key:'fake',model:'m',api:async()=>{called=true;}}),/メモ/);assert.equal(called,false);
});
test('X lookup sees a card saved by another local service after startup',async t=>{
 const s=await store(t);const a=await new MemoService(s.root,{adapterOptions:{api:async()=>({data:{id:'1234567',text:'Retrieved text'}})}}).init();
 const b=await new MemoService(s.root).init();const [r]=await b.capture({input:'https://x.com/a/status/1234567'});
 await a.lookupX(r.id,{x:'fake'});assert.equal((await a.get(r.id)).source_text,'Retrieved text');
});
