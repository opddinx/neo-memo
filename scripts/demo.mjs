import { MemoService } from '../src/core/service.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(),'neo-memo-demo-'));
const svc=await new MemoService(root).initStore();
const cards=[
 {input:'https://example.com/demo/layered-motion',title:'形をずらすだけで生まれる、奥行きのある動き',description:'重ねた輪郭と小さな位相差を使う、モーション表現のデモ用カード。',note:'複雑な3Dを作らなくても、この重なりで見せられそう。',tags:['motion','geometry'],asset:'layers.png'},
 {input:'https://note.com/neomemo_demo/n/demo01',title:'「あとで考える」を置いておく場所',description:'情報を整理するより先に、気になった理由だけを残す。これは実在の記事ではなくUIのデモです。',note:'分類を始めると、保存すること自体が面倒になる。',tags:['暮らし','メモ'],asset:'notes.png'},
 {input:'https://x.com/neomemo_demo/status/1234500000000000000',title:'余白と質感を使った、小さなインタラクション',description:'画像と短いコメントをストックするためのサンプル投稿。',note:'動きの終わり方が好き。イージングの参考に。',tags:['interaction','texture'],asset:'grain.png'},
 {input:'https://github.com/neomemo-demo/tiny-tool',title:'Tiny Tool — 小さく始めるための実装メモ',description:'URLと一言を保存するだけの、小さな道具を想定したデモカード。',note:'ローカルファイルを正本にする構成が参考。',tags:['tool','local-first']},
 {input:'資料を見ていて気づいたこと',title:'色を揃えるより、「変わり方」を揃えたい',description:'URLがなくても、思いついたことをそのまま保存できる。',note:'同じ色でも、変化の速度や方向でまとまり方が違う気がする。',tags:['観察','色'],asset:'palette.png'},
 {input:'https://example.com/demo/field-notes',title:'光と影の境界を、少しだけ曖昧にする',description:'繰り返す線と光の階調を、視覚リファレンスとして保存するサンプル。',note:'資料の見せ方に使えそう。忘れないように残す。',tags:['light','visual'],asset:'light.png'},
];
for(let n=0;n<cards.length;n++){
 const c=cards[n],[r]=await svc.capture({input:c.input,note:c.note,source:'demo',event_id:`demo-${n}`});
 await svc.mutate(async()=>{const it=svc.store.get(r.id);Object.assign(it,{title:c.title,description:c.description,tags:c.tags,enrichment:{status:'ready',adapter:'demo'},saved_at:new Date(Date.UTC(2026,8,8,1,10-n)).toISOString()});await svc.store.write(it);},'demo: sample content');
 if(c.asset){try{await svc.saveLocalImage(r.id,await fs.readFile(path.join(here,'../examples/images',c.asset)));}catch(e){console.error(e.message);}}
}
console.log(root);
