// 迁移：新表必须新开一条迁移。追加到已有那条后面，老库（user_version 已越过它）升级时不会再执行，
// 结果是「新装能用、老库永远缺表」。035 一开始就把 selfdev_* 三张表追加在 031c 那条迁移末尾，真机上就是这样缺的。
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDb } from '../src/db.ts';

const dirs: string[] = [];
// 用例失败时可能留下没关的库，Windows 上删不掉——清理不该把整轮测试带红。
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 下一轮再删 */ } } });

function tempDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'wb-migrate-'));
  dirs.push(d);
  return join(d, 'workbench.db');
}

/**
 * 造一个「停在某个版本」的老库：前面的迁移真跑，后面的不跑。
 * 早先这里图省事用 `user_version - 1` 回头，可版本号退了、表结构没退——
 * 之后每加一条 ALTER 型迁移，这个模拟就会以「duplicate column」失败。按条数重建才干净。
 */
function dbAt(file: string, applied: number): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const m of MIGRATIONS.slice(0, applied)) db.exec(m);
  db.exec(`PRAGMA user_version = ${applied}`);
  db.close();
}

function tables(db: ReturnType<typeof openDb>): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((r) => r.name);
}

const NEW_TABLES = ['selfdev_queue', 'selfdev_state', 'selfdev_reports'];

/** 041 之后「最后一条迁移」不再是 selfdev 那条了：回到 selfdev 之前，按索引算，别按「减一」算。 */
const SELFDEV_AT = MIGRATIONS.findIndex((m) => /CREATE TABLE IF NOT EXISTS selfdev_queue\b/.test(m));

describe('迁移', () => {
  test('新装的库三张 selfdev 表都在', () => {
    const db = openDb(tempDb());
    const names = tables(db);
    for (const t of NEW_TABLES) assert.ok(names.includes(t), `新库里缺 ${t}`);
    db.close();
  });

  test('selfdev 三张表单独一条迁移，没有混进更早那条', () => {
    const idx = MIGRATIONS.findIndex((m) => /CREATE TABLE IF NOT EXISTS selfdev_queue\b/.test(m));
    assert.ok(idx >= 0, '找不到建 selfdev_queue 的那条迁移');
    const entry = MIGRATIONS[idx];
    const older = /CREATE TABLE IF NOT EXISTS (tasks|settings|events|machines|runners|approvals|comments|stale_branches|project_requests|project_notes)\b/.exec(entry);
    assert.equal(older, null,
      `035 的三张表被塞进了「${older?.[1]}」那条迁移里：老库升到那一版之后就不会再执行它，三张表永远不存在`);
    for (const t of NEW_TABLES) {
      assert.match(entry, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`), `这条迁移里没有 ${t}`);
    }
  });

  test('从上一版升上来的老库会补上 selfdev 三张表', () => {
    const file = tempDb();
    // 老库停在 selfdev 那条之前——真真实实的旧结构，不是「删了表但表结构还是新的」。
    dbAt(file, SELFDEV_AT);
    const old = new DatabaseSync(file);
    assert.equal(tables(old as never).includes('selfdev_queue'), false, '模拟的老库不该已经有这张表');
    old.close();

    const again = openDb(file);
    const names = tables(again);
    for (const t of NEW_TABLES) assert.ok(names.includes(t), `老库升级后仍然缺 ${t}`);
    const version = Number((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    assert.equal(version, MIGRATIONS.length, '升级只该跑到最新那条');
    again.close();
  });

  test('升级只跑缺的那几条，老数据不动', () => {
    const file = tempDb();
    dbAt(file, SELFDEV_AT);
    const first = new DatabaseSync(file);
    first.prepare("INSERT INTO project_notes (project, text, norm, status, created_at) VALUES ('demo', '别用 npm run check', '别用 npm run check', 'confirmed', '2026-10-31T00:00:00Z')").run();
    first.close();

    const again = openDb(file);
    const row = again.prepare("SELECT text, status FROM project_notes WHERE project = 'demo'")
      .get() as { text: string; status: string } | undefined;
    assert.equal(row?.text, '别用 npm run check', '升级把已有的备忘弄丢了');
    assert.equal(row?.status, 'confirmed');
    assert.ok(tables(again).includes('selfdev_state'));
    again.close();
  });
});
