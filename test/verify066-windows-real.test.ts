import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runVerify} from '../scripts/lib/verify.mjs';

test('066 Windows 真实 npm test 可以启动并返回退出码',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wb066-npm-'));
 try{
  writeFileSync(join(dir,'package.json'),JSON.stringify({scripts:{test:'node test.cjs'}}));
  writeFileSync(join(dir,'test.cjs'),"console.log('VERIFY-REAL-NPM');");
  const result=await runVerify({dir,cmd:['npm','test'],timeoutMs:15000});
  assert.equal(result.status,'pass',result.tail);assert.ok(result.tail.includes('VERIFY-REAL-NPM'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('066 起进程同步抛错时应返回 error，不应因 timer 初始化抛错',async()=>{
 const result=await runVerify({dir:'.',cmd:['missing'],timeoutMs:1000,spawnFn(){throw new Error('simulated spawn failure')}});
 assert.equal(result.status,'error');assert.ok(result.tail.includes('simulated spawn failure'));
});

test('066 Windows 超时应结束 npm test 的实际测试进程，心跳定时器持续运行',{skip:process.platform!=='win32'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wb066-timeout-'));
 let pid=0;let parent=0;let beats=0;const beat=setInterval(()=>beats++,50);
 try{
  writeFileSync(join(dir,'package.json'),JSON.stringify({scripts:{test:'node hang.cjs'}}));
  writeFileSync(join(dir,'hang.cjs'),"require('fs').writeFileSync('probe.pid',JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000)");
  const result=await runVerify({dir,cmd:['npm','test'],timeoutMs:3000});
  assert.equal(result.status,'timeout');assert.ok(beats>20,'核验期间事件循环必须继续响应');
  assert.ok(existsSync(join(dir,'probe.pid')),'必须实际启动测试进程');
  const identity=JSON.parse(readFileSync(join(dir,'probe.pid'),'utf8'));pid=identity.pid;parent=identity.parent;
  await new Promise(resolve=>setTimeout(resolve,300));
  let alive=true;try{process.kill(pid,0)}catch{alive=false}
  assert.equal(alive,false,'npm shell 退出后，实际测试进程不能残留');
 }finally{
  clearInterval(beat);
  if(parent)spawnSync('taskkill',['/PID',String(parent),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  if(pid){try{process.kill(pid,'SIGKILL')}catch{}}
  rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
});
