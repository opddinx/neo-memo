import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
async function walk(dir){for(const f of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())await walk(p);else if(/\.(?:mjs|cjs|js)$/.test(f.name))execFileSync(process.execPath,['--check',p],{stdio:'inherit'});}}
for(const dir of ['src','bin','tests','scripts'])await walk(dir);
console.log('Syntax checks passed.');
