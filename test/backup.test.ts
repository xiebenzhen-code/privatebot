// 014: the daily snapshot. What matters here is that a backup is trustworthy (verified copy,
// no sessions) and that nothing outside its own files is ever touched.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-backup-0123456789';
const PASSWORD = 'test-password-backup-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = PASSWORD;
process.env.WB_TZ = 'Asia/Shanghai'; // 下面按东八区算 03:30

let app: Server;
let base = '';
let cookie = '';
let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;
let dir = '';

const DAY = 86400000;
const dbs = () => readdirSync(dir).filter((n) => n.endsWith('.db'));

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => { app.close(); });

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
  dir = mkdtempSync(join(tmpdir(), 'wb-backup-'));
  process.env.WB_BACKUP_PATH = dir;
  process.env.WB_BACKUP_NAME = 'ai-workbench';
  delete process.env.WB_VERSION;
  cookie = await loginCookie(base, PASSWORD);
});

describe('a snapshot you can trust', () => {
  test('副本校验通过、会话被删掉，原库不受影响，旁边有说明文件', async () => {
    const { runBackup } = await import('../src/services/backup.ts');
    // 登录本身就会写一条会话，所以拿基线而不是写死数字
    const sessionsBefore = (db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n;
    db.prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES ('s1', '2026-01-01', '2027-01-01')").run();

    const r = runBackup('manual');
    assert.equal(r.ok, true, r.error);
    assert.match(r.file, /^ai-workbench_\d{4}-\d{2}-\d{2}_\d{4}_dev\.db$/);
    assert.deepEqual(readdirSync(dir).sort(), [r.file, r.file.replace(/\.db$/, '.json')].sort());

    const copy = new DatabaseSync(join(dir, r.file));
    try {
      assert.equal((copy.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n, 0);
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
    } finally { copy.close(); }
    assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n, sessionsBefore + 1, '原库的会话不能被动');

    const meta = JSON.parse(readFileSync(join(dir, r.file.replace(/\.db$/, '.json')), 'utf8'));
    assert.equal(meta.project, 'ai-workbench');
    assert.equal(meta.version, 'dev');
    assert.equal(meta.note.includes('重新登录'), true);
    assert.equal(typeof meta.counts.tasks, 'number');
    assert.ok(meta.migrations > 0);
  });

  test('同一分钟内再点一次也有独立文件', async () => {
    const { runBackup } = await import('../src/services/backup.ts');
    const a = runBackup('manual');
    const b = runBackup('manual');
    assert.equal(b.ok, true, b.error);
    assert.notEqual(a.file, b.file);
    assert.equal(dbs().length, 2);
  });
});

describe('keep 30, touch nothing else', () => {
  test('留最近 30 份，别人的文件原样不动', async () => {
    const { runBackup, KEEP } = await import('../src/services/backup.ts');
    const old = Array.from({ length: 32 }, (_, i) => `ai-workbench_2026-01-${String(i + 1).padStart(2, '0')}_0330_dev.db`);
    for (const n of old) writeFileSync(join(dir, n), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'keep me');

    const r = runBackup('manual');
    assert.equal(r.ok, true, r.error);

    const kept = dbs();
    assert.equal(kept.length, KEEP);
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'keep me');
    assert.ok(kept.includes(r.file));
    assert.ok(kept.includes('ai-workbench_2026-01-32_0330_dev.db'), '最新的旧备份要留着');
    assert.ok(!kept.includes('ai-workbench_2026-01-01_0330_dev.db'), '最旧的旧备份要删掉');
  });
});

describe('when the folder cannot be written', () => {
  test('记错误、建一条待办，同一个原因不重复建', async () => {
    const { runBackup, checkStale, backupStatus } = await import('../src/services/backup.ts');
    // 用一个文件占住目录名，mkdir 必然失败
    writeFileSync(join(dir, 'blocked'), 'not a folder');
    process.env.WB_BACKUP_PATH = join(dir, 'blocked', 'sub');

    const r = runBackup('manual');
    assert.equal(r.ok, false);
    const st = backupStatus();
    assert.ok(st.last_error.length > 0);
    assert.equal(st.fail_count, 1);
    assert.equal(st.last_ok, null);

    // 伪造「上次成功是 4 天前」，再查两次只应有一条待办
    db.prepare("UPDATE connector_state SET last_ok = ? WHERE name = 'backup'")
      .run(new Date(Date.now() - 4 * DAY).toISOString());
    checkStale();
    checkStale();
    const rows = db.prepare("SELECT title, status FROM tasks WHERE dedupe_key LIKE 'backup:%'").all() as { title: string; status: string }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /没备份成功|没成功/);
  });
});

describe('who may press the button', () => {
  test('Bearer 令牌 403，网页登录可以', async () => {
    const asToken = await fetch(`${base}/api/backup/run`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(asToken.status, 403);
    assert.equal(dbs().length, 0, '被拒绝的请求不能留下文件');

    const asPerson = await fetch(`${base}/api/backup/run`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(asPerson.status, 200);
    const body = await asPerson.json() as { ok: boolean; file: string };
    assert.equal(body.ok, true);
    assert.equal(dbs().length, 1);
  });

  test('状态接口对令牌开放，面板要显示目录和上次结果', async () => {
    const res = await fetch(`${base}/api/backup/state`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const st = await res.json() as any;
    assert.equal(st.dir, dir);
    assert.equal(st.keep, 30);
  });
});

describe('the 03:30 slot was missed', () => {
  test('超过 24 小时没成功就立刻补一份，不到 24 小时不补', async () => {
    const { runBackup, catchUpIfStale } = await import('../src/services/backup.ts');
    runBackup('manual');
    assert.equal(catchUpIfStale(), null);
    assert.equal(dbs().length, 1);

    db.prepare("UPDATE connector_state SET last_ok = ? WHERE name = 'backup'")
      .run(new Date(Date.now() - 25 * 3600 * 1000).toISOString());
    const r = catchUpIfStale();
    assert.ok(r, '应该补一份');
    assert.equal(r!.ok, true, r!.error);
    assert.equal(dbs().length, 2);
  });

  test('从来没备份过也算漏了', async () => {
    const { catchUpIfStale } = await import('../src/services/backup.ts');
    const r = catchUpIfStale();
    assert.ok(r && r.ok, '第一次启动就应该有一份');
    assert.equal(dbs().length, 1);
  });

  test('下一次定时落在 03:30（WB_TZ），已经在 03:30 就等明天', async () => {
    const { msUntilNext } = await import('../src/services/backup.ts');
    const half = 30 * 60 * 1000;
    // 东八区：UTC 19:00 = 次日 03:00
    assert.equal(msUntilNext(new Date('2026-01-01T19:00:00Z')), half);
    assert.equal(msUntilNext(new Date('2026-01-01T19:30:00Z')), 24 * 60 * 60 * 1000);
    // 04:00 → 23 小时 30 分后
    assert.equal(msUntilNext(new Date('2026-01-01T20:00:00Z')), 23 * 60 * 60 * 1000 + half);
  });
});

describe('备份目录认哪个变量', () => {
  test('npm start 直接跑时，WB_BACKUP_DIR 说了算，不会写到盘根', async () => {
    const { backupDir } = await import('../src/services/backup.ts');
    const keepPath = process.env.WB_BACKUP_PATH;
    const keepDir = process.env.WB_BACKUP_DIR;
    process.env.WB_BACKUP_DIR = dir;
    delete process.env.WB_BACKUP_PATH;

    if (existsSync('/.dockerenv')) {
      // 容器里 /backups 是挂进来的卷，只认它
      assert.equal(backupDir(), '/backups');
    } else {
      assert.equal(backupDir(), dir, '裸跑要按用户设的目录写');
    }

    process.env.WB_BACKUP_PATH = join(dir, 'explicit');
    assert.equal(backupDir(), join(dir, 'explicit'), '显式写的 WB_BACKUP_PATH 优先级最高');

    if (keepPath === undefined) delete process.env.WB_BACKUP_PATH; else process.env.WB_BACKUP_PATH = keepPath;
    if (keepDir === undefined) delete process.env.WB_BACKUP_DIR; else process.env.WB_BACKUP_DIR = keepDir;
  });
});
