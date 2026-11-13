import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('./',import.meta.url);
const entries=JSON.parse(await readFile(new URL('large-file-parts.json',root)));
for(const entry of entries){
 const base=new URL('./',new URL(entry.path,root));
 const module=await import(new URL('split-model-loader.mjs',base));
 const item=JSON.parse(await readFile(new URL('model-parts.json',base)))[0];
 const buffer=await module.assembleParts(item,base,{fetchImpl:async url=>new Response(await readFile(url))});
 assert.equal(buffer.byteLength,entry.size);
 assert.equal(new DataView(buffer).getUint32(0,true),0x46546c67);
 assert.equal(new DataView(buffer).getUint32(8,true),entry.size);
 globalThis.location={href:new URL('index.html',base).href};
 globalThis.fetch=async url=>new Response(await readFile(url));
 let parsed=false;
 const fakeLoader={parseAsync:async(bytes,resourcePath)=>{assert.equal(bytes.byteLength,entry.size);assert.equal(resourcePath,base.href);parsed=true;return {scene:'test'};}};
 assert.deepEqual(await module.loadSplitGLTF(fakeLoader,'./model.glb',()=>{}),{scene:'test'});
 assert.ok(parsed);
 for(const name of ['viewer.js','webgpu-viewer.js']){
  const code=await readFile(new URL(name,base),'utf8');assert.ok(code.includes("loadSplitGLTF(loader,'./model.glb',"));
 }
 console.log('PASS SHA256/GLB and relative load adapter, both viewer integrations',entry.path);
}
