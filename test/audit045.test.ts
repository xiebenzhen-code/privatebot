import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chooseSlot,ensureHookConfig} from '../scripts/runner.mjs';
test('045 审计红测：账号槽目录联接不得让钩子写出 slotsRoot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wb-audit045-link-'));
 try{
  const root=join(dir,'slots'),outside=join(dir,'outside');mkdirSync(root);mkdirSync(outside);
  symlinkSync(outside,join(root,'slot-a'),process.platform==='win32'?'junction':'dir');
  const slot=chooseSlot({slots:[{name:'claude-a',slot_dir:'slot-a'}]},{slotsRoot:root});
  if(slot)ensureHookConfig({},slot.dir);
  assert.equal(existsSync(join(outside,'settings.json')),false,'不应在槽根目录外写入settings.json');
  assert.equal(slot,null,'链接槽应被拒绝');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
