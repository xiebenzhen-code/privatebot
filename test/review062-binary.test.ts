import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { restorePatch, reviewPatch } from '../scripts/runner.mjs';
test('062 沙箱上一版补丁应能恢复二进制文件', () => {
 const root=mkdtempSync(join(tmpdir(),'wb-062-binary-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
 try {
  git('init','-q','-b','main');
  git('-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-qm','base');
  git('checkout','-qb','wb/T-7');
  writeFileSync(join(root,'asset.bin'),Buffer.from([0,1,2,3,4]));
  git('add','asset.bin');
  git('-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','asset');
  const patch=restorePatch(root,'wb/T-7',(_cwd,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true})); // 不能 trim：二进制段靠末尾空行收尾
  assert.ok(!reviewPatch(root,'wb/T-7',(_cwd,...args)=>git(...args)).includes('GIT binary patch'),'给人看的那份不带二进制段');
  git('checkout','-q','main');
  const result=spawnSync('git',['apply','--index','-'],{cwd:root,input:patch,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr); assert.deepEqual(readFileSync(join(root,"asset.bin")), Buffer.from([0,1,2,3,4]));
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('062 恢复补丁：改过的二进制文件逐字节恢复，不走截断', () => {
 const root=mkdtempSync(join(tmpdir(),'wb-062-binary2-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});
 const id=['-c','user.name=Test','-c','user.email=test@example.com'];
 const v1=Buffer.alloc(4096); for(let i=0;i<v1.length;i++)v1[i]=(i*7)%256;
 const v2=Buffer.from(v1); v2[100]=0; v2[2000]=255; const big=randomBytes(400_000);
 try {
  git('init','-q','-b','main'); git('config','core.autocrlf','false');
  writeFileSync(join(root,'icon.png'),v1); git('add','icon.png'); git(...id,'commit','-qm','base');
  git('checkout','-qb','wb/T-7-2');
  writeFileSync(join(root,'icon.png'),v2); writeFileSync(join(root,'big.bin'),big); writeFileSync(join(root,'note.md'),'字\n'); writeFileSync(join(root,'gbk.txt'),Buffer.from([0xd6,0xd0,0xce,0xc4,0x0a]));
  git('add','-A'); git(...id,'commit','-qm','v1');
  const patch=restorePatch(root,'wb/T-7-2'); // 默认按字节取
  assert.ok(patch.length>300_000,'超过可读补丁的上限也完整');
  git('checkout','-q','main');
  const check=spawnSync('git',['apply','--check','--index','-'],{cwd:root,input:patch,windowsHide:true});
  assert.equal(check.status,0,String(check.stderr));
  const result=spawnSync('git',['apply','--index','-'],{cwd:root,input:patch,windowsHide:true});
  assert.equal(result.status,0,String(result.stderr));
  assert.deepEqual(readFileSync(join(root,'icon.png')),v2); assert.deepEqual(readFileSync(join(root,'big.bin')),big);
  assert.equal(readFileSync(join(root,'note.md'),'utf8'),'字\n');
  assert.deepEqual(readFileSync(join(root,'gbk.txt')),Buffer.from([0xd6,0xd0,0xce,0xc4,0x0a]),'非 UTF-8 的文本也不能坏');
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('062 恢复补丁：分支名不合规或取不到返回空串', () => {
 assert.equal(restorePatch('.','main',()=> 'x'),'');
 assert.equal(restorePatch('.','wb/T-7',()=>{throw new Error('no');}),'');
});
