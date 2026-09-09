import { requestBytes } from '../core/net.mjs';
import { decodeHTML } from '../core/metadata.mjs';
import { normalizeURL } from '../core/urls.mjs';
import { now } from '../core/util.mjs';

export const X_OEMBED_ENDPOINT = 'https://publish.x.com/oembed';

function cleanTweetHTML(html = '') {
  const safe = String(html).replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const paragraph = safe.match(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/i)?.[1] || safe.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/i)?.[1] || '';
  return decodeHTML(paragraph.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, 100_000);
}

export function parseXOEmbed(response) {
  if (!response || typeof response !== 'object') throw new Error('X oEmbed response is invalid.');
  const sourceText = cleanTweetHTML(response.html);
  if (!sourceText) throw new Error('X oEmbed response has no Tweet text.');
  return {
    sourceText,
    title: sourceText.slice(0, 110),
    creator: String(response.author_name || '').trim().slice(0, 500),
  };
}

export async function fetchXOEmbed(rawURL, { transport = requestBytes } = {}) {
  const normalized = normalizeURL(rawURL);
  if (normalized.type !== 'x' || !normalized.key.startsWith('x:')) throw new Error('X oEmbed requires an x.com or twitter.com status URL.');
  const endpoint = new URL(X_OEMBED_ENDPOINT);
  endpoint.searchParams.set('url', normalized.url);
  endpoint.searchParams.set('omit_script', 'true');
  const response = await transport(endpoint.href, { headers: { Accept: 'application/json' }, maxBytes: 1_048_576, redirects: 0, timeout: 15_000 });
  if (response.status < 200 || response.status >= 300) throw new Error(`X oEmbed failed (${response.status}).`);
  let data;
  try { data = JSON.parse(response.buffer.toString('utf8')); } catch { throw new Error('X oEmbed did not return JSON.'); }
  return { ...parseXOEmbed(data), url: normalized.url, externalId: normalized.key.slice(2) };
}

export async function enrichXItem(item, options = {}) {
  if (item?.type !== 'x') throw new Error('Item is not an X post.');
  const details = await fetchXOEmbed(item.source?.url || item.url, options);
  const next = structuredClone(item);
  next.source = { ...(next.source || {}), kind: 'x', url: details.url, externalId: details.externalId, title: details.title, ...(details.creator ? { creator: details.creator } : {}) };
  next.source_text = details.sourceText;
  next.description = details.sourceText;
  next.enrichment = { status: 'ready', adapter: 'x-oembed', attempts: (next.enrichment?.attempts || 0) + 1, at: now() };
  next.updatedAt = next.updated_at = now();
  return next;
}
