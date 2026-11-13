import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {restorePatch} from '../scripts/runner.mjs';
// 没装 Docker（或没起）的机器上跳过；这条是真容器验收，不是单元测试。
const hasDocker=(()=>{try{execFileSync('docker',['version'],{stdio:'ignore',windowsHide:true,timeout:15000});return true;}catch{return false;}})();
test('062 真容器恢复上一版二进制与 GBK，完整补丁保留上一版',{skip:!hasDocker&&'没有可用的 Docker'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'wb062-container-'));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',windowsHide:true});
 const binary=Buffer.from([0,1,2,255,128,42]);
 const gbk=Buffer.from([0xd6,0xd0,0xce,0xc4,0x0a]);
 try {
  git('init','-q','-b','main');git('config','user.name','Test');git('config','user.email','test@example.com');
  git('commit','--allow-empty','-qm','base');git('checkout','-qb','wb/T-7');
  writeFileSync(join(dir,'binary.bin'),binary);writeFileSync(join(dir,'gbk.txt'),gbk);
  git('add','binary.bin','gbk.txt');git('commit','-qm','first');
  writeFileSync(join(dir,'previous.patch'),restorePatch(dir,'wb/T-7',(_cwd,...args)=>execFileSync('git',args,{cwd:dir,windowsHide:true})));
  git('bundle','create',join(dir,'main.bundle'),'main');
  const script='set -e; git clone -q --branch main /case/main.bundle /tmp/repo; cd /tmp/repo; git checkout -qb wb/T-7-2; git config user.name Test; git config user.email test@example.com; mkdir .wb; echo ".wb/" >> .git/info/exclude; cp /case/previous.patch .wb/previous.patch; git apply --check --index .wb/previous.patch; git apply --index .wb/previous.patch; git commit -qm first; cmp binary.bin /case/binary.bin; cmp gbk.txt /case/gbk.txt; echo second > second.txt; git add -A; git commit -qm second; git diff --binary --full-index main..HEAD > /case/out.patch; git ls-files > /case/tracked';
  execFileSync('docker',['run','--rm','--network','none','--mount','type=bind,source='+dir+',target=/case','node:24-bookworm','sh','-c',script],{encoding:'utf8',windowsHide:true});
  const patch=readFileSync(join(dir,'out.patch'),'utf8');
  assert.ok(patch.includes('binary.bin')&&patch.includes('gbk.txt')&&patch.includes('second.txt'));
  assert.ok(!readFileSync(join(dir,'tracked'),'utf8').includes('.wb/'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
