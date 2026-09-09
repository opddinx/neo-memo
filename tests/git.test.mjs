import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MemoService } from '../src/core/service.mjs';
const exec=promisify(execFile);
async function git(args){return (await exec('git',args)).stdout.trim();}
async function fixture(t){
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'neo-git-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const origin=path.join(parent,'origin.git'),aPath=path.join(parent,'a');await git(['init','--bare','--initial-branch=main',origin]);
 const a=await new MemoService(aPath).initStore();await git(['-C',aPath,'remote','add','origin',origin]);
 // Transport remains local. Only the URL policy gate is replaced; all git operations are real.
 const allowLocal=s=>{const run=s.git.run.bind(s.git);s.git.run=async args=>args.join(' ')==='remote get-url origin'?'https://fixture.invalid/private.git':run(args);};
 allowLocal(a);await a.syncGit();
 const bPath=path.join(parent,'b');await git(['clone',origin,bPath]);const b=await new MemoService(bPath).init();allowLocal(b);
 return {a,b,origin,parent};
}
test('Git remote sync pushes local data and fast-forwards an unchanged clone',async t=>{
 const {a,b}=await fixture(t);await a.capture({input:'remote fixture note'});await a.syncGit();await b.syncGit();assert.equal((await b.list()).length,1);assert.equal((await a.status()).git.head,(await b.status()).git.head);
});
test('Diverged Git histories stop without merge or force push',async t=>{
 const {a,b,origin}=await fixture(t);await a.capture({input:'on machine A'});await a.syncGit();const before=await git(['--git-dir',origin,'rev-parse','main']);await b.capture({input:'on machine B'});await assert.rejects(b.syncGit(),/分岐/);assert.equal(await git(['--git-dir',origin,'rev-parse','main']),before);assert.equal((await b.list())[0].captures[0].note,'on machine B');
});
test('Foreign staged files do not enter an automatic commit',async t=>{
 const {a}=await fixture(t);await fs.writeFile(path.join(a.root,'do-not-commit.txt'),'secret');await git(['-C',a.root,'add','do-not-commit.txt']);await a.capture({input:'still saved'});assert.equal(await git(['-C',a.root,'ls-tree','--name-only','HEAD','do-not-commit.txt']),'');
});
