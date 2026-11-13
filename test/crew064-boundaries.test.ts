import assert from 'node:assert/strict';
import { test } from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.WB_DB=':memory:';
const d=await import('../src/db.ts');
const t=await import('../src/services/tasks.ts');
const c=await import('../src/services/crew.ts');
const r=await import('../src/services/runner.ts');
const v=await import('../src/services/review.ts');
const dispatch=await import('../src/services/dispatch.ts');
function fresh(){d.useDb(d.openDb(':memory:'));d.db().prepare("UPDATE executor_settings SET enabled=0,resting=0").run();d.db().prepare("UPDATE executor_settings SET enabled=1,claimable=1 WHERE executor IN ('codex','claude')").run();}
test('064 歇着和移除均不能被派、被审或领活',()=>{
 for(const state of ['rest','out']){
  fresh();c.setCrew('codex',state,'me');
  assert.notEqual(v.chooseReviewer('claude',new Set(['codex'])).who,'codex');
  assert.notEqual(dispatch.suggestExecutor('dev','codex').executor,'codex');
  const task=t.createTask({title:'候选任务',executor:'codex',status:'queued',start_requested:1,mode:'manual'},'me');
  assert.equal(r.claimTask(['codex'],'test-064'),null);
 }
});
test('064 queued/running/asking 和正在审都拦休息移除',()=>{
 for(const status of ['queued','running','asking','reviewing']){
  fresh();
  const task=t.createTask({title:'手上有事',executor:status==='reviewing'?'claude':'codex'},'me');
  if(status==='reviewing') d.db().prepare("UPDATE tasks SET status='done',reviewer='codex',review_state='reviewing' WHERE id=?").run(task.id);
  else d.db().prepare('UPDATE tasks SET status=? WHERE id=?').run(status,task.id);
  for(const target of ['rest','out'])assert.throws(()=>c.setCrew('codex',target,'me'),e=>e.status===409);
 }
});
test('064 旧库 resting 默认0，enabled 原值不变',()=>{
 const root=mkdtempSync(join(tmpdir(),'wb064-migrate-'));const file=join(root,'old.db');let db;
 try{
  db=d.openDb(file,{at:d.versionAfter('ALTER TABLE executor_settings ADD COLUMN resting')-1});
  db.prepare("UPDATE executor_settings SET enabled=CASE WHEN executor='codex' THEN 0 ELSE 1 END").run();
  const old=db.prepare('SELECT executor,enabled FROM executor_settings ORDER BY executor').all();
  db.close();db=d.openDb(file);
  assert.deepEqual(db.prepare('SELECT executor,enabled FROM executor_settings ORDER BY executor').all(),old);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM executor_settings WHERE resting!=0').get().n,0);
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
test('064 旧 team 保存 enabled 与面板一致',()=>{
 fresh();c.setCrew('codex','rest','me');
 dispatch.saveExecutorSettings({executor:'codex',enabled:1});
 assert.equal(c.crewInfo('codex').state,'in');
 dispatch.saveExecutorSettings({executor:'codex',enabled:0});
 assert.notEqual(c.crewInfo('codex').state,'in');
});

test('064 等工具审批时仍算手上有事，不能歇或移除',()=>{
 fresh();
 const task=t.createTask({title:'等工具审批',executor:'codex'},'me');
 d.db().prepare("UPDATE tasks SET status='review' WHERE id=?").run(task.id);
 assert.throws(()=>c.setCrew('codex','rest','me'),e=>e.status===409);
});

test('064 各种忙状态真实 HTTP 409，脚本令牌 403，面板无休息移除按钮',async()=>{
 process.env.WB_TOKEN='test-token-064-extra-not-real';
 process.env.WB_PASSWORD='test-password-064-extra-only';
 const {createServer}=await import('node:http');
 const {handle}=await import('../src/app.ts');
 const server=createServer((req,res)=>void handle(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams([['password',process.env.WB_PASSWORD]]).toString(),redirect:'manual'});
  let cookie=login.headers.get('set-cookie').split(';')[0];
  const post=(token=false)=>fetch(base+'/api/crew/codex',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+process.env.WB_TOKEN}:{Cookie:cookie})},body:JSON.stringify({to:'rest'})});
  fresh();assert.equal((await post(true)).status,403);
  for(const status of ['queued','running','asking','reviewing']){
   fresh();
   const session=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams([['password',process.env.WB_PASSWORD]]).toString(),redirect:'manual'});
   cookie=session.headers.get('set-cookie').split(';')[0];
   const task=t.createTask({title:'HTTP忙状态',executor:status==='reviewing'?'claude':'codex'},'me');
   if(status==='reviewing')d.db().prepare("UPDATE tasks SET status='done',reviewer='codex',review_state='reviewing' WHERE id=?").run(task.id);
   else d.db().prepare('UPDATE tasks SET status=? WHERE id=?').run(status,task.id);
   assert.equal((await post()).status,409,status);
   const html=await(await fetch(base+'/?crew=codex',{headers:{Cookie:cookie}})).text();
   assert.ok(html.includes('data-crew-busy'));
   assert.ok(!html.includes('data-crew-act'));
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
});
