// 046.7：沙箱磁盘上限、按内存定同时跑几个。全部假容器、假计时器，不碰 Docker。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISK_DEFAULT_MB, DISK_HARD_MB, createSlots, diskLimitMb, runInSandbox, sandboxCap, sandboxPlan, watchDisk } from '../scripts/lib/sandbox/run.mjs';
import { DockerProvider } from '../scripts/lib/sandbox/provider.mjs';

describe('046.7 · 同时跑几个沙箱', () => {
  test('8 GB 的 WSL、默认 2 GB agent → 2 个；内存够也不超过 3 个和执行器并行数', () => {
    assert.equal(sandboxCap({ maxParallel: 3, memTotalMb: 8192 }), 2);
    assert.equal(sandboxCap({ maxParallel: 5, memTotalMb: 65536 }), 3);
    assert.equal(sandboxCap({ maxParallel: 1, memTotalMb: 65536 }), 1);
    assert.equal(sandboxCap({ maxParallel: 3, memTotalMb: 8192, agentMemMb: 3072 }), 1, 'agent 调到 3 GB 就只剩 1 个');
    assert.equal(sandboxCap({ maxParallel: 3, memTotalMb: 3000 }), 1, '再小也至少 1 个');
    assert.equal(sandboxCap({ maxParallel: 2, memTotalMb: null }), 2, '读不出内存就不按内存算');
  });

  test('名额：满了排队、先来后到；还名额可以重复调，只算一次', async () => {
    const s = createSlots();
    const r1 = await s.acquire(2);
    const r2 = await s.acquire(2);
    let waited = 0;
    const order: number[] = [];
    const p3 = s.acquire(2, () => waited++).then((r) => { order.push(3); return r; });
    const p4 = s.acquire(2, () => waited++).then((r) => { order.push(4); return r; });
    await Promise.resolve();
    assert.equal(s.used(), 2);
    assert.equal(s.waiting(), 2);
    assert.equal(waited, 2);
    r1(); r1();
    const r3 = await p3;
    assert.equal(s.used(), 2, '重复还名额不会多放一个进来');
    assert.deepEqual(order, [3]);
    r2();
    const r4 = await p4;
    assert.deepEqual(order, [3, 4]);
    r3(); r4();
    assert.equal(s.used(), 0);
  });
});

describe('046.7 · /work 磁盘上限', () => {
  test('sandboxDiskMb：默认 4 GB，太大截到 32 GB，乱写抛错', () => {
    assert.equal(diskLimitMb({}), DISK_DEFAULT_MB);
    assert.equal(DISK_DEFAULT_MB, 4096);
    assert.equal(diskLimitMb({ sandboxDiskMb: 999999 }), DISK_HARD_MB);
    assert.equal(diskLimitMb({ sandboxDiskMb: 8192 }), 8192);
    for (const bad of ['x', -1, 100]) assert.throws(() => diskLimitMb({ sandboxDiskMb: bad }), /sandboxDiskMb/);
  });

  test('watchDisk：没超不动，超了叫一次就停表；量不出来不算超', async () => {
    let tick: any = null;
    let cleared = 0;
    const sizes = [100, null, 5000, 9000];
    const box = { diskUsedMb: async () => { const v = sizes.shift(); if (v === undefined) throw new Error('量不了'); return v; } };
    const over: number[] = [];
    watchDisk(box, { limitMb: 4096, onOver: async (mb: number) => { over.push(mb); }, setTimer: (fn: any) => { tick = fn; return 1; }, clearTimer: () => { cleared++; } });
    await tick(); await tick();
    assert.deepEqual(over, []);
    await tick();
    assert.deepEqual(over, [5000]);
    await tick();
    assert.deepEqual(over, [5000], '只叫一次');
    assert.ok(cleared >= 1);
    assert.equal(typeof watchDisk({}, { limitMb: 1, onOver: async () => {} }), 'function', '没有 diskUsedMb 的容器什么都不做');
  });

  test('runInSandbox：写满了就停掉容器、不收改动、说清楚，照样销毁', async () => {
    const calls: string[] = [];
    let killed = 0;
    let finish: (v: any) => void = () => {};
    const provider = {
      async create() {
        return {
          async copyIn() {},
          async exec(argv: string[]) {
            calls.push(argv[0] === 'claude' ? 'agent' : argv[2]?.includes('git clone') ? 'setup' : 'harvest');
            if (argv[0] === 'claude') return new Promise((r) => { finish = r; });
            return { code: 0 };
          },
          async diskUsedMb() { return 6000; },
          async kill() { killed++; finish({ code: 137, timedOut: false }); },
          async copyOut() { throw new Error('不该收'); },
          async destroy() { calls.push('destroy'); },
        };
      },
    };
    const plan = sandboxPlan({ tool: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-real' } }, {}, 9);
    const root = mkdtempSync(join(tmpdir(), 'wb-0467-'));
    const r = await runInSandbox({
      provider, task: { id: 9, title: 't' }, project: '/p', branch: 'wb/T-9', plan, prompt: 'x', timeoutMs: 60_000,
      onLine: () => {}, gitRun: (_c: string, ...a: string[]) => { writeFileSync(a.at(-2)!, 'b'); return ''; }, tmpRoot: root,
      diskMb: 4096, diskEveryMs: 5,
    });
    assert.match(r.problem, /写满了：\/work 用了 6000 MB，上限 4096 MB/);
    assert.equal(r.patch, '');
    assert.equal(r.killed, true);
    assert.equal(killed, 1);
    assert.deepEqual(calls, ['setup', 'agent', 'destroy'], '不收补丁，但销毁');
    assert.equal(readdirSync(root).length, 0);
  });
});

describe('046.7 · Docker 供应商量磁盘、读内存', () => {
  const mk = (out: Record<string, { code: number; stdout: string }>) => {
    const seen: string[][] = [];
    const docker = (args: string[]) => { seen.push(args); return { stderr: '', ...(out[args[0]] ?? { code: 0, stdout: '' }) }; };
    return { p: new DockerProvider({ image: 'wb-sandbox:latest', docker, rand: () => 'abc123' }), seen };
  };

  test('memTotalMb 读 docker info；读不出返回 null', () => {
    assert.equal(mk({ info: { code: 0, stdout: String(8 * 1024 ** 3) + '\n' } }).p.memTotalMb(), 8192);
    assert.equal(mk({ info: { code: 1, stdout: '' } }).p.memTotalMb(), null);
    assert.equal(mk({ info: { code: 0, stdout: 'garbage' } }).p.memTotalMb(), null);
  });

  test('diskUsedMb 用 du 量 /work，有报错也认总数；kill 只发 docker kill', async () => {
    const { p, seen } = mk({ exec: { code: 1, stdout: '5242880\t/work\n' } });
    const box = await p.create({ taskId: 3 });
    assert.equal(await box.diskUsedMb(), 5120);
    const du = seen.find((a) => a[0] === 'exec' && a.includes('du'))!;
    assert.deepEqual(du.slice(-3), ['du', '-sxk', '/work']);
    await box.kill();
    assert.deepEqual(seen.at(-1), ['kill', 'wb-sbx-T3-abc123']);
    await box.destroy();
    const n = seen.length;
    await box.kill();
    assert.equal(seen.length, n, '销毁后 kill 什么都不做');
  });
});
