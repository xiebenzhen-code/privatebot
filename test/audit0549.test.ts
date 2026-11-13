import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selfCheck} from '../scripts/runner.mjs';

test('054.9 审计红测：BOM 配置保留技能钩子且自检成功',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wb-audit0549-bom-'));
 try{
  const skill=[{hooks:[{type:'command',command:'echo test-skill-not-executed'}]}];
  writeFileSync(join(dir,'settings.json'),'\uFEFF'+JSON.stringify({hooks:{SessionStart:skill}}));
  const result=selfCheck({claudeConfigDir:dir});
  assert.equal(result.ok,true,result.reason);
  const saved=JSON.parse(readFileSync(join(dir,'settings.json'),'utf8'));
  assert.deepEqual(saved.hooks.SessionStart,skill);
  assert.match(saved.hooks.PreToolUse[0].hooks[0].command,/claude-hook\.mjs/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('054.9 审计红测：坏 JSON 先原样备份，再恢复审批钩子并提示',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wb-audit0549-json-'));
 try{
  writeFileSync(join(dir,'settings.json'),'{bad json');
  const result=selfCheck({claudeConfigDir:dir});
  assert.equal(result.ok,true,result.reason);
  const backups=readdirSync(dir).filter(n=>n.startsWith('settings.json.bak-'));
  assert.equal(backups.length,1);
  assert.equal(readFileSync(join(dir,backups[0]),'utf8'),'{bad json');
  assert.match(JSON.stringify(result),/已备份/);
  assert.match(JSON.parse(readFileSync(join(dir,'settings.json'),'utf8')).hooks.PreToolUse[0].hooks[0].command,/claude-hook\.mjs/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
