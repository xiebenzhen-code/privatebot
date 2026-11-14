import {after,before,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loginCookie} from './helpers.ts';
import {CATALOG_TTL_MS} from '../scripts/lib/model-catalog-core.mjs';
import {createCatalogReporter} from '../scripts/lib/magpie-catalog.mjs';
process.env.WB_DB=':memory:';
process.env.WB_TOKEN='test-token-not-real-068000';
process.env.WB_PASSWORD='test-password-not-real-068';
let D:typeof import('../src/db.ts');
let runner:typeof import('../src/services/runner.ts');
let server:Server;
let base='';
const sample={status:'ok',code:'ok',models:[{id:'provider/model',label:'模型A',provider:'provider',reasoning_levels:['high'],executors:['pool'],projects:['demo']}]};
before(async()=>{
 D=await import('../src/db.ts');runner=await import('../src/services/runner.ts');
 const {handle}=await import('../src/app.ts');
 server=createServer((q,s)=>void handle(q,s));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 base='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
after(()=>server.close());
beforeEach(()=>{D.db().exec('DELETE FROM runners');runner.heartbeat('catalog-test',{executors:['pool']});});
const headers=()=>({'Content-Type':'application/json',Authorization:'Bearer '+process.env.WB_TOKEN});
const report=(catalog=sample)=>fetch(base+'/api/runner/models',{method:'POST',headers:headers(),body:JSON.stringify({runner:'catalog-test',catalog})});

test('068.1 执行器可上报目录，按执行者和项目允许名单取交集',async()=>{
 assert.equal((await report()).status,200);
 const r=await fetch(base+'/api/model-catalogs?executor=pool&project=demo',{headers:headers()});
 assert.equal(r.status,200);
 const body=await r.json();
 assert.equal(body.catalogs[0].models[0].id,'provider/model');
 assert.equal(JSON.stringify(body).includes('executors'),false,'不把其他项目/执行者授权列表回显给查询方');
});
test('068.1 空目录接口可读，不要求工作台自己连Magpie',async()=>{
 const r=await fetch(base+'/api/model-catalogs?executor=pool&project=demo',{headers:headers()});
 assert.equal(r.status,200);assert.deepEqual((await r.json()).catalogs,[]);
});
test('068.1 未登录不能读目录，人类Cookie不能冒充执行器上报',async()=>{
 assert.equal((await fetch(base+'/api/model-catalogs?executor=pool&project=demo')).status,401);
 const cookie=await loginCookie(base,process.env.WB_PASSWORD!);
 const r=await fetch(base+'/api/runner/models',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({runner:'catalog-test',catalog:sample})});
 assert.equal(r.status,403);
 assert.equal((D.db().prepare('SELECT model_catalog FROM runners WHERE id=?').get('catalog-test') as any).model_catalog,'');
});
test('068.1 别的执行者或项目不能借同一目录拿候选，查询必须带上下文',async()=>{
 await report();
 for(const q of ['executor=codex&project=demo','executor=pool&project=other']){
  const r=await fetch(base+'/api/model-catalogs?'+q,{headers:headers()});
  assert.equal((await r.json()).catalogs.flatMap((c:any)=>c.models).length,0);
 }
 assert.equal((await fetch(base+'/api/model-catalogs?executor=pool',{headers:headers()})).status,400);
});
test('068.1 未知或离线执行器不能写目录，上报不代替心跳',async()=>{
 const unknown=await fetch(base+'/api/runner/models',{method:'POST',headers:headers(),body:JSON.stringify({runner:'not-registered',catalog:sample})});
 assert.equal(unknown.status,404);
 const seen=(D.db().prepare('SELECT last_seen FROM runners WHERE id=?').get('catalog-test') as any).last_seen;
 await report();
 assert.equal((D.db().prepare('SELECT last_seen FROM runners WHERE id=?').get('catalog-test') as any).last_seen,seen);
 D.db().prepare('UPDATE runners SET last_seen=? WHERE id=?').run('2020-01-01T00:00:00Z','catalog-test');
 assert.equal((await report()).status,409);
});
test('068.1 目录过期或心跳过期不再给候选',async()=>{
 await report();
 const raw=(D.db().prepare('SELECT model_catalog FROM runners WHERE id=?').get('catalog-test') as any).model_catalog;
 const catalog=JSON.parse(raw);catalog.received_at=new Date(Date.now()-CATALOG_TTL_MS-1000).toISOString();
 D.db().prepare('UPDATE runners SET model_catalog=? WHERE id=?').run(JSON.stringify(catalog),'catalog-test');
 let result=await (await fetch(base+'/api/model-catalogs?executor=pool&project=demo',{headers:headers()})).json();
 assert.equal(result.catalogs[0].code,'expired');assert.deepEqual(result.catalogs[0].models,[]);
 await report();D.db().prepare('UPDATE runners SET last_seen=? WHERE id=?').run('2020-01-01T00:00:00Z','catalog-test');
 result=await (await fetch(base+'/api/model-catalogs?executor=pool&project=demo',{headers:headers()})).json();
 assert.equal(result.catalogs[0].code,'offline');assert.deepEqual(result.catalogs[0].models,[]);
});
test('068.1 不相信客户端续期、原始地址、key和扩展字段',async()=>{
 const payload={...sample,received_at:'2099-01-01',checked_at:'2099-01-01',key:'test-token-not-real-hidden-068',baseUrl:'http://private.invalid'};
 await report(payload);
 const raw=(D.db().prepare('SELECT model_catalog FROM runners WHERE id=?').get('catalog-test') as any).model_catalog;
 assert.equal(raw.includes('2099'),false);assert.equal(raw.includes('hidden-068'),false);assert.equal(raw.includes('private.invalid'),false);
 assert.ok(Math.abs(Date.now()-Date.parse(JSON.parse(raw).received_at))<2000);
});
test('068.1 错误目录拒收，不回显恶意code或命令片段',async()=>{
 const bad={...sample,models:[{...sample.models[0],id:'--model=unsafe'}]};
 assert.equal((await report(bad)).status,400);
 const response=await report({...sample,code:'raw-secret-detail'});
 assert.equal(response.status,400);assert.equal((await response.text()).includes('raw-secret-detail'),false);
});
test('068.1 不可用/关闭的新快照会撤下旧候选',async()=>{
 await report();
 for(const [status,code] of [['unavailable','timeout'],['disabled','disabled']]){
  await report({status,code,models:sample.models});
  const r=await (await fetch(base+'/api/model-catalogs?executor=pool&project=demo',{headers:headers()})).json();
  assert.equal(r.catalogs[0].status,status);assert.deepEqual(r.catalogs[0].models,[]);
 }
});
test('068.1 真HTTP：假Magpie→执行器→工作台，只读取身份和目录',async()=>{
 const paths:string[]=[];let helloAuth:unknown;
 const gateway=createServer((q,s)=>{
  paths.push(q.url!);if(q.url==='/api/hello')helloAuth=q.headers.authorization;
  s.setHeader('Content-Type','application/json');s.end(JSON.stringify(q.url==='/api/hello'?{name:'magpie'}:{data:[{id:'vendor/a',owned_by:'vendor'}]}));
 });
 await new Promise<void>(resolve=>gateway.listen(0,'127.0.0.1',resolve));
 try{
  const report=createCatalogReporter({magpie:{enabled:true,baseUrl:'http://127.0.0.1:'+(gateway.address() as any).port,executors:{pool:['vendor/a']},projects:{demo:['vendor/a']}}},'catalog-test',async(method,path,body)=>{
   const r=await fetch(base+path,{method,headers:headers(),body:JSON.stringify(body)});assert.equal(r.status,200);
  });
  await report();
  const result=await (await fetch(base+'/api/model-catalogs?executor=pool&project=demo',{headers:headers()})).json();
  assert.equal(result.catalogs[0].models[0].id,'vendor/a');
  assert.deepEqual(paths,['/api/hello','/v1/models']);assert.equal(helloAuth,undefined);
 }finally{await new Promise<void>(resolve=>gateway.close(()=>resolve()));}
});
test('068.1 旧库只追加列，原执行器和meta保留，重复打开安全',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wb-model068-'));
 const file=join(dir,'old.db');
 try{
  const old=D.openDb(file,{at:D.versionAfter('ADD COLUMN model_catalog')-1});
  old.prepare('INSERT INTO runners(id,last_seen,meta) VALUES(?,?,?)').run('legacy','2026-11-13T00:00:00Z','{"executors":["pool"]}');old.close();
  for(let i=0;i<2;i++){
   const upgraded=D.openDb(file);const row=upgraded.prepare('SELECT * FROM runners WHERE id=?').get('legacy') as any;
   assert.equal(row.model_catalog,'');assert.equal(row.meta,'{"executors":["pool"]}');upgraded.close();
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
