import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_MODELS,MAX_CATALOG_BYTES,normalizeCatalog,normalizePolicy,parseModelDirectory,permittedModels} from '../scripts/lib/model-catalog-core.mjs';
import {createCatalogReporter,discoverMagpie,magpieUrl} from '../scripts/lib/magpie-catalog.mjs';
const cfg=()=>({enabled:true,executors:{pool:['vendor/a','vendor/b']},projects:{demo:['vendor/a']}});
const row=(id='vendor/a')=>({id,display_name:'模型 <A>',owned_by:'vendor',reasoning_levels:['high','high','xhigh'],context_window:128000});
const json=(x:unknown,init:ResponseInit={})=>new Response(JSON.stringify(x),init);

test('068 目录元数据有界，重复推理档位去重，未知字段不保留',()=>{
 const rows=parseModelDirectory({data:[{...row(),token:'test-do-not-copy',env:{unused:true}}]});
 assert.deepEqual(rows,[{id:'vendor/a',label:'模型 <A>',provider:'vendor',reasoning_levels:['high','xhigh'],context_window:128000}]);
});
test('068 目录拒绝命令片段、选项、控制/零宽字符和非字符串id',()=>{
 const bad=['--model=x','vendor/$(whoami)','vendor/`cmd`','vendor/a;pwd','vendor/has space','vendor/a\u200b','vendor/a\n'];
 assert.deepEqual(parseModelDirectory({data:bad.map(id=>row(id))}),[]);
 assert.deepEqual(parseModelDirectory({data:[{...row(),id:23},{...row(),display_name:'bad\nlabel'}]}),[]);
});
test('068 同名目录两份都不信，不让顺序决定哪份元数据生效',()=>{
 assert.deepEqual(parseModelDirectory({data:[row(),{...row(),owned_by:'other'},row('vendor/b')]}).map(x=>x.id),['vendor/b']);
});
test('068 巨量目录拒收，未知上下文不猜',()=>{
 assert.throws(()=>parseModelDirectory({data:Array.from({length:MAX_MODELS+1},(_,i)=>row('v/m'+i))}),/too_large/);
 const [m]=parseModelDirectory({data:[{...row(),context_window:'128000'}]});
 assert.equal('context_window' in m,false);
});
test('068 授权是精确交集，目录不是权限，也不把通配符当授权',()=>{
 const models=permittedModels(parseModelDirectory({data:[row(),row('vendor/b'),row('other/c')]}),normalizePolicy(cfg()));
 assert.deepEqual(models.map(x=>({id:x.id,executors:x.executors,projects:x.projects})),[{id:'vendor/a',executors:['pool'],projects:['demo']}]);
 assert.throws(()=>normalizePolicy({...cfg(),projects:{demo:['*']}}),/invalid_config/);
 assert.equal(permittedModels(parseModelDirectory({data:[row()]}),normalizePolicy({executors:{},projects:{}})).length,0);
});
test('068 目录快照不保存URL、key、未知字段；不可用时强制清空',()=>{
 const model={...row(),executors:['pool'],projects:['demo']};
 const snapshot=normalizeCatalog({status:'ok',code:'ok',models:[model],key:'do-not-copy',url:'http://unused',received_at:'2099'});
 assert.equal(JSON.stringify(snapshot).includes('do-not-copy'),false);
 assert.equal('received_at' in snapshot,false);
 assert.deepEqual(normalizeCatalog({status:'unavailable',code:'timeout',models:[model]}).models,[]);
 assert.throws(()=>normalizeCatalog({status:'ok',code:'secret-error',models:[]}),/invalid_catalog/);
});
test('068 不接受网关URL凭据、外网、路径、查询串、片段和非HTTP协议',()=>{
 for(const url of ['http://example.com','http://127.0.0.2','http://127.0.0.1.evil','http://user:pass@localhost','file:///tmp','http://localhost/v1','http://localhost/?x=1','http://localhost/#x'])assert.throws(()=>magpieUrl(url));
 assert.equal(magpieUrl(),'http://127.0.0.1:3425');
 assert.equal(magpieUrl('http://[::1]:4567'),'http://[::1]:4567');
});
test('068 未配置/关闭时不做任何HTTP请求',async()=>{
 let calls=0; const fetchImpl=async()=>{calls++;throw Error('must not call');};
 assert.equal((await discoverMagpie(undefined,{fetchImpl})).status,'disabled');
 assert.equal((await discoverMagpie({enabled:false},{fetchImpl})).status,'disabled');
 assert.equal(calls,0);
});
test('068 身份确认前不发凭据，只GET两个固定端点',async()=>{
 const calls:{url:string;init:any}[]=[];
 const result=await discoverMagpie({...cfg(),keyEnv:'MAGPIE_GATEWAY_KEY'}, {env:{MAGPIE_GATEWAY_KEY:'test-token-not-real-068-gateway'},fetchImpl:async(url,init)=>{
  calls.push({url,init});return url.endsWith('/api/hello')?json({name:'magpie',version:'test'}):json({data:[row(),row('vendor/b')]});
 }});
 assert.equal(result.status,'ok');assert.deepEqual(result.models.map(x=>x.id),['vendor/a']);
 assert.deepEqual(calls.map(c=>[c.url,c.init.method,c.init.redirect]),[['http://127.0.0.1:3425/api/hello','GET','error'],['http://127.0.0.1:3425/v1/models','GET','error']]);
 assert.equal(calls[0].init.headers.Authorization,undefined);
 assert.match(calls[1].init.headers.Authorization,new RegExp('^Bearer '+'test-token-not-real'));
 assert.equal(JSON.stringify(result).includes('test-token-not-real'),false);
});
test('068 假身份不继续读目录，错误也不泄露配置key',async()=>{
 let calls=0;
 const result=await discoverMagpie({...cfg(),keyEnv:'MAGPIE_GATEWAY_KEY'},{env:{MAGPIE_GATEWAY_KEY:'test-token-not-real-068-secret'},fetchImpl:async()=>{calls++;return json({name:'other-service'});}});
 assert.equal(result.code,'identity');assert.equal(calls,1);assert.deepEqual(result.models,[]);
});
test('068 缺专用凭据、借用工作台变量或非法配置时不联网',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error('not called');};
 assert.equal((await discoverMagpie({...cfg(),keyEnv:'MAGPIE_GATEWAY_KEY'},{env:{},fetchImpl})).code,'missing_key');
 assert.equal((await discoverMagpie({...cfg(),keyEnv:'WB_TOKEN'},{fetchImpl})).code,'invalid_config');
 assert.equal((await discoverMagpie({...cfg(),baseUrl:'http://evil.invalid'},{fetchImpl})).code,'invalid_config');
 assert.equal(calls,0);
});
test('068 上游错误原文和回显的key不进入目录',async()=>{
 const key='test-token-not-real-068-secret';let i=0;
 const result=await discoverMagpie({...cfg(),keyEnv:'MAGPIE_GATEWAY_KEY'},{env:{MAGPIE_GATEWAY_KEY:key},fetchImpl:async()=>++i===1?json({name:'magpie'}):json({data:[{...row(),display_name:key},row('vendor/b')]})});
 assert.equal(JSON.stringify(result).includes(key),false);
 const failed=await discoverMagpie(cfg(),{fetchImpl:async()=>{throw Error('Authorization: '+key);}});
 assert.deepEqual(failed,{status:'unavailable',code:'unreachable',models:[]});
});
test('068 HTTP鉴权、限流、服务错误和重定向不当登录成功',async()=>{
 for(const [status,code] of [[401,'unauthorized'],[403,'unauthorized'],[429,'rate_limited'],[500,'http_error'],[302,'http_error']] as const){
  const result=await discoverMagpie(cfg(),{fetchImpl:async()=>json({name:'magpie'},{status})});
  assert.equal(result.code,code);assert.deepEqual(result.models,[]);
 }
});
test('068 HTTP200但不是JSON或没有data数组不算可用',async()=>{
 assert.equal((await discoverMagpie(cfg(),{fetchImpl:async()=>new Response('<html>login</html>')})).code,'invalid_catalog');
 let i=0;assert.equal((await discoverMagpie(cfg(),{fetchImpl:async()=>++i===1?json({name:'magpie'}):json({models:[row()]})})).code,'invalid_catalog');
});
test('068 声明和实际响应体均有上限，不无限收内存',async()=>{
 let canceled=false;
 const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_CATALOG_BYTES+1));},cancel(){canceled=true;}});
 const result=await discoverMagpie(cfg(),{fetchImpl:async()=>new Response(body)});
 assert.equal(result.code,'too_large');assert.equal(canceled,true);
 const hinted=await discoverMagpie(cfg(),{fetchImpl:async()=>new Response('{}',{headers:{'content-length':String(MAX_CATALOG_BYTES+1)}})});
 assert.equal(hinted.code,'too_large');
});
test('068 即使fetch或响应体挂住，也在时限内返回并取消',async()=>{
 const t=Date.now();
 const stalled=await discoverMagpie(cfg(),{timeoutMs:50,fetchImpl:()=>new Promise(()=>{})});
 assert.equal(stalled.code,'timeout');assert.ok(Date.now()-t<2000);
 let canceled=false;
 const body=new ReadableStream({pull(){},cancel(){canceled=true;}});
 const bodyResult=await discoverMagpie(cfg(),{timeoutMs:50,fetchImpl:async()=>new Response(body)});
 assert.equal(bodyResult.code,'timeout');assert.equal(canceled,true);
});
test('068 刷新合并、不把配置凭据传给工作台；失败后可重试',async()=>{
 let probes=0;const reports:any[]=[];let release:()=>void=()=>{};
 const gate=new Promise<void>(r=>{release=r;});
 const report=createCatalogReporter({magpie:cfg()},'runner-a',async(...args)=>{reports.push(args);},{discover:async()=>{probes++;await gate;return {status:'ok',code:'ok',models:[]};}});
 const a=report(),b=report();release();await Promise.all([a,b]);
 assert.equal(probes,1);assert.equal(reports.length,1);
 assert.deepEqual(reports[0],['POST','/api/runner/models',{runner:'runner-a',catalog:{status:'ok',code:'ok',models:[]}}]);
 let attempts=0;const retry=createCatalogReporter({magpie:cfg()},'runner-a',async()=>{if(++attempts===1)throw Error('failed');},{discover:async()=>({status:'disabled',code:'disabled',models:[]})});
 await assert.rejects(retry());await retry();assert.equal(attempts,2);
});
test('068 旧配置没有magpie时连工作台上报也不新增',async()=>{
 let calls=0;const report=createCatalogReporter({},'r',async()=>{calls++;},{discover:async()=>{throw Error('must not call');}});
 assert.equal(await report(),false);assert.equal(calls,0);
});
test('068 上报前再做白名单校验，不让未来适配器扩展字段带出凭据',async()=>{
 let payload:any;
 const report=createCatalogReporter({magpie:cfg()},'r',async(_m,_p,body)=>{payload=body;},{discover:async()=>({status:'ok',code:'ok',models:[],key:'test-token-not-real-adapter'})});
 await report();assert.equal(JSON.stringify(payload).includes('adapter'),false);
});
test('068 专用网关环境变量不自动继承给编码工具',async()=>{
 const {childEnv}=await import('../scripts/runner.mjs');
 const env=childEnv({PATH:'/bin',MAGPIE_GATEWAY_KEY:'test-token-not-real-068-child'},{});
 assert.equal(env.PATH,'/bin');assert.equal(env.MAGPIE_GATEWAY_KEY,undefined);
});
