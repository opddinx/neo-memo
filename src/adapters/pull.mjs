import { apiJSON } from '../core/net.mjs';
import { now, sleep } from '../core/util.mjs';

const direct = fn => fn();
async function saveSource(checkpoints, key, source) { const state = await checkpoints.read(); state.sources[key] = source; await checkpoints.write(state); }
function checkChannel(channel) { if (!/^[A-Za-z0-9]{5,30}$/.test(channel)) throw new Error('Channel IDを確認してください。'); }
export async function pullSlack(store, { token, channel, user = '', maxPages = 10, api = apiJSON, delay = 1300, transaction = direct, checkpoints } = {}) {
  checkpoints ||= store.checkpoints;
  if (!checkpoints) throw new Error('Connector checkpoint storage is required.');
  if (!token) throw new Error('Slack Bot Tokenを設定してください。'); checkChannel(channel);
  const state = await checkpoints.read(), key = `slack:${channel}`;
  const s = state.sources[key] ||= { high: '0', last_pull: '' };
  if (!s.scan) s.scan = { base: s.high, latest: (Date.now()/1000).toFixed(6), cursor: '', high: s.high };
  let count = 0, pages = 0;
  for (; pages < maxPages; pages++) {
    const p = new URLSearchParams({ channel, oldest: s.scan.base, latest: s.scan.latest, limit: '100', inclusive: 'false' });
    if (s.scan.cursor) p.set('cursor',s.scan.cursor);
    const data = await api(`https://slack.com/api/conversations.history?${p}`, { token });
    if (!data.ok) {
      if (data.error === 'invalid_cursor') { delete s.scan; await transaction(() => saveSource(checkpoints, key, s)); }
      throw new Error(`Slack: ${data.error || 'unknown_error'}。権限・channel ID・Botの参加状況を確認してください。`);
    }
    const messages = data.messages || [];
    await transaction(async () => {
    for (const m of [...messages].reverse()) {
      if (!m.ts) continue;
      if (!m.bot_id && !['channel_join','channel_leave','channel_topic','channel_purpose','channel_name'].includes(m.subtype) && (!user || m.user === user) && m.text?.trim()) {
        const result = await store.capture({ input: m.text, source: key, event_id: m.ts, captured_at: new Date(Number(m.ts) * 1000).toISOString(), source_url: '' });
        count += result.filter(r => r.status !== 'replayed').length;
      }
      if (Number(m.ts) > Number(s.scan.high)) s.scan.high = m.ts;
    }
    const cursor = data.response_metadata?.next_cursor || '';
    if (data.has_more && !cursor) throw new Error('Slackが継続cursorを返しませんでした。保存位置を進めず停止しました。');
    if (cursor) s.scan.cursor = cursor;
    else { s.high = s.scan.high; delete s.scan; s.last_pull = now(); }
    // Advance only after every card on this page has been atomically saved.
    await saveSource(checkpoints, key, s);
    });
    if (!s.scan) break;
    if (pages + 1 < maxPages && delay) await sleep(delay);
  }
  return { source: key, count, pages: pages + (s.scan ? 0 : 1), more: Boolean(s.scan), last_pull: s.last_pull };
}
export async function pullDiscord(store, { token, channel, user = '', maxPages = 10, api = apiJSON, delay = 300, transaction = direct, checkpoints } = {}) {
  checkpoints ||= store.checkpoints;
  if (!checkpoints) throw new Error('Connector checkpoint storage is required.');
  if (!token) throw new Error('Discord Bot Tokenを設定してください。'); checkChannel(channel);
  const state = await checkpoints.read(), key = `discord:${channel}`;
  const s = state.sources[key] ||= { high: '0', last_pull: '' };
  if (!s.scan) s.scan = { base: s.high, before: '', high: s.high };
  let count = 0, pages = 0;
  for (; pages < maxPages; pages++) {
    const p = new URLSearchParams({ limit: '100' });
    if (s.scan.before) p.set('before',s.scan.before);
    const data = await api(`https://discord.com/api/v10/channels/${channel}/messages?${p}`, { token, authPrefix: 'Bot' });
    if (!Array.isArray(data)) throw new Error('Discordの応答形式が不正です。');
    const ordered = [...data].sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    // Missing message content must not silently advance the checkpoint.
    const candidates = ordered.filter(m => BigInt(m.id) > BigInt(s.scan.base) && !m.author?.bot && (!user || m.author?.id === user));
    if (candidates.some(m => m.type === 0 && !m.content && !m.attachments?.length && !m.sticker_items?.length && !m.poll)) throw new Error('Discordの本文が空です。MESSAGE CONTENT INTENTを有効にしてください。保存位置は進めません。');
    await transaction(async () => {
    for (const m of candidates) {
      if (!m.content?.trim()) continue;
      const result = await store.capture({ input: m.content, source: key, event_id: m.id, captured_at: m.timestamp, source_url: m.guild_id ? `https://discord.com/channels/${m.guild_id}/${channel}/${m.id}` : '' });
      count += result.filter(r => r.status !== 'replayed').length;
    }
    for (const m of data) if (BigInt(m.id) > BigInt(s.scan.high)) s.scan.high = m.id;
    const min = ordered[0]?.id;
    const done = !data.length || data.length < 100 || BigInt(min) <= BigInt(s.scan.base);
    if (done) { s.high = s.scan.high; delete s.scan; s.last_pull = now(); }
    else s.scan.before = min;
    await saveSource(checkpoints, key, s);
    });
    if (!s.scan) break;
    if (pages + 1 < maxPages && delay) await sleep(delay);
  }
  return { source: key, count, pages: pages + (s.scan ? 0 : 1), more: Boolean(s.scan), last_pull: s.last_pull };
}
export async function pullXBookmarks(store, { token, userId, maxPages = 1, api = apiJSON, transaction = direct, checkpoints } = {}) {
  checkpoints ||= store.checkpoints;
  if (!checkpoints) throw new Error('Connector checkpoint storage is required.');
  if (!token || !/^\d+$/.test(userId || '')) throw new Error('XのOAuthユーザートークンとUser IDを設定してください（App-only Bearer Tokenは使えません）。');
  const state = await checkpoints.read(), key = `x-bookmarks:${userId}`;
  const s = state.sources[key] ||= { next_token: '', last_pull: '' };
  let count = 0;
  for (let page = 0; page < maxPages; page++) {
    const p = new URLSearchParams({ max_results: '100', 'tweet.fields': 'created_at,author_id,note_tweet', expansions: 'author_id,attachments.media_keys', 'user.fields': 'name,username', 'media.fields': 'url,preview_image_url,type' });
    if (s.next_token) p.set('pagination_token',s.next_token);
    const data = await api(`https://api.x.com/2/users/${userId}/bookmarks?${p}`, { token });
    await transaction(async () => {
    count += await importXPage(store, data, key);
    s.next_token = data.meta?.next_token || '';
    s.last_pull = now(); await saveSource(checkpoints, key, s);
    });
    if (!s.next_token) break;
  }
  return { source: key, count, more: Boolean(s.next_token), last_pull: s.last_pull };
}
export async function importXPage(store, data, source = 'x-bookmarks:file') {
  if (!Array.isArray(data.data)) { if (data.meta?.result_count === 0) return 0; throw new Error('X API形式の data 配列がありません。'); }
  const users = new Map((data.includes?.users || []).map(x => [x.id,x]));
  const media = new Map((data.includes?.media || []).map(x => [x.media_key,x]));
  let count = 0;
  for (const post of data.data) {
    if (!/^\d+$/.test(post.id || '')) continue;
    const author = users.get(post.author_id), firstMedia = media.get(post.attachments?.media_keys?.[0]);
    const content = post.note_tweet?.text || post.text || '';
    const result = await store.capture({ input: `https://x.com/i/status/${post.id}`, source, event_id: post.id, hints: { title: content.slice(0,110), description: content, source_text: content, author: author ? `${author.name} (@${author.username})` : post.author_id || '', preview_url: firstMedia?.url || firstMedia?.preview_image_url || '' } });
    const it = store.get(result[0].id);
    // API enrichment can improve an earlier URL-only Slack capture without altering its notes.
    if (content) { if (!it.manual_title) it.title = content.slice(0,110); it.source_text = content; it.description = content; }
    if (author) it.author = `${author.name} (@${author.username})`;
    if (firstMedia) it.preview_url = firstMedia.url || firstMedia.preview_image_url || '';
    it.enrichment = { status: 'ready', at: now(), adapter: 'x-api' };
    await store.write(it);
    count += result.filter(r => r.status !== 'replayed').length;
  }
  return count;
}

export async function lookupXPost(store, id, { token, api = apiJSON, transaction = direct, initialItem } = {}) {
  if (!token) throw new Error('XのAPIトークンを設定してください。');
  const initial = initialItem || store.get(id);
  if (!/^x:\d+$/.test(initial.key)) throw new Error('X投稿ではありません。');
  const postId = initial.key.slice(2);
  const p = new URLSearchParams({ 'tweet.fields':'created_at,author_id,note_tweet', expansions:'author_id,attachments.media_keys', 'user.fields':'name,username', 'media.fields':'url,preview_image_url,type' });
  const data = await api(`https://api.x.com/2/tweets/${postId}?${p}`,{token});
  if (!data.data?.id) throw new Error('X投稿を取得できませんでした。削除・非公開・権限を確認してください。');
  return transaction(async()=>{
    const it=store.get(id),post=data.data,content=post.note_tweet?.text || post.text || '';
    if (content) { if(!it.manual_title)it.title=content.slice(0,110);it.source_text=content;it.description=content; }
    const author=data.includes?.users?.find(u=>u.id===post.author_id);
    if(author)it.author=`${author.name} (@${author.username})`;
    const media=data.includes?.media?.find(m=>m.media_key===post.attachments?.media_keys?.[0]);
    if(media)it.preview_url=media.url || media.preview_image_url || '';
    it.enrichment={status:'ready',adapter:'x-api',at:now()};it.updated_at=now();
    return store.write(it);
  });
}
