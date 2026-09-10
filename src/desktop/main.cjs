const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeImage, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
let win, service, config, util, appDir, secrets = {}, startupError = '', lastPull = 0, importWarnings = ''; 
const defaultConfig = () => ({ root: process.env.NEO_MEMO_STORE || '', cachePath: '', slack: { channels: [], user: '' }, discord: { channels: [], user: '' }, x: { userId: '' }, ai: { model: '', includeNotes: false }, autoPull: true, autoMetadata: false, autoAI: false });
const environmentSecrets = () => ({ slack: process.env.SLACK_BOT_TOKEN || '', discord: process.env.DISCORD_BOT_TOKEN || '', x: process.env.X_USER_TOKEN || '', openai: process.env.OPENAI_API_KEY || '' });
const knownSecrets = ['slack','discord','x','openai'];
function canEncrypt() { return safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'); }
async function loadSettings() {
  config = { ...defaultConfig(), ...await util.readJSON(path.join(appDir,'config.json'), {}) };
  if (process.env.NEO_MEMO_STORE) config.root = process.env.NEO_MEMO_STORE;
  const encrypted = await util.readJSON(path.join(appDir,'secrets.json'), {});
  if (Object.keys(encrypted).length && canEncrypt()) {
    for (const key of knownSecrets) if (encrypted[key]) { try { secrets[key] = safeStorage.decryptString(Buffer.from(encrypted[key],'base64')); } catch { /* A moved profile must re-enter its credentials. */ } }
  }
  for (const [key,value] of Object.entries(environmentSecrets())) if (value) secrets[key] = value;
}
async function saveSettings(input) {
  const next = structuredClone(config);
  for (const kind of ['slack','discord']) {
    const src = input[kind] || next[kind];
    if (!Array.isArray(src.channels) || src.channels.length > 20 || src.channels.some(x => !/^[A-Za-z0-9]{5,30}$/.test(x))) throw new Error('channel IDは英数字で入力してください（カンマ区切り可）。');
    next[kind] = { channels: src.channels, user: String(src.user || '').slice(0,40) };
  }
  if (input.x) next.x = { userId: String(input.x.userId || '').slice(0,30) };
  if (input.ai) next.ai = { model: String(input.ai.model || '').slice(0,100), includeNotes: Boolean(input.ai.includeNotes) };
  for (const key of ['autoPull','autoMetadata','autoAI']) if (key in input) next[key] = Boolean(input[key]);
  const secretUpdates = input.secrets || {};
  if (Object.values(secretUpdates).some(v => v) && !canEncrypt()) throw new Error('OSの安全な鍵保存が利用できません。鍵は保存せず、環境変数から渡してください。');
  const stored = await util.readJSON(path.join(appDir,'secrets.json'), {});
  for (const key of knownSecrets) if (typeof secretUpdates[key] === 'string' && secretUpdates[key]) {
    const value = util.text(secretUpdates[key],8192);
    stored[key] = safeStorage.encryptString(value).toString('base64'); secrets[key] = value;
  }
  if (input.clearSecrets) {
    for (const key of knownSecrets) { delete stored[key]; delete secrets[key]; }
    Object.assign(secrets,environmentSecrets());
  }
  await util.writeJSON(path.join(appDir,'secrets.json'),stored);
  await util.writeJSON(path.join(appDir,'config.json'),next); config = next;
  return publicSettings();
}
function publicSettings() { return { ...config, secrets: Object.fromEntries(knownSecrets.map(k => [k,Boolean(secrets[k])])), secureStorage: canEncrypt(), startupError }; }
async function resizeImage(buffer) {
  if (buffer.length > 5_242_880) throw new Error('画像は5 MiB以下にしてください。');
  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error('画像を読み込めませんでした。');
  const size = image.getSize();
  if (size.width * size.height > 40_000_000) throw new Error('画像の画素数が大きすぎます。');
  if (size.width > 1200 || size.height > 1200) image = image.resize(size.width >= size.height ? { width: 1200 } : { height: 1200 });
  return image.toJPEG(78);
}
async function openStore(root) {
  const { MemoService } = await import('../core/service.mjs');
  service = await new MemoService(root,{ resizeImage, cachePath: config.cachePath }).init();
  config.root = root; startupError = '';
  await util.writeJSON(path.join(appDir,'config.json'),config);
}
function changed() { if (win && !win.isDestroyed()) win.webContents.send('neo:changed'); }
async function maybeAI(id) {
  if (!config.autoAI || !config.ai?.model || !secrets.openai) return;
  const it = await service.get(id);
  if (it.summary || (['note','reading_note'].includes(it.type) && !config.ai.includeNotes) || (!it.description && !it.source_text && !['note','reading_note'].includes(it.type))) return;
  await service.ai(id,config,secrets);
}
async function pullAll() {
  if (!service) throw new Error(startupError || '保存先を選んでください。');
  const result = await service.pull(config,secrets); lastPull = Date.now();
  if (config.autoMetadata) { const items = await service.enrichPending(10); result.push({source:'metadata',items}); if(config.autoAI) for(const it of items) if(it.status==='ready') { try { await maybeAI(it.id); } catch(e) { result.push({source:'auto-ai',error:util.safeError(e)}); } } }
  importWarnings = result.filter(r=>r.error).map(r=>`${r.source}: ${r.error}`).join('\n');
  changed(); return result;
}
const handlers = {
  settings: async () => publicSettings(),
  saveSettings,
  chooseRoot: async () => {
    const result = await dialog.showOpenDialog(win,{ title: 'Neo Memo 専用データフォルダ', properties: ['openDirectory','createDirectory'] });
    if (result.canceled) return null;
    await openStore(result.filePaths[0]); changed(); return publicSettings();
  },
  initStore: async () => {
    const result = await dialog.showOpenDialog(win,{ title: 'Initialize empty Neo Memo Store folder', properties: ['openDirectory','createDirectory'] });
    if (result.canceled) return null;
    const { MemoService } = await import('../core/service.mjs');
    const next = new MemoService(result.filePaths[0], { resizeImage, cachePath: config.cachePath });
    await next.initStore(); service = next; config.root = next.root; startupError = '';
    await util.writeJSON(path.join(appDir,'config.json'),config); changed(); return publicSettings();
  },
  migrateStore: async () => {
    const result = await dialog.showOpenDialog(win,{ title: 'Select Neo Memo schema v1/v2 Store to migrate', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const { MemoService } = await import('../core/service.mjs');
    const next = new MemoService(result.filePaths[0], { resizeImage, cachePath: config.cachePath });
    await next.migrateStore(); service = next; config.root = next.root; startupError = '';
    await util.writeJSON(path.join(appDir,'config.json'),config); changed(); return publicSettings();
  },
  list: p => service.list(p),
  get: p => service.get(p.id),
  status: async () => service ? ({...await service.status(),importWarnings}) : { root: config.root, count: 0, gitWarning: startupError },
  capture: async p => {
    const result = p.kind === 'reading_note'
      ? [{ id: (await service.addReadingNote({ book: util.text(p.book), creator: util.text(p.creator || ''), location: util.text(p.location || ''), content: util.text(p.content) })).id, status: 'created' }]
      : p.kind === 'note'
        ? [{ id: (await service.addNote(util.text(p.content))).id, status: 'created' }]
        : await service.capture({ input: util.text(p.input), note: util.text(p.note || ''), source: 'desktop' });
    changed();
    for (const r of result) if (r.status === 'created') {
      (async()=>{const it=await service.get(r.id);if(it.type==='x'||config.autoMetadata)await service.enrich(r.id);if(config.autoAI)await maybeAI(r.id);changed();})().catch(e=>{importWarnings=util.safeError(e);changed();});
    }
    return result;
  },
  update: async p => { const r = await service.update(p.id,p.patch); changed(); return r; },
  appendMemo: async p => { const r = await service.appendMemo(p.id,util.text(p.content)); changed(); return r; },
  updateMemoEntry: async p => { const r = await service.updateMemoEntry(p.id,p.entryId,util.text(p.content)); changed(); return r; },
  asset: p => service.asset(p.id),
  pull: () => pullAll(),
  reconnect: async () => {
    if (!config.autoPull || Date.now() - lastPull < 60_000) return [];
    return pullAll();
  },
  enrich: async p => { const r = p.id ? await service.enrich(p.id) : await service.enrichPending(); changed(); return r; },
  ai: async p => { const r = await service.ai(p.id,config,secrets); changed(); return r; },
  xPull: async () => { const r = await service.pullX(config,secrets); changed(); return r; },
  xLookup: async p => { const r = await service.lookupX(p.id,secrets); changed(); return r; },
  xImage: async p => { const r = await service.fetchXImage(p.id); changed(); return r; },
  attachImage: async p => {
    const result = await dialog.showOpenDialog(win,{ title: 'プレビュー画像を追加', properties: ['openFile'], filters: [{ name:'Images', extensions:['jpg','jpeg','png','webp','gif'] }] });
    if (result.canceled) return null;
    const stat = await fs.stat(result.filePaths[0]); if (stat.size > 5_242_880) throw new Error('画像は5 MiB以下にしてください。');
    const r = await service.saveLocalImage(p.id,await fs.readFile(result.filePaths[0])); changed(); return r;
  },
  importFile: async () => {
    const result = await dialog.showOpenDialog(win,{ title: 'URL一覧 / X API JSON', properties:['openFile'], filters:[{name:'Text / JSON',extensions:['txt','json']}] });
    if (result.canceled) return null;
    const file = result.filePaths[0], stat = await fs.stat(file); if (stat.size > 10_485_760) throw new Error('ファイルは10 MiB以下にしてください。');
    const raw = await fs.readFile(file,'utf8'); let count = 0;
    if (file.endsWith('.json')) count = await service.importX(JSON.parse(raw));
    else for (const line of raw.split(/\r?\n/).filter(x=>x.trim())) count += (await service.capture({ input:line, source:'file',event_id:`line:${util.hash(line)}` })).filter(r=>r.status !== 'replayed').length;
    changed(); return { count };
  },
  export: async () => {
    const result = await dialog.showSaveDialog(win,{ defaultPath:'neo-memo-export.json',filters:[{name:'JSON',extensions:['json']}] });
    if (result.canceled) return null;
    await util.writeJSON(result.filePath,await service.exportJSON()); return { saved:true };
  },
  gitSync: async () => { const r = await service.syncGit(); changed(); return r; },
  openFolder: () => shell.openPath(config.root),
  openURL: async p => { const u = new URL(p.url); if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('URL形式が不正です。'); await shell.openExternal(u.href); return true; },
};
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    util = await import('../core/util.mjs');
    appDir = process.env.NEO_MEMO_APPDATA || app.getPath('userData'); await fs.mkdir(appDir,{recursive:true});
    await loadSettings();
    try { await openStore(config.root); } catch (e) { startupError = util.safeError(e); }
    const ui = path.join(__dirname,'../ui/index.html');
    win = new BrowserWindow({ width: 1280, height: 880, minWidth: 780, minHeight: 600, title: 'Neo Memo', backgroundColor:'#f6f5f1', webPreferences: { preload:path.join(__dirname,'preload.cjs'), nodeIntegration:false, contextIsolation:true, sandbox:true } });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label:'Neo Memo',submenu:[{role:'about'},{type:'separator'},{role:'quit'}] },{label:'編集',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'表示',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
    win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
    win.webContents.on('will-navigate',e => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    ipcMain.handle('neo',async (event,method,payload) => {
      if (event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(ui).href) throw new Error('不正な呼び出し元です。');
      if (!Object.hasOwn(handlers,method)) throw new Error('不明な操作です。');
      if (!service && !['settings','saveSettings','chooseRoot','initStore','migrateStore','status'].includes(method)) throw new Error(startupError || 'Select or initialize a Neo Memo Store.');
      return handlers[method](payload || {});
    });
    await win.loadFile(ui);
    if (config.autoPull && service) setTimeout(() => pullAll().catch(()=>{}),1000);
  }).catch(e => { console.error(e); app.quit(); });
  app.on('window-all-closed',async () => { if (service) await service.queue; app.quit(); });
}
