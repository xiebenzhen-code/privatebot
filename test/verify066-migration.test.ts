import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.WB_DB=':memory:';
test('066 旧库升级后 tasks.verify 默认空串',async()=>{
 const d=await import('../src/db.ts');const t=await import('../src/services/tasks.ts');
 const root=mkdtempSync(join(tmpdir(),'wb066-migration-'));const file=join(root,'old.db');let db;
 try{
  db=d.openDb(file,{at:d.versionAfter('ALTER TABLE tasks ADD COLUMN verify')-1});d.useDb(db);
  const task=t.createTask({title:'旧任务',executor:'codex'},'me');
  db.close();db=d.openDb(file);
  assert.equal(db.prepare('SELECT verify FROM tasks WHERE id=?').get(task.id).verify,'');
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
