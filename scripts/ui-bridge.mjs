// Test-only stdio bridge. This is NOT a server, and is not used by the desktop app.
import readline from 'node:readline';
import { MemoService } from '../src/core/service.mjs';
const service=await new MemoService(process.argv[2]).initStore();
const settings={root:service.root,slack:{channels:[],user:''},discord:{channels:[],user:''},x:{userId:''},ai:{model:'',includeNotes:false},autoPull:false,autoMetadata:false,secrets:{slack:false,discord:false,x:false,openai:false},secureStorage:false,startupError:''};
const handlers={settings:()=>settings,list:p=>service.list(p),get:p=>service.get(p.id),status:()=>service.status(),capture:p=>service.capture({...p,source:'desktop'}),update:p=>service.update(p.id,p.patch),asset:p=>service.asset(p.id),pull:()=>[],reconnect:()=>[],saveSettings:p=>Object.assign(settings,p),openFolder:()=>true,openURL:()=>true};
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 try{const {method,payload={}}=JSON.parse(line);if(!Object.hasOwn(handlers,method))throw new Error('Unsupported test command');console.log(JSON.stringify({ok:true,value:await handlers[method](payload)}));}
 catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}
}
