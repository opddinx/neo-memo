import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';

export const hash = x => createHash('sha256').update(x).digest('hex');
export const now = () => new Date().toISOString();
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function text(value, max = 100_000) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`文字列が不正です（上限 ${max} 文字）。`);
  return value;
}
export function normalizeText(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase(); }
export async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
export async function readJSON(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw e; }
}
export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = await fs.open(tmp, 'wx', 0o600);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
  try { await fs.rename(tmp, file); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
  // fsync the directory on POSIX where supported, so a successful save survives more than a process crash.
  try { const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
}
export async function writeJSON(p, obj) { await atomicWrite(p, `${JSON.stringify(obj, null, 2)}\n`); }
export function safeId(id) {
  if (!/^[a-z0-9_-]{6,80}$/i.test(id)) throw new Error('不正なIDです。');
  return id;
}
export function within(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== path.resolve(root) && !p.startsWith(path.resolve(root) + path.sep)) throw new Error('保存先の外にはアクセスできません。');
  return p;
}
export async function assertNoSymlink(root, rel) {
  let p = path.resolve(root);
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    if (part === '..') throw new Error('不正なパスです。');
    p = path.join(p, part);
    try { if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('データフォルダ内のシンボリックリンクは利用できません。'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return p;
}
export async function withFileLock(root, fn, lockName = 'writer') {
  await fs.mkdir(path.join(root, '.neo-local'), { recursive: true });
  safeId(lockName.padEnd(6, '_'));
  const lock = path.join(root, '.neo-local', `${lockName}.lock`);
  let acquired = false;
  const start = Date.now();
  while (!acquired) {
    try {
      const h = await fs.open(lock, 'wx', 0o600);
      await h.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), at: now() }));
      await h.close(); acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const data = await readJSON(lock);
        if (data.host === os.hostname()) {
          try { process.kill(data.pid, 0); }
          catch (err) { if (err.code === 'ESRCH') { await fs.rm(lock, { force: true }); continue; } }
        }
      } catch {}
      if (Date.now() - start > 10_000) throw new Error('別の処理が保存中です。少しして再実行してください。');
      await sleep(80);
    }
  }
  try { return await fn(); } finally { await fs.rm(lock, { force: true }); }
}
export function safeError(e) {
  return String(e?.message || e).replace(/(?:xox[baprs]-|sk-)[A-Za-z0-9_-]+/g, '[secret]').slice(0, 500);
}
