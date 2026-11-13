import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
process.env.WB_DB=':memory:';
process.env.WB_TOKEN='test-token-062-http-not-real';
process.env.WB_PASSWORD='test-password-062-http-only';
test('062 审过的合并审批通过真实 HTTP 仍拒绝脚本令牌',async()=>{
 const d=await import('../src/db.ts');d.useDb(d.openDb(':memory:'));
 const t=await import('../src/services/tasks.ts');
 const r=await import('../src/services/runner.ts');
 const a=await import('../src/services/approvals.ts');
 const {handle}=await import('../src/app.ts');
 for(const e of ['codex','claude'])d.db().prepare('UPDATE executor_settings SET enabled=1 WHERE executor=?').run(e);
 const parent=t.createTask({title:'验收',executor:'codex',project:'demo'},'me');
 d.db().prepare("UPDATE tasks SET reviewer='claude',status='running' WHERE id=?").run(parent.id);
 r.finishTask(parent.id,{result:'done',branch:'wb/T-'+parent.id,changed_files:['a.md']});
 const child=d.db().prepare('SELECT id FROM tasks WHERE review_of=?').get(parent.id);
 d.db().prepare("UPDATE tasks SET status='running' WHERE id=?").run(child.id);
 r.finishTask(child.id,{result:'done',no_changes:true,result_text:'```wb-review\n{"verdict":"过","summary":"通过","items":[]}\n```'});
 const approval=a.listApprovals({task_id:parent.id}).find(x=>x.tool_name==='git merge');
 assert.equal(t.getTask(parent.id).review_state,'passed');assert.equal(approval.status,'pending');
 const server=createServer((req,res)=>void handle(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/approvals/'+approval.id+'/decide',{method:'POST',headers:{Authorization:'Bearer '+process.env.WB_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved'})});
  assert.equal(res.status,403);assert.equal(a.listApprovals({task_id:parent.id}).find(x=>x.id===approval.id).status,'pending');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
