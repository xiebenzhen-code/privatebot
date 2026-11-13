import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {makeWorktree,restorePatch} from '../scripts/runner.mjs';
import {applySandboxPatch,SANDBOX_SCRIPTS} from '../scripts/lib/sandbox/run.mjs';

// Codex 原红测（07890ba）手工拿 main..HEAD 当沙箱补丁，复现了「上一版被再加一遍、套不上」。
// 修法是沙箱恢复上一版后从恢复点（wb-base）起算补丁。这里改成真的跑容器里那两段脚本（RESTORE、HARVEST），
// 在一份从 main 克隆的仓库里走一遍，再套到实际创建的宿主工作目录上。没有 sh 的机器跳过。
const hasSh=spawnSync('sh',['-c','exit 0'],{windowsHide:true}).status===0;

test('062 沙箱第二版：恢复上一版后只交这一轮的改动，能套到带着上一版的宿主工作目录',{skip:!hasSh&&'没有 sh'},()=>{
 const root=mkdtempSync(join(tmpdir(),'wb062-second-base-'));const repo=join(root,'repo');const box=join(root,'box');
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();
 const sh=(script,...args)=>{const r=spawnSync('sh',['-c',script,'sh',...args],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);};
 let host;
 try{
  execFileSync('git',['init','-q','-b','main',repo],{windowsHide:true});
  git(repo,'config','core.autocrlf','false');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@localhost');
  git(repo,'commit','--allow-empty','-qm','main');
  // 第一版：wb/T-7 上新增 answer.txt
  git(repo,'checkout','-qb','wb/T-7');writeFileSync(join(repo,'answer.txt'),'first version\n');git(repo,'add','answer.txt');git(repo,'commit','-qm','first');
  git(repo,'checkout','-q','main');
  // 沙箱：从 main 克隆，放进完整的上一版补丁，跑 RESTORE
  execFileSync('git',['clone','-q','--branch','main',repo,box],{windowsHide:true});
  git(box,'config','core.autocrlf','false'); // 克隆不继承 repo 的本地设置；Windows 全局 autocrlf=true 会把 answer.txt 检出成 CRLF
  git(box,'config','user.name','S');git(box,'config','user.email','s@localhost');git(box,'checkout','-qb','wb/T-7-2');
  mkdirSync(join(box,'.wb'));writeFileSync(join(box,'.git','info','exclude'),'.wb/\n',{flag:'a'});
  writeFileSync(join(box,'.wb','previous.patch'),restorePatch(repo,'wb/T-7'));
  sh(SANDBOX_SCRIPTS.RESTORE,box);
  assert.equal(readFileSync(join(box,'answer.txt'),'utf8'),'first version\n');
  // 第二版：改 answer.txt，再新增一个文件；跑 HARVEST（它写 /work/out.patch，这里换个位置）
  writeFileSync(join(box,'answer.txt'),'second version\n');writeFileSync(join(box,'extra.txt'),'new\n');
  const out=join(root,'out.patch');
  sh(SANDBOX_SCRIPTS.HARVEST.replace('/work/out.patch',out.replace(/\\/g,'/')),'T-7 second',box);
  const patch=readFileSync(out);
  assert.ok(!/new file mode[^\n]*\n[^\n]*\n--- \/dev\/null\n\+\+\+ b\/answer\.txt/.test(patch.toString('utf8')),'answer.txt 不该再被当成新文件加一遍');
  // 宿主：和执行器一样，从上一版分支起
  host=makeWorktree(repo,join(root,'work'),7,git,'wb/T-7');
  const result=applySandboxPatch({dir:host.dir,patch,taskId:7,gitRun:git,rejectsDir:join(root,'reject')});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(readFileSync(join(host.dir,'answer.txt'),'utf8'),'second version\n');
  assert.equal(readFileSync(join(host.dir,'extra.txt'),'utf8'),'new\n');
 }finally{
  if(host?.dir){try{git(repo,'worktree','remove','--force',host.dir)}catch{}}
  rmSync(root,{recursive:true,force:true});
 }
});

test('062 沙箱：没要求恢复时，HARVEST 照旧从 main 算起',{skip:!hasSh&&'没有 sh'},()=>{
 assert.match(SANDBOX_SCRIPTS.HARVEST,/base=main; if git rev-parse -q --verify refs\/tags\/wb-base/);
 assert.match(SANDBOX_SCRIPTS.RESTORE,/git tag wb-base'?$/);
});
