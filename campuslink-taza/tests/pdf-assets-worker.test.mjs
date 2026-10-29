import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
test('public PDF font/decoder assets remain usable offline in a bounded cache without caching private requests',async()=>{
 const origin='https://campus.test',listeners={},stores=new Map();let offline=false,requests=0;
 const cacheFor=name=>{if(!stores.has(name))stores.set(name,new Map());const records=stores.get(name);return {match:async req=>records.get(req.url)?.clone(),put:async(req,res)=>records.set(req.url,res),keys:async()=>[...records.keys()].map(url=>new Request(url)),delete:async req=>records.delete(req.url)};};
 const context=vm.createContext({URL,Set,Promise,Request,Response,self:{location:{origin},addEventListener:(name,fn)=>listeners[name]=fn},caches:{open:async name=>cacheFor(name)},fetch:async()=>{requests++;if(offline)throw Error('offline');return new Response('public font bytes',{headers:{'content-type':'application/octet-stream'}});}});
 vm.runInContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),context);
 const get=async path=>{let result;listeners.fetch({request:{url:new URL(path,origin).href,method:'GET',mode:'cors'},respondWith:value=>result=value});return result;};
 const font='/pdfjs-assets/6.4.299/standard_fonts/FoxitSymbol.pfb';assert.equal(await (await get(font)).text(),'public font bytes');assert.equal(requests,1);
 offline=true;assert.equal(await (await get(font)).text(),'public font bytes');assert.equal(requests,1);
 assert.equal(await get('/api/files/1'),undefined);assert.equal(await get('https://external.test/pdfjs-assets/6.4.299/wasm/openjpeg.wasm'),undefined);
 assert.equal(await get(font+'?private=1'),undefined);assert.equal(requests,1);
 offline=false;assert.equal((await get('/fonts/NotoSansMath-Regular.ttf')).status,200);offline=true;assert.equal((await get('/fonts/NotoSansMath-Regular.ttf')).status,200);assert.equal(requests,2);
 offline=false;for(let index=0;index<230;index++)await get('/pdfjs-assets/6.4.299/cmaps/fixture-'+index+'.bcmap');
 assert.equal(stores.size,1);assert.equal([...stores.values()][0].size,224);
});
