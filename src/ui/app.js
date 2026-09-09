'use strict';
const $ = id => document.getElementById(id);
const state = { type:'', archived:false, tag:'', query:'', items:[], current:null, busy:false, detailDirty:false, visibleLimit:120, savingCapture:false, images:new Map() };
let refreshTimer, toastTimer, settings;
function element(tag, cls, content) { const node = document.createElement(tag); if (cls) node.className = cls; if (content !== undefined) node.textContent = content; return node; }
function toast(message, error = false) { $('toast').textContent = message; $('toast').classList.remove('hidden'); $('toast').classList.toggle('error',error); clearTimeout(toastTimer); toastTimer = setTimeout(()=>$('toast').classList.add('hidden'),error ? 8000 : 3300); }
async function call(method,payload = {}) { if (!window.neo) throw new Error('デスクトップ版から開いてください。npm start で起動します。'); return window.neo.call(method,payload); }
async function action(fn) { try { return await fn(); } catch(e) { toast(e.message || String(e),true); return null; } }
function date(s) { try { return new Date(s).toLocaleDateString('ja-JP',{month:'2-digit',day:'2-digit'}); } catch { return ''; } }
function sourceLabel(type) { return ({web:'WEB',note:'NOTE',reading_note:'READING',x:'X',other:'OTHER'})[type] || type.toUpperCase(); }
function kindName(type) { return ({web:'Web',note:'Quick Note',reading_note:'Reading Note',x:'X',other:'その他'})[type] || 'すべてのストック'; }
function domain(it) { try { return new URL(it.original_url || it.url).hostname.replace(/^www\./,''); } catch { return 'just a thought'; } }
const imageObserver = new IntersectionObserver(entries=>{
  for (const e of entries) if (e.isIntersecting) {
    imageObserver.unobserve(e.target); const img=e.target;
    action(async()=>{ const data = state.images.get(img.dataset.id) || await call('asset',{id:img.dataset.id}); if (data) { state.images.set(img.dataset.id,data); img.src=data; } });
  }
},{rootMargin:'300px'});
function renderCards() {
  imageObserver.disconnect(); $('cards').replaceChildren();
  $('empty').classList.toggle('hidden',state.items.length > 0);
  $('resultCount').textContent = state.items.length;
  const title = state.query ? '検索結果' : state.archived ? 'アーカイブ' : state.tag ? `#${state.tag}` : kindName(state.type);
  $('pageTitle').firstChild.textContent = title;
  $('subtitle').textContent = state.query ? `「${state.query}」に一致するストック` : '気になったものを、整理せずに置いておく。';
  $('loadMore').classList.toggle('hidden',state.items.length<=state.visibleLimit);
  for (const it of state.items.slice(0,state.visibleLimit)) {
    const card=element('article','card'); card.tabIndex=0; card.dataset.id=it.id;
    card.addEventListener('click',()=>action(()=>openDetail(it.id)));
    card.addEventListener('keydown',e=>{if(e.key==='Enter') action(()=>openDetail(it.id));});
    if(it.preview) { const img=element('img','card-image'); img.alt='保存したプレビュー'; img.dataset.id=it.id; card.append(img); imageObserver.observe(img); }
    else { const ph=element('div',`card-placeholder ${it.type}`); ph.append(element('span','source-initial',({note:'“',reading_note:'§',x:'𝕏'})[it.type] || '↗'),element('span','source-domain',it.type==='reading_note' ? 'book note' : domain(it))); card.append(ph); }
    const body=element('div','card-body'), meta=element('div','card-meta');
    meta.append(element('span','source-badge',sourceLabel(it.type)),element('span','',it.source?.locator || domain(it)),element('time','',date(it.createdAt || it.saved_at)));
    body.append(meta,element('h2','',it.source?.title || it.title || (it.content || '').slice(0,90)));
    if(it.type==='reading_note' && it.title) body.append(element('p','card-description',it.title));
    const desc=it.content || it.summary || it.description || 'URLとメモを保存済み。情報はあとから補完できます。';
    if(desc) body.append(element('p','card-description',desc));
    const tags=element('div','tags');
    for(const tag of [...new Set([...it.tags,...(it.ai_tags||[])])].slice(0,4)) tags.append(element('span','tag',`# ${tag}`));
    if(tags.childElementCount) body.append(tags);
    const reason=it.captures.filter(c=>c.note).at(-1)?.note;
    if(reason) { const r=element('div','reason');r.append(element('strong','', 'WHY'),element('span','',reason));body.append(r); }
    const tail=element('div','card-tail');
    tail.append(element('span','',it.captures[0]?.source.split(':')[0] || 'local'),element('span',it.enrichment?.status==='ready' ? '' : 'pending',it.enrichment?.status==='ready' ? 'saved locally' : it.type==='x' ? 'URLを保存済み' : '補完待ち'));
    body.append(tail);card.append(body);$('cards').append(card);
  }
}
async function refresh() {
  const items=await call('list',{query:state.query,type:state.type,tag:state.tag,archived:state.archived}); state.items=items;renderCards();
  const status=await call('status');$('totalCount').textContent=status.count;
  $('footerStatus').textContent=status.git?.head ? `ローカル保存済み · git ${status.git.head}${status.git.dirty ? ' · 未コミットの変更あり' : ''}` : 'ローカルファイルに保存';
  const warnings=[status.gitWarning ? `ファイル保存とGit保存は別です。${status.gitWarning}` : '',status.importWarnings || ''].filter(Boolean).join('\n');
  $('warning').classList.toggle('hidden',!warnings);$('warning').textContent=warnings;
  const tags=[...new Set(items.flatMap(i=>[...i.tags,...(i.ai_tags||[])]))].slice(0,12);$('tagList').replaceChildren();
  for(const t of tags) {const b=element('button','',`# ${t}`);b.onclick=()=>{state.tag=state.tag===t?'':t;action(refresh);};$('tagList').append(b);}
}
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>action(refresh),130);}
function updateCaptureKind(){const kind=$('captureKind').value,reading=kind==='reading_note';$('readingFields').classList.toggle('hidden',!reading);$('captureNoteFields').classList.toggle('hidden',kind!=='capture');$('captureInputLabel').textContent=reading?'Memo *':kind==='note'?'Memo *':'URL';$('captureInput').placeholder=reading?'本から得た気づきや自分の考え':kind==='note'?'思いついた内容':'https://…';}
function openCapture(){ const books=[...new Set(state.items.filter(i=>i.type==='reading_note').map(i=>i.source?.title).filter(Boolean))];$('recentBooks').replaceChildren(...books.slice(0,20).map(x=>{const o=document.createElement('option');o.value=x;return o;}));updateCaptureKind();$('captureDialog').showModal();setTimeout(()=>$('captureInput').focus(),50); }
async function saveCapture(){
  if(state.savingCapture)return;
  const input=$('captureInput').value,note=$('captureNote').value,kind=$('captureKind').value;if(!input.trim())return;if(kind==='reading_note'&&!$('captureBook').value.trim())throw new Error('Bookは必須です。');
  state.savingCapture=true;const button=$('captureForm').querySelector('button[type=submit]');button.disabled=true;
  try{const results=await call('capture',{kind,input,note,content:input,book:$('captureBook').value,creator:$('captureCreator').value,location:$('captureLocation').value});$('captureInput').value='';$('captureNote').value='';$('captureBook').value='';$('captureCreator').value='';$('captureLocation').value='';$('captureDialog').close();const added=results.filter(r=>r.status==='created').length;toast(added?`${added}件をローカル保存しました。`:'保存済みのカードにメモを追記しました。');await refresh();}
  finally{state.savingCapture=false;button.disabled=false;}
}
async function openDetail(id){
  const it=await call('get',{id});state.current=it;state.detailDirty=false;
  $('detailType').textContent=sourceLabel(it.type);$('detailMeta').textContent=`${it.source?.title || domain(it)}${it.source?.locator ? ` · ${it.source.locator}` : ''} · ${new Date(it.createdAt || it.saved_at).toLocaleString('ja-JP')} · ${it.source?.creator || it.author || ''}`;
  $('detailTitle').value=it.title || '';$('detailMemo').value=it.content || '';$('detailTags').value=it.tags.join(', ');
  $('originalButton').classList.toggle('hidden',!it.url);
  $('detailSummary').textContent=it.summary || it.description || '説明はまだありません。自分のメモだけでも保存・検索できます。';
  $('summaryLabel').textContent=it.summary ? ({metadata_only:'AI説明（メタデータのみから生成）',source_text:'AI要約（取得済み投稿本文から生成）',metadata_and_notes:'AI整理（ページ情報＋自分のメモ）',user_notes:'AI整理（自分のメモ）'}[it.summary_basis] || 'AI説明') : 'ページ／投稿の説明';
  $('detailError').textContent=[it.enrichment?.error,it.preview_error].filter(Boolean).join('\n');
  $('captureHistory').replaceChildren();
  for(const cap of it.captures){const div=element('div','capture-entry',cap.note || '（メモなし）');div.append(element('small','',`${new Date(cap.at).toLocaleString('ja-JP')} · ${cap.source}`));$('captureHistory').append(div);}
  $('detailAITags').replaceChildren();for(const tag of it.ai_tags || []) $('detailAITags').append(element('span','tag ai-tag',`AI · ${tag}`));
  $('detailSaveStatus').textContent='変更は「保存」で確定';$('archiveButton').textContent=it.archived?'一覧に戻す':'アーカイブ';
  $('detailX').classList.toggle('hidden',it.type!=='x');
  $('detailEnrich').textContent=it.type==='x' ? '取得済み画像を保存' : '情報を補完';$('detailEnrich').disabled=['note','reading_note'].includes(it.type) || it.type==='x' && !it.preview_url;
  $('detailImage').classList.add('hidden');if(it.preview){const img=await call('asset',{id});if(img){$('detailImage').src=img;$('detailImage').classList.remove('hidden');}}
  if(!$('detailDialog').open)$('detailDialog').showModal();
}
async function saveDetail(){if(!state.current)return;const it=await call('update',{id:state.current.id,patch:{title:$('detailTitle').value,content:$('detailMemo').value,tags:$('detailTags').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean)}});state.current=it;state.detailDirty=false;$('detailSaveStatus').textContent='ローカルに保存しました';toast('変更を保存しました。');await refresh();}
async function detailAction(fn){ if(state.detailDirty) await saveDetail(); const id=state.current.id;await fn(id);state.images.delete(id);await openDetail(id);await refresh(); }
function closeDialog(id){if(id==='detailDialog' && state.detailDirty && !confirm('未保存の変更を破棄して閉じますか？'))return;$(id).close();}
async function openSettings(){
  settings=await call('settings');$('repoPath').textContent=settings.root;
  for(const kind of ['slack','discord']){ $(`${kind}Channels`).value=(settings[kind]?.channels || []).join(', ');$(`${kind}User`).value=settings[kind]?.user || ''; }
  $('xUserId').value=settings.x?.userId || '';$('aiModel').value=settings.ai?.model || '';$('includeNotes').checked=Boolean(settings.ai?.includeNotes);$('autoPull').checked=Boolean(settings.autoPull);$('autoMetadata').checked=Boolean(settings.autoMetadata);$('autoAI').checked=Boolean(settings.autoAI);
  for(const k of ['slack','discord','x','openai']){ $(`${k}Token`).value='';$(`${k}Token`).placeholder=settings.secrets[k]?'設定済み（変更するときだけ入力）':'未設定'; }
  $('secretStatus').textContent=settings.secureStorage?'APIキーはOSの暗号化機構で保存。Gitには入りません。':'OSの安全な鍵保存が利用できません。APIキーは環境変数から渡してください。';
  if(!$('settingsDialog').open)$('settingsDialog').showModal();
}
async function saveSettings(){
  const payload={slack:{channels:$('slackChannels').value.split(/[\s,，]+/).filter(Boolean),user:$('slackUser').value.trim()},discord:{channels:$('discordChannels').value.split(/[\s,，]+/).filter(Boolean),user:$('discordUser').value.trim()},x:{userId:$('xUserId').value.trim()},ai:{model:$('aiModel').value.trim(),includeNotes:$('includeNotes').checked},autoPull:$('autoPull').checked,autoMetadata:$('autoMetadata').checked,autoAI:$('autoAI').checked,secrets:{}};
  for(const k of ['slack','discord','x','openai'])payload.secrets[k]=$(`${k}Token`).value.trim();
  settings=await call('saveSettings',payload);await openSettings();toast('設定を保存しました。');
}
async function pull(){ if(state.busy)return;state.busy=true;$('pullButton').disabled=true;$('pullButton').textContent='取り込み中…';try{const result=await call('pull');const errors=result.filter(r=>r.error);const more=result.some(r=>r.more);toast(!result.length?'設定画面でSlack / Discordの連携先を追加してください。':errors.length?errors.map(r=>`${r.source}: ${r.error}`).join('\n'):`取り込み完了。${result.reduce((n,r)=>n+(r.count||0),0)}件を追加・更新。${more?' 続きがあります。もう一度取り込んでください。':''}`,Boolean(errors.length));await refresh();}finally{state.busy=false;$('pullButton').disabled=false;$('pullButton').textContent='↓ 取り込む';}}
$('addButton').onclick=$('emptyAdd').onclick=openCapture;
$('captureForm').onsubmit=e=>{e.preventDefault();action(saveCapture);};
$('captureKind').onchange=updateCaptureKind;
$('captureInput').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();action(saveCapture);}});
$('captureNote').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();action(saveCapture);}});
for(const btn of document.querySelectorAll('[data-close]'))btn.onclick=()=>closeDialog(btn.dataset.close);
$('detailDialog').addEventListener('cancel',e=>{e.preventDefault();closeDialog('detailDialog');});
for(const id of ['detailTitle','detailMemo','detailTags'])$(id).oninput=()=>{state.detailDirty=true;$('detailSaveStatus').textContent='未保存の変更あり';};
$('saveDetail').onclick=()=>action(saveDetail);
$('originalButton').onclick=()=>action(()=>call('openURL',{url:state.current.original_url||state.current.url}));
$('detailEnrich').onclick=()=>action(()=>detailAction(id=>call(state.current.type==='x'?'xImage':'enrich',{id})));
$('detailX').onclick=()=>action(async()=>{if(!confirm('公式X APIでこの投稿を取得します。API利用料が発生します。続けますか？'))return;await detailAction(id=>call('xLookup',{id}));});
$('detailAI').onclick=()=>action(async()=>{if(!confirm('設定済みのLLM APIへこのカードの情報を送信して整理します。API利用料が発生します。続けますか？'))return;await detailAction(id=>call('ai',{id}));});
$('attachButton').onclick=()=>action(()=>detailAction(id=>call('attachImage',{id})));
$('archiveButton').onclick=()=>action(async()=>{await detailAction(id=>call('update',{id,patch:{archived:!state.current.archived}}));$('detailDialog').close();});
$('loadMore').onclick=()=>{state.visibleLimit+=120;renderCards();};
$('search').oninput=()=>{state.visibleLimit=120;state.query=$('search').value;scheduleRefresh();};
$('nav').onclick=e=>{const btn=e.target.closest('button');if(!btn)return;state.type=btn.dataset.type||'';state.archived=btn.id==='archiveNav';state.tag='';for(const b of $('nav').querySelectorAll('button'))b.classList.toggle('active',b===btn);action(refresh);};
$('gridView').onclick=()=>{$('cards').classList.remove('list-view');$('gridView').classList.add('selected');$('listView').classList.remove('selected');};
$('listView').onclick=()=>{$('cards').classList.add('list-view');$('listView').classList.add('selected');$('gridView').classList.remove('selected');};
$('pullButton').onclick=()=>action(pull);
$('enrichButton').onclick=()=>action(async()=>{ $('enrichButton').disabled=true;try{const r=await call('enrich');const failed=r.filter(i=>i.status==='failed').length;toast(`${r.length}件の補完を実行。${failed?`${failed}件は取得できませんでした。URLとメモは保存済みです。`:''}`,Boolean(failed));await refresh();}finally{$('enrichButton').disabled=false;}});
$('settingsButton').onclick=()=>action(openSettings);$('settingsForm').onsubmit=e=>{e.preventDefault();action(saveSettings);};
function addStoreButton(id,label){const button=document.createElement('button');button.id=id;button.type='button';button.className='secondary';button.textContent=label;$('chooseRoot').insertAdjacentElement('afterend',button);}
addStoreButton('initStore','空フォルダをStoreとして初期化');
addStoreButton('migrateStore','v1 Storeを移行');
$('chooseRoot').onclick=()=>action(async()=>{const r=await call('chooseRoot');if(r){state.images.clear();await openSettings();await refresh();}});
$('initStore').onclick=()=>action(async()=>{const r=await call('initStore');if(r){state.images.clear();await openSettings();await refresh();toast('Neo Memo Storeを初期化しました。');}});
$('migrateStore').onclick=()=>action(async()=>{const r=await call('migrateStore');if(r){state.images.clear();await openSettings();await refresh();toast('v1 Storeを移行しました。');}});
$('folderButton').onclick=()=>action(()=>call('openFolder'));
$('gitSyncButton').onclick=()=>action(async()=>{await call('gitSync');toast('Git remoteへ同期しました。');await refresh();});
$('importButton').onclick=()=>action(async()=>{const r=await call('importFile');if(r){toast(`${r.count}件を取り込みました。`);await refresh();}});
$('exportButton').onclick=()=>action(async()=>{const r=await call('export');if(r)toast('JSONを書き出しました。');});
$('clearSecrets').onclick=()=>action(async()=>{if(confirm('保存したAPIキーを削除しますか？')){await call('saveSettings',{clearSecrets:true});await openSettings();}});
$('xPullButton').onclick=()=>action(async()=>{if(!confirm('保存済み設定を使い、X APIからブックマークを最大100件取得します。API利用料が発生します。続けますか？'))return;const r=await call('xPull');toast(`${r.count}件を取り込みました。${r.more?'続きがあります。':''}`);await refresh();});
document.addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey){if(e.key.toLowerCase()==='k'){e.preventDefault();$('search').focus();}if(e.key.toLowerCase()==='n'){e.preventDefault();if(!document.querySelector('dialog[open]'))openCapture();}if(e.key==='Enter'&&$('detailDialog').open){e.preventDefault();action(saveDetail);}}});
function connection(){ $('connection').textContent=navigator.onLine?'ONLINE':'OFFLINE'; }
window.addEventListener('offline',connection);window.addEventListener('online',()=>{connection();action(async()=>{const r=await call('reconnect');const errors=r?.filter(x=>x.error)||[];if(errors.length)toast(errors.map(x=>x.error).join('\n'),true);await refresh();});});
window.addEventListener('beforeunload',e=>{if(state.detailDirty){e.preventDefault();e.returnValue='';}});
connection();
if(window.neo){ window.neo.onChanged(scheduleRefresh);action(async()=>{settings=await call('settings');if(settings.startupError){$('warning').classList.remove('hidden');$('warning').textContent=settings.startupError;await openSettings();}else await refresh();}); }
else { $('warning').classList.remove('hidden');$('warning').textContent='この画面はデスクトップアプリ用です。READMEの手順で npm start から起動してください。'; }
