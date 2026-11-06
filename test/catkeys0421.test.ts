// 042.1：执行者的默认分类键一直写错着——`doc` 不是 `docs`，`research` 压根不是分类。
//
// 症状很隐蔽：页面上的分类下拉是从 `CATEGORIES` 生成的，所以没人能手动造出 `doc`；
// 而保存执行者设置时那段 `filter((c) => CAT_KEYS.includes(c))` 会把 `doc` 悄悄过滤掉。
// 于是这行错误数据只在「装好就没动过」的库里活着，具体后果是 `docs` 分类默认没有执行者接：
// runner 领不走、042 的大脑算出来名单为空，只能退回「等你定」。
//
// 所以这条测试守两件事：种子里的每个值都必须是合法键；老库升级时要自己改对。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATEGORIES } from '../src/domain.ts';

process.env.WB_DB = ':memory:';

let D: any;
let dispatch: any;
let brain: any;
const dirs: string[] = [];
/** Windows 上文件库不 close 就删目录会 EBUSY，所以开过的文件库都记下来，收尾先关。 */
const files: any[] = [];

before(async () => {
  D = await import('../src/db.ts');
  dispatch = await import('../src/services/dispatch.ts');
  brain = await import('../src/services/brain.ts');
});

after(() => {
  for (const db of files) { try { db.close(); } catch { /* 已经关了 */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  D.useDb(D.openDb(':memory:'));
});

const KEYS = Object.keys(CATEGORIES);

/** 一行配置摊成数组，方便断言。 */
function catsOf(executor: string): string[] {
  const row = (dispatch.listExecutorSettings() as any[]).find((s) => s.executor === executor);
  return String(row?.categories ?? '').split(',').filter(Boolean);
}

describe('042.1 分类键', () => {
  test('新库里每个执行者的分类都是合法键', () => {
    for (const s of dispatch.listExecutorSettings() as any[]) {
      for (const c of String(s.categories).split(',').filter(Boolean)) {
        assert.ok(KEYS.includes(c), `${s.executor} 写了不认识的分区「${c}」`);
      }
    }
  });

  test('合法键里有 docs，没有 doc / research', () => {
    assert.ok(KEYS.includes('docs'));
    assert.ok(!KEYS.includes('doc'));
    assert.ok(!KEYS.includes('research'));
  });

  test('docs 分类默认有人接——这是这个 bug 的全部后果', () => {
    const q = brain.qualified('docs');
    assert.ok(q.candidates.length > 0, 'docs 任务默认不该是「等你定」');
  });

  test('老库升级：doc 变 docs、research 被删、没被改的行不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cat-'));
    dirs.push(dir);
    const file = join(dir, 'workbench.db');
    // 造一个「在 042.1 之前」的库：版本停在加 brain_calls 那一条之后。
    const old = D.openDb(file, { at: D.versionAfter('brain_calls') });
    old.exec(`UPDATE executor_settings SET categories = 'dev,doc,content,research' WHERE executor = 'claude'`);
    old.exec(`UPDATE executor_settings SET categories = 'dev,doc,content' WHERE executor = 'zcode'`);
    old.exec(`UPDATE executor_settings SET categories = 'dev' WHERE executor = 'codex'`);
    old.close();

    // 只升到 042.1 为止：043 会把出厂默认值清空，那是另一条迁移的事（见 runner043 的测试）。
    const up = D.openDb(file, { at: D.versionAfter("',doc,'") });
    files.push(up);
    D.useDb(up);
    assert.deepEqual(catsOf('claude'), ['dev', 'docs', 'content'], '顺序要保住，research 要没');
    assert.deepEqual(catsOf('zcode'), ['dev', 'docs', 'content']);
    assert.deepEqual(catsOf('codex'), ['dev'], '本来没错的行不该被碰');
  });

  test('已经写对过的库再跑一遍也不会变成 docs,docs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cat-'));
    dirs.push(dir);
    const file = join(dir, 'workbench.db');
    const old = D.openDb(file, { at: D.versionAfter('brain_calls') });
    old.exec(`UPDATE executor_settings SET categories = 'dev,docs,content' WHERE executor = 'claude'`);
    old.close();

    // 只升到 042.1 为止：043 会把出厂默认值清空，那是另一条迁移的事（见 runner043 的测试）。
    const up = D.openDb(file, { at: D.versionAfter("',doc,'") });
    files.push(up);
    D.useDb(up);
    assert.deepEqual(catsOf('claude'), ['dev', 'docs', 'content']);
  });

  test('保存执行者设置时 docs 不会被过滤掉', () => {
    dispatch.saveExecutorSettings([{ executor: 'pool', categories: ['docs', 'dev'], enabled: true, priority: 3 }]);
    assert.deepEqual(catsOf('pool'), ['docs', 'dev']);
  });

  // 042.5：修这个 bug 时我顺手改了历史迁移的原文（种子 SQL 和 013 那条 UPDATE），
  // 被审查挡回来了。已上线的迁移只能追加——老库的 user_version 早就越过那几条，
  // 改它们对老库一点用都没有，只会让「同一个版本号在不同机器上跑出不同 schema」。
  test('历史迁移原文没被动过，修分类只能靠末尾那条', () => {
    const all = (D.MIGRATIONS as string[]).map((m) => m.trim());
    const seed = all.find((m) => m.includes('INSERT OR IGNORE INTO executor_settings'));
    assert.ok(seed, '种子迁移还在');
    assert.match(seed!, /'dev,doc,content'/, '种子里的原值（错的那个）必须原样留着');
    assert.doesNotMatch(seed!, /'dev,docs,content'/, '不能把历史种子改成对的');

    const upd013 = all.find((m) => m.includes("daily_token_cap = 5000000") && m.includes('executor = '));
    assert.ok(upd013, '013 那条 UPDATE 还在');
    assert.match(upd013!, /categories = 'dev,doc,content'/, '013 的原文也要原样留着');

    // 纠正迁移只能有一条，而且只做 token 替换，不碰别的字段。
    // （它后面可能还有别的迁移，所以按内容找，不假定它是最后一条。）
    const fixes = all.filter((m) => m.includes("',doc,'"));
    assert.equal(fixes.length, 1, '纠正迁移只应有一条');
    assert.match(fixes[0], /replace\(replace\(',' \|\| categories \|\| ',', ',doc,', ',docs,'\), ',research,', ','\)/);
  });
});
