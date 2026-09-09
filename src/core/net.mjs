import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { sleep } from './util.mjs';
export const AGENT = 'NeoMemo/1.0 (+local personal link metadata; no traversal)';

export function isPublicIP(ip) {
  if (net.isIPv4(ip)) {
    const [a,b,c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (net.isIPv6(ip)) {
    // Deliberately conservative: global unicast only; exclude documentation and transition prefixes.
    const s = ip.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(s) && !/^(2001:|2002:|3fff:)/.test(s);
  }
  return false;
}
export async function requestBytes(raw, { maxBytes = 2_097_152, timeout = 15_000, headers = {}, redirects = 3, method = 'GET', body, publicOnly = true, followRedirects = true } = {}) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw new Error('このURLへの通信は許可していません。');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (publicOnly && (/^(localhost|.*\.localhost|.*\.local)$/i.test(host) || !host.includes('.') && !net.isIP(host))) throw new Error('ローカルネットワークのURLは自動取得しません。');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addresses.length || publicOnly && addresses.some(x => !isPublicIP(x.address))) throw new Error('プライベート／予約済みIPへの自動取得を拒否しました。');
  const address = addresses.find(x => x.family === 4) || addresses[0];
  // Pin the checked DNS answer to the connection, rather than resolving it a second time.
  const lookup = (_hostname, opts, cb) => opts?.all ? cb(null, [address]) : cb(null, address.address, address.family);
  const result = await new Promise((resolve, reject) => {
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(u, { method, lookup, headers: { 'User-Agent': AGENT, 'Accept-Encoding': 'identity', ...headers } }, res => {
      const chunks = []; let total = 0;
      const len = Number(res.headers['content-length'] || 0);
      if (len > maxBytes) { req.destroy(new Error('応答がサイズ上限を超えています。')); return; }
      res.on('data', chunk => { total += chunk.length; if (total > maxBytes) req.destroy(new Error('応答がサイズ上限を超えています。')); else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks), url: u.href }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('通信がタイムアウトしました。')), timeout);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    if (body) req.write(body); req.end();
  });
  if ([301,302,303,307,308].includes(result.status) && result.headers.location) {
    if (!followRedirects) return result;
    if (redirects <= 0) throw new Error('リダイレクトを停止しました。');
    const target = new URL(result.headers.location, u).href;
    // Never forward API credentials to a redirect destination.
    if (headers.Authorization || headers.authorization || method !== 'GET') throw new Error('認証付きAPIのリダイレクトを拒否しました。');
    return requestBytes(target, { maxBytes, timeout, headers, redirects: redirects - 1, publicOnly });
  }
  return result;
}
export async function apiJSON(url, { token, method = 'GET', body, authPrefix = 'Bearer', transport = requestBytes, retries = 1, form = false } = {}) {
  for (let n = 0; ; n++) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `${authPrefix} ${token}`;
    if (body) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    const res = await transport(url, { headers, method, body: body ? (form ? String(body) : JSON.stringify(body)) : undefined, maxBytes: 5_242_880, redirects: 0, timeout: 30_000 });
    let data;
    try { data = JSON.parse(res.buffer.toString('utf8')); } catch { throw new Error(`APIがJSONを返しませんでした (${res.status})。`); }
    if (res.status === 429) {
      const sec = Math.max(1, Number(res.headers['retry-after'] || data.retry_after || 60));
      if (n < retries && sec <= 2) { await sleep(sec * 1000); continue; }
      const err = new Error(`API制限中です。${Math.ceil(sec)}秒以降に再実行してください。`); err.retryAfter = sec; throw err;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`APIエラー ${res.status} (${String(data.error?.code || data.title || data.error || 'request_failed').slice(0, 100)})。`);
    return data;
  }
}
