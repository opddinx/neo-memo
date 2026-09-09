import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { atomicWrite, readJSON, writeJSON, now, hash, safeId, normalizeText, text, exists, assertNoSymlink } from './util.mjs';
import { extractCapture } from './urls.mjs';

export const EMPTY_STATE = { schema: 1, sources: {} };
export const STORE_FILE = 'neo-memo-store.json';
export const STORE_FORMAT = 'neo-memo-store';
export const STORE_SCHEMA_VERSION = 2;
const ASSET_RE = /^sha256:([a-f0-9]{64})$/;
const LEGACY_ASSET_RE = /^assets\/[a-f0-9]{2}\/([a-f0-9]{64})\.(?:png|jpg|webp|gif)$/;
const assetId = value => LEGACY_ASSET_RE.test(value || '') ? `sha256:${value.match(LEGACY_ASSET_RE)[1]}` : value;

function newItemId() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = BigInt(Date.now()), id = '';
  for (let i = 0; i < 10; i++) { id = alphabet[Number(time & 31n)] + id; time >>= 5n; }
  for (const byte of randomBytes(16)) id += alphabet[byte & 31];
  return id;
}

export function encodeItem(item) {
  const body = item.schema === 1 ? item.memo || '' : item.content || '';
  const meta = { ...item }; delete meta.memo; delete meta.content;
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${body.replace(/\r\n/g, '\n').trimEnd()}\n`;
}
export function decodeItem(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!m) throw new Error('Item has no valid frontmatter.');
  const meta = JSON.parse(m[1]);
  if (![1, 2].includes(meta.schema) || typeof meta.id !== 'string' || !Array.isArray(meta.captures) || !Array.isArray(meta.tags)) throw new Error('Item metadata is invalid.');
  if (meta.schema === 1 && typeof meta.key !== 'string') throw new Error('Item metadata is invalid.');
  safeId(meta.id);
  if (meta.preview && !ASSET_RE.test(meta.preview) && !LEGACY_ASSET_RE.test(meta.preview)) throw new Error('Item asset identifier is invalid.');
  return meta.schema === 1 ? { ...meta, memo: m[2].trimEnd() } : { ...meta, content: m[2].trimEnd() };
}

function sourceKind(type) { return type === 'x' ? 'x' : type === 'youtube' ? 'video' : type === 'web' || type === 'github' || type === 'note' ? 'web' : 'other'; }
function itemType(type, url = '') { return type === 'memo' ? 'note' : type === 'x' ? 'x' : url ? 'web' : 'other'; }
function migrateItemV1(old) {
  const createdAt = old.createdAt || old.saved_at || now(), updatedAt = old.updatedAt || old.updated_at || createdAt;
  const kind = sourceKind(old.type), url = old.url || old.original_url || '';
  const source = url || old.title || old.author || old.external_id ? {
    kind,
    ...(old.title ? { title: old.title } : {}),
    ...(old.author ? { creator: old.author } : {}),
    ...(url ? { url } : {}),
    ...(old.external_id ? { externalId: String(old.external_id) } : old.type === 'x' && old.key?.startsWith('x:') ? { externalId: old.key.slice(2) } : {})
  } : undefined;
  const captureText = (old.captures || []).map(c => c.note).filter(Boolean).join('\n\n');
  const content = old.memo || (old.type === 'memo' ? captureText : '');
  const preview = assetId(old.preview || '');
  return {
    ...old, schema: 2, type: itemType(old.type, url),
    title: old.manual_title ? old.title : '', content, source,
    assets: preview ? [preview] : [], createdAt, updatedAt, preview,
    url, saved_at: old.saved_at || createdAt, updated_at: old.updated_at || updatedAt
  };
}

function validateItem(item) {
  if (item.schema !== 2 || typeof item.id !== 'string' || !['note','reading_note','web','x','other'].includes(item.type) || !Array.isArray(item.captures) || !Array.isArray(item.tags)) throw new Error('Item metadata is invalid.');
  safeId(item.id);
  if (item.type === 'reading_note' && (item.source?.kind !== 'book' || !String(item.source?.title || '').trim())) throw new Error('Reading note requires source.kind=book and source.title.');
  if (item.source && !['book','web','x','paper','video','other'].includes(item.source.kind)) throw new Error('Item source kind is invalid.');
  for (const id of [...(item.assets || []), item.preview].filter(Boolean)) if (!ASSET_RE.test(assetId(id))) throw new Error('Item asset identifier is invalid.');
}

export async function validateStore(root) {
  const absolute = path.resolve(root), marker = path.join(absolute, STORE_FILE);
  if (!(await exists(marker))) throw new Error(`Not a Neo Memo Store: ${absolute}. Use \`neo-memo init store --store <path>\` for an empty folder, or \`neo-memo migrate store --store <path>\` for v1 data.`);
  const meta = await readJSON(marker);
  if (meta?.format !== STORE_FORMAT) throw new Error(`Invalid ${STORE_FILE}: format must be ${STORE_FORMAT}.`);
  if (meta?.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error(`Unsupported Neo Memo Store schemaVersion: ${meta?.schemaVersion}.`);
  if (typeof meta.storeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(meta.storeId)) throw new Error(`Invalid ${STORE_FILE}: storeId must be a persistent UUID.`);
  return { root: absolute, ...meta };
}

export async function initStore(root) {
  const absolute = path.resolve(root);
  await fs.mkdir(absolute, { recursive: true });
  const entries = (await fs.readdir(absolute)).filter(name => name !== '.DS_Store');
  if (entries.length) throw new Error('Store initialization requires an empty folder. Existing v1 data must be migrated explicitly.');
  await writeJSON(path.join(absolute, STORE_FILE), { format: STORE_FORMAT, schemaVersion: STORE_SCHEMA_VERSION, storeId: randomUUID() });
  await atomicWrite(path.join(absolute, '.gitignore'), '*.tmp\n.DS_Store\n.env\n.env.*\n');
  await atomicWrite(path.join(absolute, '.gitattributes'), '*.md text eol=lf\n*.json text eol=lf\nassets/** binary\n');
  await atomicWrite(path.join(absolute, 'README.md'), '# Neo Memo Data Store\n\nCanonical Neo Memo data. Keep this repository private when it contains personal notes.\n\n- `neo-memo-store.json`: Store identity and schema\n- `items/`: Markdown items addressed by immutable item ID\n- `assets/`: content-addressed assets (`sha256:<hash>`)\n\nConnector checkpoints, caches, indexes, embeddings, and temporary files do not belong in this Store.\n');
  for (const dir of ['items', 'assets']) await fs.mkdir(path.join(absolute, dir), { recursive: true });
  return new Store(absolute).init();
}

export async function migrateV1Store(root, { checkpoints } = {}) {
  const absolute = path.resolve(root);
  const markerPath = path.join(absolute, STORE_FILE), marker = await readJSON(markerPath, null);
  if (marker?.format === STORE_FORMAT && marker.schemaVersion === STORE_SCHEMA_VERSION) return new Store(absolute).init();
  if (marker && (marker.format !== STORE_FORMAT || marker.schemaVersion !== 1)) throw new Error('Unsupported legacy Neo Memo data schema.');
  const legacy = marker || await readJSON(path.join(absolute, 'neo-memo.json'));
  if (!marker && legacy?.schema !== 1) throw new Error('Unsupported legacy Neo Memo data schema.');
  const legacyCheckpoints = await readJSON(path.join(absolute, 'state', 'sources.json'), null);
  for (const name of await fs.readdir(path.join(absolute, 'items'))) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(absolute, 'items', name), item = decodeItem(await fs.readFile(file, 'utf8'));
    if (item.schema === 1) await atomicWrite(file, encodeItem(migrateItemV1(item)));
  }
  await writeJSON(markerPath, { format: STORE_FORMAT, schemaVersion: STORE_SCHEMA_VERSION, storeId: marker?.storeId || randomUUID() });
  if (legacyCheckpoints && checkpoints) await checkpoints.write(legacyCheckpoints);
  await fs.rm(path.join(absolute, 'state'), { recursive: true, force: true });
  return new Store(absolute).init();
}

export class Store {
  constructor(root) { this.root = path.resolve(root); this.items = new Map(); }
  async init() {
    await validateStore(this.root);
    for (const dir of ['items', 'assets']) { await assertNoSymlink(this.root, dir); await fs.mkdir(path.join(this.root, dir), { recursive: true }); }
    return this.reload();
  }
  async reload() {
    const items = new Map();
    for (const name of await fs.readdir(path.join(this.root, 'items'))) {
      if (!name.endsWith('.md')) continue;
      const item = decodeItem(await fs.readFile(await assertNoSymlink(this.root, `items/${name}`), 'utf8'));
      validateItem(item);
      if (`${item.id}.md` !== name) throw new Error(`Item ID and filename differ: ${name}`);
      items.set(item.id, item);
    }
    this.items = items; return this;
  }
  async write(item) { validateItem(item); await atomicWrite(await assertNoSymlink(this.root, `items/${item.id}.md`), encodeItem(item)); this.items.set(item.id, structuredClone(item)); return item; }
  findByCanonicalSource(key) { const found = [...this.items.values()].find(item => item.key === key); return found ? structuredClone(found) : null; }
  async createItem({ type = 'other', title = '', content = '', source, summary = '', tags = [], assets = [], captures = [] }) {
    const stamp = now(), item = { schema: 2, id: newItemId(), type, title: text(title), content: text(content, 1_000_000), ...(source ? { source: structuredClone(source) } : {}), summary: text(summary, 100_000), tags: [...tags], assets: [...assets], createdAt: stamp, updatedAt: stamp, captures: structuredClone(captures), ai_tags: [], archived: false };
    await this.write(item); return structuredClone(item);
  }
  async createNote(content, options = {}) { if (!String(content || '').trim()) throw new Error('Quick Note content is required.'); return this.createItem({ type: 'note', content, ...options }); }
  async createReadingNote({ book, creator = '', location = '', content, title = '', tags = [] }) {
    if (!String(book || '').trim()) throw new Error('--book is required for a reading note.');
    if (!String(content || '').trim()) throw new Error('Reading note memo is required.');
    const source = { kind: 'book', title: text(book, 500).trim(), ...(String(creator).trim() ? { creator: text(creator, 500).trim() } : {}), ...(String(location).trim() ? { locator: text(location, 500).trim() } : {}) };
    return this.createItem({ type: 'reading_note', title, content, source, tags, captures: [{ source: 'manual', event_id: randomUUID(), at: now(), note: '', source_url: '' }] });
  }
  async capture({ input, note = '', source = 'manual', event_id, captured_at, source_url = '', hints = {} }) {
    text(input); text(note);
    const parsed = extractCapture(input), reason = [parsed.note, note.trim()].filter(Boolean).join('\n');
    if (!parsed.urls.length && !reason) throw new Error('Provide a URL or memo.');
    if (!parsed.urls.length) { const item = await this.createNote(reason, { captures: [{ source, event_id: event_id || randomUUID(), at: captured_at || now(), note: reason, source_url }] }); return [{ id: item.id, status: 'created' }]; }
    const event = event_id || randomUUID(), at = captured_at || now(), entries = parsed.urls, results = [];
    for (const entry of entries) {
      const old = this.findByCanonicalSource(entry.key), id = old?.id || newItemId();
      if (old?.captures.some(c => c.source === source && c.event_id === event)) { results.push({ id, status: 'replayed' }); continue; }
      const stamp = now(), kind = entry.type === 'x' ? 'x' : 'web';
      const item = old || { schema: 2, id, key: entry.key, url: entry.url, original_url: entry.original_url, type: entry.type === 'x' ? 'x' : 'web', title: '', content: '', source: { kind, title: hints.title || (entry.type === 'x' ? `X post ${entry.key.slice(2)}` : new URL(entry.url).hostname), ...(hints.author ? { creator: hints.author } : {}), url: entry.url, ...(entry.type === 'x' ? { externalId: entry.key.slice(2) } : {}) }, description: hints.description || '', summary: '', summary_basis: '', createdAt: stamp, updatedAt: stamp, saved_at: stamp, updated_at: stamp, tags: [], ai_tags: [], captures: [], assets: [], preview: '', preview_url: hints.preview_url || '', archived: false, enrichment: { status: 'pending', attempts: 0 } };
      item.captures.push({ source, event_id: event, at, note: reason, source_url }); item.updatedAt = item.updated_at = now();
      if (!old && hints.source_text) item.source_text = text(hints.source_text, 100_000);
      await this.write(item); results.push({ id, status: old ? 'appended' : 'created' });
    }
    return results;
  }
  get(id) { const item = this.items.get(safeId(id)); if (!item) throw new Error('Item not found.'); return structuredClone(item); }
  async update(id, patch) {
    const item = this.get(id); if ('title' in patch && patch.title !== item.title) item.manual_title = true;
    if ('memo' in patch && !('content' in patch)) patch = { ...patch, content: patch.memo };
    for (const key of ['title', 'content']) if (key in patch) item[key] = text(patch[key], key === 'content' ? 1_000_000 : 10_000);
    if ('tags' in patch) { if (!Array.isArray(patch.tags) || patch.tags.length > 100) throw new Error('Invalid tags.'); item.tags = [...new Set(patch.tags.map(value => text(value, 100).trim()).filter(Boolean))]; }
    if ('archived' in patch) item.archived = Boolean(patch.archived);
    item.updatedAt = item.updated_at = now(); return this.write(item);
  }
  list({ query = '', type = '', tag = '', archived = false } = {}) {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    return [...this.items.values()].filter(item => Boolean(item.archived) === archived && (!type || item.type === type) && (!tag || [...item.tags, ...(item.ai_tags || [])].includes(tag))).map(item => {
      const fields = [item.title, item.content, item.source?.title, item.source?.creator, item.source?.locator, item.summary, item.description, item.url, (item.captures || []).map(c => c.note).join(' '), [...item.tags, ...(item.ai_tags || [])].join(' ')].map(normalizeText);
      if (!terms.every(term => fields.some(field => field.includes(term)))) return null;
      const score = terms.reduce((total, term) => total + (fields[0].includes(term) || fields[2].includes(term) ? 4 : 0) + (fields[1].includes(term) || fields[5].includes(term) ? 2 : 0) + (fields[9].includes(term) ? 2 : 0), 0);
      return { ...structuredClone(item), score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || (b.createdAt || b.saved_at).localeCompare(a.createdAt || a.saved_at));
  }
  async saveAsset(buffer) {
    const ext = imageType(buffer); if (!ext || buffer.length > 1_048_576) throw new Error('Invalid image or image exceeds 1 MiB.');
    const digest = hash(buffer), rel = `assets/${digest.slice(0, 2)}/${digest}.${ext}`, file = await assertNoSymlink(this.root, rel);
    if (!(await exists(file))) await atomicWrite(file, buffer); return `sha256:${digest}`;
  }
  async resolveAsset(identifier) {
    const match = ASSET_RE.exec(assetId(identifier || '')); if (!match) throw new Error('Invalid asset identifier.');
    const digest = match[1];
    for (const ext of ['png','jpg','webp','gif']) { const file = await assertNoSymlink(this.root, `assets/${digest.slice(0, 2)}/${digest}.${ext}`); if (await exists(file)) return file; }
    throw new Error(`Asset not found: ${identifier}`);
  }
}
export function imageType(buf) {
  if (buf.length < 12) return '';
  if (buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'gif';
  return '';
}
