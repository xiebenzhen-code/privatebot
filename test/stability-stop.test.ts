import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {loginCookie} from './helpers.ts';
process.env.WB_DB=':memory:';process.env.WB_TOKEN='test-token-stability-not-real';process.env.WB_PASSWORD='test-password-stability-not-real';
const D=await import('../src/db.ts');const T=await import('../src/services/tasks.ts');const R=await import('../src/services/runner.ts');const U=await import('../src/services/runs.ts');const {handle}=await import('../src/app.ts');
let server:any,base='',cookie='';
before(async()=>{D.useDb(D.openDb(':memory:'));server=createServer((q,s)=>void handle(q,s));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
beforeEach(async()=>{D.useDb(D.openDb(':memory:'));cookie=await loginCookie(base,process.env.WB_PASSWORD!);});
after(()=>server.close());
function running(){const t=T.createTask({title:'稳定性收尾',executor:'pool',project:'demo',status:'queued',mode:'manual'},'me');T.updateTask(t.id,{start_requested:1},'me');const claimed=R.claimTask(['pool'],'test-runner')!;assert.ok(claimed);return{t:claimed,run:U.openRunOf(t.id)!};}
const post=(id:number,action:string,bearer=false)=>fetch(base+'/api/tasks/'+id+'/'+action,{method:'POST',headers:bearer?{Authorization:'Bearer '+process.env.WB_TOKEN}:{Cookie:cookie}});
test('稳定性：用户终止同时关闭本次run，保留已报用量',async()=>{const{t,run}=running();U.setRunTokens(t.id,23);assert.equal((await post(t.id,'stop')).status,200);const saved=U.listRuns(t.id).find(x=>x.id===run.id)!;assert.notEqual(saved.outcome,'running');assert.ok(saved.ended_at);assert.equal(saved.tokens,23);assert.equal(T.getTask(t.id)!.status,'failed');});
test('稳定性：人工标记失联失败也关闭run',async()=>{const{t}=running();assert.equal((await post(t.id,'mark-failed')).status,200);assert.equal(U.openRunOf(t.id),undefined);});
test('稳定性：被终止的run迟到完成不生成审批、不改用户终止结论',async()=>{const{t,run}=running();await post(t.id,'stop');const result=R.finishTask(t.id,{run_id:run.id,result:'done',branch:'wb/T-'+t.id,commit:'a'.repeat(40)} as any);assert.equal(result.task.status,'failed');assert.equal(D.db().prepare('select count(*) n from approvals where task_id=?').get(t.id)!.n,0);});
test('稳定性：旧run迟到进度/完成不得覆盖重跑的新run',async()=>{const{t,run}=running();await post(t.id,'stop');T.updateTask(t.id,{status:'queued',start_requested:1},'me');const newer=R.claimTask(['pool'],'test-runner')!;const live=U.openRunOf(t.id)!;assert.notEqual(live.id,run.id);R.reportProgress(t.id,{run_id:run.id,step:'过期进度',tokens_used:999});R.finishTask(t.id,{run_id:run.id,result:'failed',summary:'旧失败'} as any);assert.equal(T.getTask(t.id)!.status,'running');assert.notEqual(T.getTask(t.id)!.step,'过期进度');assert.equal(U.openRunOf(newer.id)!.id,live.id);assert.equal(U.openRunOf(newer.id)!.tokens,0);});
test('稳定性：脚本令牌仍不能代人终止任务',async()=>{const{t}=running();assert.equal((await post(t.id,'stop',true)).status,403);assert.equal(T.getTask(t.id)!.status,'running');});
test('稳定性：启动核对只修补旧终态残留，幂等且不碰真正运行中的任务',()=>{const{t,run}=running();D.db().prepare("update tasks set status='failed',step='用户终止了任务' where id=?").run(t.id);const other=T.createTask({title:'还在执行',executor:'pool',status:'running'},'me');const second=U.openRun(other.id,'pool','me');assert.equal(typeof (U as any).reconcileRuns,'function');assert.equal((U as any).reconcileRuns(),1);assert.notEqual(U.listRuns(t.id).find(x=>x.id===run.id)!.outcome,'running');assert.equal(U.openRunOf(other.id)!.id,second.id);assert.equal((U as any).reconcileRuns(),0);});
test('稳定性：旧run迟到预算回报不能给重跑任务加预算审批',async()=>{const{t,run}=running();await post(t.id,'stop');T.updateTask(t.id,{status:'queued',start_requested:1},'me');R.claimTask(['pool'],'test-runner');const res=await fetch(base+'/api/runner/tasks/'+t.id+'/budget',{method:'POST',headers:{Authorization:'Bearer '+process.env.WB_TOKEN,'content-type':'application/json'},body:JSON.stringify({run_id:run.id,tokens:99_000_000})});assert.equal(res.status,200);assert.equal((await res.json()).gated,false);assert.equal(D.db().prepare('select count(*) n from approvals where task_id=?').get(t.id)!.n,0);});
test('稳定性：真实假CLI运行中点终止，10秒巡检后整棵树退出且不复活任务',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const client=await import('../scripts/runner.mjs');const {killTree}=await import('../scripts/lib/verify.mjs');
 const root=mkdtempSync(join(tmpdir(),'wb-stop-live-'));const repo=join(root,'repo'),marker=join(root,'worker.pid'),desc=join(root,'child.pid');mkdirSync(repo);
 const git=(...args:string[])=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);};
 const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
 let job:Promise<void>|undefined;
 try{
  git('init','-q','-b','main');git('config','user.name','Test');git('config','user.email','you@example.com');writeFileSync(join(repo,'README.md'),'test\n');git('add','.');git('commit','-qm','init');
  const fake=join(root,'fake.cjs');writeFileSync(fake,`const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');writeFileSync(${JSON.stringify(marker)},String(process.pid));const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(desc)},String(c.pid));setInterval(()=>{},1000);`);
  const {t}=running();job=client.runTask({workbench:base,token:process.env.WB_TOKEN,projects:{demo:repo},worktreeRoot:join(root,'wt'),claudeConfigDir:join(root,'cfg'),executors:{pool:{tool:process.execPath,args:[fake]}},maxMinutes:1,verify:false},t);
  const end=Date.now()+10000;while(!existsSync(desc)&&Date.now()<end)await new Promise(r=>setTimeout(r,50));assert.ok(existsSync(desc),'假CLI和后代已经启动');
  assert.equal((await post(t.id,'stop')).status,200);let timeout:any;try{await Promise.race([job,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('停止后20秒仍未结束')),20000)})]);}finally{clearTimeout(timeout)}
  assert.equal(T.getTask(t.id)!.status,'failed');assert.equal(U.openRunOf(t.id),undefined);assert.equal(alive(Number(readFileSync(marker,'utf8'))),false);assert.equal(alive(Number(readFileSync(desc,'utf8'))),false);assert.equal(D.db().prepare('select count(*) n from approvals where task_id=?').get(t.id)!.n,0);
 }finally{for(const p of [marker,desc])if(existsSync(p)){const pid=Number(readFileSync(p,'utf8'));if(alive(pid))killTree({pid,kill:()=>process.kill(pid,'SIGKILL')});}if(job)await job.catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
test('稳定性：上一轮CLI尚在退出时不重复领取同一任务',async()=>{const{t}=running();await post(t.id,'stop');T.updateTask(t.id,{status:'queued',start_requested:1},'me');assert.equal((R.claimTask as any)(['pool'],'test-runner',[],[t.id]),null);assert.match(T.getTask(t.id)!.step,/收尾/);assert.ok((R.claimTask as any)(['pool'],'test-runner',[],[]));});
test('稳定性：终止后的CLI尚未退出仍占本执行者编码名额',async()=>{const{t}=running();await post(t.id,'stop');D.db().prepare("update executor_settings set max_concurrent=1 where executor='pool'").run();const next=T.createTask({title:'下一件',executor:'pool',project:'demo',status:'queued'},'me');T.updateTask(next.id,{start_requested:1},'me');assert.equal((R.claimTask as any)(['pool'],'test-runner',[],[t.id]),null);assert.equal((R.claimTask as any)(['pool'],'test-runner',[],[])!.id,next.id);});
