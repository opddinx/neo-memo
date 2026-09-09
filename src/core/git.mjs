import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
export class GitStore {
  constructor(root, cacheRoot) { if (!cacheRoot) throw new Error('GitStore requires a cache path separate from the Store.'); this.root = path.resolve(root); this.cacheRoot = path.resolve(cacheRoot); }
  async run(args) {
    try {
      const r = await exec('git', ['-c', `core.hooksPath=${path.join(this.cacheRoot, 'no-hooks')}`, '-C', this.root, ...args], { timeout: 30_000, maxBuffer: 5_000_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return r.stdout.trim();
    } catch (e) { throw new Error(`Git: ${(e.stderr || e.message).trim().slice(0, 1000)}`); }
  }
  async init() {
    await fs.mkdir(path.join(this.cacheRoot, 'no-hooks'), { recursive: true });
    const gitPath = path.join(this.root, '.git');
    try { await fs.access(gitPath); }
    catch {
      // Refuse implicit nested repositories: source and data stay separate.
      try { const top = await this.run(['rev-parse','--show-toplevel']); if (top !== this.root) throw new Error('データフォルダを既存Git repoの外へ移してください。'); }
      catch (e) { if (!e.message.startsWith('Git:')) throw e; }
      await this.run(['init','--initial-branch=main']);
    }
    const top = await this.run(['rev-parse','--show-toplevel']);
    if (path.resolve(top) !== this.root) throw new Error('データrepoのルートが一致しません。');
  }
  async commit(message = 'memo: save local changes') {
    if ((await this.run(['ls-files','-u'])).length) throw new Error('Git競合があります。解決後に再実行してください。');
    await this.run(['add', '--', 'items', 'assets', 'neo-memo-store.json', 'README.md', '.gitignore', '.gitattributes']);
    const names = (await this.run(['diff','--cached','--name-only'])).split('\n').filter(Boolean);
    if (names.some(n => !/^(items\/|assets\/|neo-memo-store\.json$|README\.md$|\.gitignore$|\.gitattributes$)/.test(n))) throw new Error('アプリ管理外のstaged fileがあります。手動で確認してください。');
    if (!names.length) return { changed: false, commit: await this.head() };
    await this.run(['-c','user.name=Neo Memo','-c','user.email=local@neo-memo.invalid','commit','-m',message]);
    return { changed: true, commit: await this.head() };
  }
  async head() { try { return await this.run(['rev-parse','--short','HEAD']); } catch { return ''; } }
  async status() { return { head: await this.head(), dirty: Boolean(await this.run(['status','--porcelain'])), remote: await this.run(['remote','get-url','origin']).catch(() => '') }; }
  async sync() {
    await this.commit();
    const branch = await this.run(['branch','--show-current']);
    if (!branch) throw new Error('detached HEADです。ブランチを選んでください。');
    const remote = await this.run(['remote','get-url','origin']);
    if (!/^(https:\/\/[^@]+\/|git@[^:]+:|ssh:\/\/[^ ]+)/.test(remote)) throw new Error('HTTPSまたはSSHのoriginを設定してください。');
    await this.run(['fetch','origin']);
    const ref = `refs/remotes/origin/${branch}`;
    try { await this.run(['show-ref','--verify',ref]); }
    catch { await this.run(['push','--set-upstream','origin',branch]); return this.status(); }
    const [localAhead, remoteAhead] = (await this.run(['rev-list','--left-right','--count',`HEAD...${ref}`])).split(/\s+/).map(Number);
    if (localAhead && remoteAhead) throw new Error('Git履歴が分岐しています。自動merge/force-pushはしません。手動で統合してください。');
    if (remoteAhead) await this.run(['merge','--ff-only',ref]);
    await this.run(['push','--set-upstream','origin',branch]);
    return this.status();
  }
}
