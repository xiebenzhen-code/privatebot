import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WB_DB=':memory:';
process.env.WB_PASSWORD='test-password-migration-only';
test('062 旧库升级创建 task_says，老线程以 result_text 回退', async () => {
 const {openDb,useDb,versionAfter}=await import('../src/db.ts');
 const {createTask,getTask}=await import('../src/services/tasks.ts');
 const {threadPanel}=await import('../src/views/thread.ts');
 const root=mkdtempSync(join(tmpdir(),'wb062-migration-'));
 const file=join(root,'old.db');
 let db;
 try {
  db=openDb(file,{at:versionAfter('CREATE TABLE task_says')-1}); useDb(db);
  const task=createTask({title:'旧任务',executor:'codex'},'me');
  db.prepare("UPDATE tasks SET result_text='OLD-RESULT-062', status='done' WHERE id=?").run(task.id);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='task_says'").get(),undefined);
  db.close();
  db=openDb(file); useDb(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='task_says'").get());
  assert.ok(String(threadPanel(getTask(task.id))).includes('OLD-RESULT-062'));
 } finally {db?.close();rmSync(root,{recursive:true,force:true});}
});
