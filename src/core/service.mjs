import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Store, initStore, migrateV1Store } from '../store/index.mjs';
import { GitStore } from './git.mjs';
import { ConnectorState } from './connector-state.mjs';
import { withFileLock, safeError, assertNoSymlink } from './util.mjs';
import { enrichItem, aiAnnotate } from './metadata.mjs';
import { pullSlack, pullDiscord, pullXBookmarks, importXPage, lookupXPost } from '../adapters/pull.mjs';
import { requestBytes } from './net.mjs';
import { enrichXItem } from '../enrichment/x-oembed.mjs';

export class MemoService {
  constructor(root, options = {}) {
    if (!root) throw new Error('A Neo Memo Store path is required. Use --store <path> or NEO_MEMO_STORE.');
    this.root = path.resolve(root); this.options = options;
    this.cacheRoot = path.resolve(options.cachePath || path.join(os.tmpdir(), 'neo-memo-cache', createHash('sha256').update(this.root).digest('hex')));
    this.store = new Store(this.root); this.git = new GitStore(this.root, this.cacheRoot); this.connectorState = new ConnectorState(this.cacheRoot); this.queue = Promise.resolve(); this.gitWarning = '';
  }
  async init() {
    await this.store.init();
    try { await this.git.init(); await this.git.commit('memo: initialize data repository'); } catch (e) { this.gitWarning = safeError(e); }
    return this;
  }
  async initStore() {
    await initStore(this.root); await this.store.init();
    try { await this.git.init(); await this.git.commit('memo: initialize data store'); } catch (e) { this.gitWarning = safeError(e); }
    return this;
  }
  async migrateStore() {
    await migrateV1Store(this.root, { checkpoints: this.connectorState }); await this.store.init();
    try { await this.git.init(); await this.git.commit('migrate: v1 data store'); } catch (e) { this.gitWarning = safeError(e); }
    return this;
  }
  mutate(fn, message = 'memo: save') {
    const run = this.queue.then(() => withFileLock(this.cacheRoot, async () => {
      await this.store.reload();
      let result, error;
      try { result = await fn(); } catch (e) { error = e; }
      // Even partially completed imports are committed; replay is idempotent.
      try { await this.git.init(); await this.git.commit(message); this.gitWarning = ''; } catch (e) { this.gitWarning = safeError(e); }
      if (error) throw error;
      return result;
    }));
    this.queue = run.catch(() => {}); return run;
  }
  async list(filters = {}) { const reader = new Store(this.root); await reader.reload(); return reader.list(filters); }
  async get(id) { const reader = new Store(this.root); await reader.reload(); return reader.get(id); }
  capture(args) { return this.mutate(() => this.store.capture(args), 'capture: add to inbox'); }
  addNote(content) { return this.mutate(() => this.store.createNote(content), 'capture: add quick note'); }
  addReadingNote(args) { return this.mutate(() => this.store.createReadingNote(args), 'capture: add reading note'); }
  update(id, patch) { return this.mutate(() => this.store.update(id, patch), 'memo: edit card'); }
  async status() { return { root: this.root, cacheRoot: this.cacheRoot, count: (await this.list()).length, gitWarning: this.gitWarning, git: await this.git.status().catch(e => ({ error: safeError(e) })), sources: (await this.connectorState.read()).sources }; }
  async pull(config, secrets, { only = '' } = {}) {
    const results = [];
    // Each connector is independent: a Discord failure must not block Slack, and vice versa.
    for (const [kind, fn] of [['slack',pullSlack],['discord',pullDiscord]]) {
      if (only && only !== kind) continue;
      const channels = config[kind]?.channels || [];
      for (const channel of channels) {
        try { results.push(await withFileLock(this.cacheRoot, () => fn(this.store, { token: secrets[kind], channel, user: config[kind]?.user || '', maxPages: 5, ...this.options.adapterOptions, checkpoints: this.connectorState, transaction: callback => this.mutate(callback, `pull: ${kind}`) }), `pull-${kind}-${channel}`)); }
        catch (e) { results.push({ source: `${kind}:${channel}`, error: safeError(e) }); }
      }
    }
    const xItems = await this.enrichPendingX();
    if (xItems.length) results.push({ source: 'x-oembed', count: xItems.filter(i => i.status === 'ready').length, items: xItems });
    return results;
  }
  pullX(config, secrets) {
    return withFileLock(this.cacheRoot, () => pullXBookmarks(this.store, { token: secrets.x, userId: config.x?.userId, maxPages: 1, ...this.options.adapterOptions, checkpoints: this.connectorState, transaction: callback => this.mutate(callback, 'pull: X bookmarks (one paid page)') }), 'pull-x-bookmarks');
  }
  async lookupX(id, secrets) { const initialItem = await this.get(id); return lookupXPost(this.store,id,{initialItem,token:secrets.x,...this.options.adapterOptions,transaction:callback=>this.mutate(callback,'enrich: X post (paid)')}); }
  importX(data) { return this.mutate(() => importXPage(this.store, data), 'import: X API JSON'); }
  async enrich(id) {
    const initialItem = await this.get(id);
    if (initialItem.type !== 'x') return enrichItem(this.store, id, { ...this.options, initialItem, transaction: callback => this.mutate(callback, 'enrich: metadata') });
    let enriched;
    try { enriched = await enrichXItem(initialItem, { transport: this.options.xOEmbedTransport || this.options.fetcher || requestBytes }); }
    catch (error) { enriched = structuredClone(initialItem); enriched.enrichment = { status: 'failed', adapter: 'x-oembed', attempts: (initialItem.enrichment?.attempts || 0) + 1, error: safeError(error), at: new Date().toISOString() }; }
    return this.mutate(async () => {
      const latest = this.store.get(id);
      for (const field of ['source','source_text','description','enrichment']) if (field in enriched) latest[field] = enriched[field];
      latest.updatedAt = latest.updated_at = new Date().toISOString();
      return this.store.write(latest);
    }, 'enrich: X oEmbed');
  }
  async enrichPendingX(limit = 20) {
    const ids = (await this.list()).filter(i => !i.archived && i.type === 'x' && ['pending','failed'].includes(i.enrichment?.status)).slice(0, limit).map(i => i.id);
    const results = [];
    for (const id of ids) { const item = await this.enrich(id); results.push({ id, status: item.enrichment.status, error: item.enrichment.error || '' }); }
    return results;
  }
  async enrichPending(limit = 10) {
    const ids = (await this.list()).filter(i => !i.archived && i.url && ['pending','failed'].includes(i.enrichment?.status)).slice(0, limit).map(i => i.id);
    const results = [];
    for (const id of ids) results.push(await this.enrich(id));
    return results.map(i => ({ id: i.id, status: i.enrichment.status, error: i.enrichment.error || '' }));
  }
  async ai(id, config, secrets) { return aiAnnotate(this.store, id, { initialItem: await this.get(id), key: secrets.openai, model: config.ai?.model, includeNotes: Boolean(config.ai?.includeNotes), ...this.options.aiOptions, transaction: callback => this.mutate(callback, 'enrich: AI annotation') }); }
  async asset(id) {
    const it = await this.get(id); if (!it.preview) return '';
    const file = await this.store.resolveAsset(it.preview);
    const ext = path.extname(file).slice(1), mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
    if (!mime) return '';
    const bytes = await fs.readFile(file); if (bytes.length > 1_048_576) return '';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }
  async saveLocalImage(id, bytes) {
    return this.mutate(async () => { const it = this.store.get(id); const image = this.options.resizeImage ? await this.options.resizeImage(bytes) : bytes; it.preview = await this.store.saveAsset(image); it.assets = [...new Set([...(it.assets || []),it.preview])]; it.manual_preview = true; return this.store.write(it); }, 'memo: attach preview');
  }
  async fetchXImage(id) {
    const initial = await this.get(id);
    if (!initial.preview_url || initial.type !== 'x') return initial;
    const r = await (this.options.fetcher || requestBytes)(initial.preview_url, { maxBytes: this.options.resizeImage ? 5_242_880 : 1_048_576 });
    if (r.status !== 200) throw new Error('画像を取得できませんでした。');
    const bytes = this.options.resizeImage ? await this.options.resizeImage(r.buffer) : r.buffer;
    return this.mutate(async () => {
      const it = this.store.get(id);
      if (it.preview !== initial.preview || it.manual_preview !== initial.manual_preview) return it;
      it.preview = await this.store.saveAsset(bytes); it.assets = [...new Set([...(it.assets || []),it.preview])]; return this.store.write(it);
    }, 'enrich: X preview');
  }
  syncGit() { return this.mutate(async () => { const r = await this.git.sync(); await this.store.reload(); return r; }, 'memo: before remote sync'); }
  async exportJSON() { return { schema: 2, items: [...await this.list(), ...await this.list({archived:true})] }; }
}
