import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.WB_DB=':memory:';
const {openDb,useDb,db}=await import('../src/db.ts');
const {qualified,nextCandidate}=await import('../src/services/brain.ts');
test('042 审计红测：只读活可以回退给具备读写能力的合格执行者',()=>{
 useDb(openDb(':memory:'));
 db().prepare('UPDATE executor_settings SET enabled=0').run();
 db().prepare("UPDATE executor_settings SET enabled=1,claimable=1,categories='dev',resting=0 WHERE executor='pool'").run();
 assert.deepEqual(qualified('dev').candidates.map(c=>c.executor),['pool'],'先证明pool合格，不是额度或停用问题');
 assert.equal(nextCandidate('dev',[],true)?.executor,'pool');
});
