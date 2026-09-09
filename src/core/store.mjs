import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { atomicWrite, readJSON, writeJSON, now, hash, safeId, normalizeText, text, exists, assertNoSymlink } from './util.mjs';
import { extractCapture } from './urls.mjs';

export const EMPTY_STATE = { schema: 1, sources: {} };
export const STORE_FILE = 'neo-memo-store.json';
export const STORE_FORMAT = 'neo-memo-store';
export const STORE_SCHEMA_VERSION = 1;
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
  const { memo = '', ...meta } = item;
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${memo.replace(/\r\n/g, '\n').trimEnd()}\n`;
}
export function decodeItem(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!m) throw new Error('Item has no valid frontmatter.');
  const meta = JSON.parse(m[1]);
  if (meta.schema !== 1 || typeof meta.id !== 'string' || typeof meta.key !== 'string' || !Array.isArray(meta.captures) || !Array.isArray(meta.tags)) throw new Error('Item metadata is invalid.');
  safeId(meta.id);
  if (meta.preview && !ASSET_RE.test(meta.preview) && !LEGACY_ASSET_RE.test(meta.preview)) throw new Error('Item asset identifier is invalid.');
  return { ...meta, memo: m[2].trimEnd() };
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
  if (await exists(path.join(absolute, STORE_FILE))) return new Store(absolute).init();
  const legacy = await readJSON(path.join(absolute, 'neo-memo.json'));
  if (legacy?.schema !== 1) throw new Error('Unsupported legacy Neo Memo data schema.');
  const legacyCheckpoints = await readJSON(path.join(absolute, 'state', 'sources.json'), null);
  await writeJSON(path.join(absolute, STORE_FILE), { format: STORE_FORMAT, schemaVersion: STORE_SCHEMA_VERSION, storeId: randomUUID() });
  const store = await new Store(absolute).init();
  for (const item of store.items.values()) { const next = structuredClone(item); next.preview = assetId(next.preview || ''); await store.write(next); }
  if (legacyCheckpoints && checkpoints) await checkpoints.write(legacyCheckpoints);
  await fs.rm(path.join(absolute, 'state'), { recursive: true, force: true });
  return store;
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
      if (`${item.id}.md` !== name) throw new Error(`Item ID and filename differ: ${name}`);
      items.set(item.id, item);
    }
    this.items = items; return this;
  }
  async write(item) { safeId(item.id); await atomicWrite(await assertNoSymlink(this.root, `items/${item.id}.md`), encodeItem(item)); this.items.set(item.id, structuredClone(item)); return item; }
  findByCanonicalSource(key) { const found = [...this.items.values()].find(item => item.key === key); return found ? structuredClone(found) : null; }
  async createItem(args) { return this.capture(args); }
  async capture({ input, note = '', source = 'manual', event_id, captured_at, source_url = '', hints = {} }) {
    text(input); text(note);
    const parsed = extractCapture(input), reason = [parsed.note, note.trim()].filter(Boolean).join('\n');
    if (!parsed.urls.length && !reason) throw new Error('Provide a URL or memo.');
    const event = event_id || randomUUID(), at = captured_at || now(), entries = parsed.urls.length ? parsed.urls : [{ key: `note:${source}:${event}`, type: 'memo', url: '', original_url: '' }], results = [];
    for (const entry of entries) {
      const old = this.findByCanonicalSource(entry.key), id = old?.id || newItemId();
      if (old?.captures.some(c => c.source === source && c.event_id === event)) { results.push({ id, status: 'replayed' }); continue; }
      const item = old || { schema: 1, id, key: entry.key, url: entry.url, original_url: entry.original_url, type: entry.type, title: entry.type === 'memo' ? reason.slice(0, 90) : hints.title || (entry.type === 'x' ? `X post ${entry.key.slice(2)}` : new URL(entry.url).hostname), description: hints.description || '', summary: '', summary_basis: '', author: hints.author || '', saved_at: now(), updated_at: now(), tags: [], ai_tags: [], captures: [], memo: '', preview: '', preview_url: hints.preview_url || '', archived: false, enrichment: { status: entry.type === 'memo' ? 'ready' : 'pending', attempts: 0 } };
      item.captures.push({ source, event_id: event, at, note: reason, source_url }); item.updated_at = now();
      if (!old && hints.source_text) item.source_text = text(hints.source_text, 100_000);
      await this.write(item); results.push({ id, status: old ? 'appended' : 'created' });
    }
    return results;
  }
  get(id) { const item = this.items.get(safeId(id)); if (!item) throw new Error('Item not found.'); return structuredClone(item); }
  async update(id, patch) {
    const item = this.get(id); if ('title' in patch && patch.title !== item.title) item.manual_title = true;
    for (const key of ['title', 'memo']) if (key in patch) item[key] = text(patch[key]);
    if ('tags' in patch) { if (!Array.isArray(patch.tags) || patch.tags.length > 100) throw new Error('Invalid tags.'); item.tags = [...new Set(patch.tags.map(value => text(value, 100).trim()).filter(Boolean))]; }
    if ('archived' in patch) item.archived = Boolean(patch.archived);
    item.updated_at = now(); return this.write(item);
  }
  list({ query = '', type = '', tag = '', archived = false } = {}) {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    return [...this.items.values()].filter(item => Boolean(item.archived) === archived && (!type || item.type === type) && (!tag || [...item.tags, ...(item.ai_tags || [])].includes(tag))).map(item => {
      const fields = [item.title, item.url, item.description, item.summary, item.memo, (item.captures || []).map(c => c.note).join(' '), [...item.tags, ...(item.ai_tags || [])].join(' ')].map(normalizeText);
      if (!terms.every(term => fields.some(field => field.includes(term)))) return null;
      const score = terms.reduce((total, term) => total + (fields[0].includes(term) ? 4 : 0) + (fields[4].includes(term) || fields[5].includes(term) ? 2 : 0) + (fields[6].includes(term) ? 2 : 0), 0);
      return { ...structuredClone(item), score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || b.saved_at.localeCompare(a.saved_at));
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
