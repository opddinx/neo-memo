import { hash } from './util.mjs';
const TRACKING = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid)$/i;
export function normalizeURL(raw) {
  const u = new URL(String(raw).trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('http(s) のURLだけを保存できます。認証情報入りURLは利用できません。');
  if (u.href.length > 8192) throw new Error('URLが長すぎます。');
  const host = u.hostname.toLowerCase();
  if (/^(www\.|mobile\.)?(x\.com|twitter\.com)$/.test(host)) {
    const match = u.pathname.match(/^\/(?:[^/]+\/status|i\/(?:web\/)?status)\/(\d+)(?:\/|$)/);
    if (match) return { url: `https://x.com/i/status/${match[1]}`, key: `x:${match[1]}`, type: 'x' };
  }
  // Query semantics and meaningful fragments (SPA routes, headings) are preserved.
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (u.hash.startsWith('#:~:text=')) u.hash = '';
  const type = /(^|\.)note\.com$/.test(host) ? 'note' : /(^|\.)github\.com$/.test(host) ? 'github' : /(^|\.)(youtube\.com|youtu\.be)$/.test(host) ? 'youtube' : 'web';
  return { url: u.href, key: `url:${u.href}`, type };
}
export const idFor = key => hash(key).slice(0, 32);
export function extractCapture(input) {
  let value = String(input || '').replace(/<(https?:\/\/[^>|]+)(?:\|[^>]+)?>/g, '$1');
  const urls = [], seen = new Set();
  const found = value.matchAll(/https?:\/\/[^\s<>"'`]+/g);
  for (const m of found) {
    let raw = m[0].replace(/[.,;!?。、，；！？」』】]+$/u, '');
    while (raw.endsWith(')') && (raw.match(/\)/g)?.length || 0) > (raw.match(/\(/g)?.length || 0)) raw = raw.slice(0, -1);
    try {
      const n = normalizeURL(raw);
      if (!seen.has(n.key)) { urls.push({ ...n, original_url: raw }); seen.add(n.key); }
      value = value.replace(raw, '');
    } catch {}
  }
  return { urls, note: value.replace(/^[\s()\[\]<>]+|[\s()\[\]<>]+$/g, '').trim() };
}
