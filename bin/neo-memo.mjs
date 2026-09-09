#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoService } from '../src/core/service.mjs';
import { safeError } from '../src/core/util.mjs';

const args = process.argv.slice(2);
function opt(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`--${name} requires a path or value.`);
  const value = args[index + 1]; args.splice(index, 2); return value;
}
const HELP = `Neo Memo 1.0 — local-first capture and Store\n\nUsage:\n  neo-memo <command> --store <path> [options]\n\nStore commands:\n  init store                 initialize an empty Store folder\n  migrate store              migrate an existing v1 Store in place\n  status                     show Store and Git status\n\nCapture commands:\n  add <URL or text> [--note …]\n  add --stdin\n  add-note <text>\n  add-reading-note --book <title> [--location <locator>] [--creator <name>] <text>\n  search <query>\n  list\n  get <item-id>\n  note <item-id> <text>\n  pull slack|discord|x\n  import <file.txt|file.json>\n  enrich [item-id]\n  x-get <item-id>\n  ai <item-id> --model <name>\n  git-sync\n  export\n\nStore resolution: --store <path>, then NEO_MEMO_STORE. No Store is created implicitly.\n`;

try {
  const store = opt('store', process.env.NEO_MEMO_STORE || '');
  const note = opt('note'), book = opt('book'), location = opt('location'), creator = opt('creator'), channel = opt('channel'), userId = opt('user-id'), user = opt('user'), model = opt('model');
  const command = args.shift() || 'help', subcommand = args[0] || '';
  if (['help', '--help', '-h'].includes(command)) { console.log(HELP); process.exit(0); }
  if (!store) throw new Error('Neo Memo Store is not set. Pass --store <path> or set NEO_MEMO_STORE.');
  const service = new MemoService(path.resolve(store));
  let result;
  if (command === 'init' && subcommand === 'store') result = await (await service.initStore()).status();
  else if (command === 'migrate' && subcommand === 'store') result = await (await service.migrateStore()).status();
  else {
    await service.init();
    const secrets = { slack: process.env.SLACK_BOT_TOKEN, discord: process.env.DISCORD_BOT_TOKEN, x: process.env.X_USER_TOKEN, openai: process.env.OPENAI_API_KEY };
    switch (command) {
      case 'status': result = await service.status(); break;
      case 'add': {
        let input = args.join(' ');
        if (args.includes('--stdin')) { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); input = Buffer.concat(chunks).toString('utf8'); }
        result = await service.capture({ input, note, source: 'cli' });
        for (const saved of result) { const item = await service.get(saved.id); if (item.type === 'x') await service.enrich(saved.id); }
        break;
      }
      case 'add-note': result = await service.addNote(args.join(' ')); break;
      case 'add-reading-note': result = await service.addReadingNote({ book, location, creator, content: args.join(' ') }); break;
      case 'search': result = await service.list({ query: args.join(' ') }); break;
      case 'list': result = await service.list(); break;
      case 'get': result = await service.get(args[0]); break;
      case 'note': { const item = await service.get(args.shift()); result = await service.update(item.id, { content: [item.content, args.join(' ')].filter(Boolean).join('\n\n') }); break; }
      case 'pull': {
        const kind = args[0];
        if (kind === 'x') result = await service.pullX({ x: { userId } }, secrets);
        else if (['slack', 'discord'].includes(kind)) result = await service.pull({ [kind]: { channels: [channel], user } }, secrets, { only: kind });
        else throw new Error('Use: pull slack, pull discord, or pull x.');
        break;
      }
      case 'import': {
        const file = args[0], raw = await fs.readFile(file, 'utf8');
        if (file.endsWith('.json')) result = await service.importX(JSON.parse(raw));
        else { let count = 0; for (const line of raw.split(/\r?\n/).filter(line => line.trim())) count += (await service.capture({ input: line, source: 'file' })).length; result = { count }; }
        break;
      }
      case 'enrich': result = args[0] ? await service.enrich(args[0]) : await service.enrichPending(); break;
      case 'x-get': result = await service.lookupX(args[0], secrets); break;
      case 'ai': result = await service.ai(args[0], { ai: { model, includeNotes: false } }, secrets); break;
      case 'git-sync': result = await service.syncGit(); break;
      case 'export': result = await service.exportJSON(); break;
      default: throw new Error(`Unknown command: ${command}.\n\n${HELP}`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Neo Memo: ${safeError(error)}`); process.exitCode = 1;
}
