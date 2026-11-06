// Fill an EMPTY database with demo data so you can see every screen populated.
//   WB_DB=./data/demo.db npm run seed
// Refuses to touch a database that already has tasks unless you pass --force.
import { db } from '../src/db.ts';
import { lastDays } from '../src/domain.ts';
import { createApproval, decideApproval } from '../src/services/approvals.ts';
import { addStats, createPost, setAccount } from '../src/services/media.ts';
import { heartbeat, ingestUsage, upsertAccount } from '../src/services/metrics.ts';
import { createTask, updateTask } from '../src/services/tasks.ts';

const n = (db().prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
if (n > 0 && !process.argv.includes('--force')) {
  console.error(`数据库里已有 ${n} 个任务，没有写入演示数据。确实要写入请加 --force。`);
  process.exit(1);
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const backdate = (id: number, created: number, started?: number, completed?: number) => {
  db().prepare('UPDATE tasks SET created_at = ?, updated_at = ?, started_at = ?, completed_at = ? WHERE id = ?').run(
    minsAgo(created), minsAgo(completed ?? started ?? created), started === undefined ? null : minsAgo(started),
    completed === undefined ? null : minsAgo(completed), id,
  );
};

type T = { title: string; executor: string; project: string; category: string; status: string; progress?: number; step?: string; ago: [number, number?, number?] };
const tasks: T[] = [
  { title: '给 RSS 抓取加去重与重试', executor: 'claude', project: 'demo-feed', category: 'dev', status: 'running', progress: 72, step: '写测试 5/7', ago: [40, 23] },
  { title: '整理 README 与部署文档', executor: 'claude', project: 'demo-feed', category: 'docs', status: 'running', progress: 40, step: '草稿 2/5', ago: [20, 11] },
  { title: '迁移家庭服务器监控到新面板', executor: 'codex', project: 'demo-server', category: 'ops', status: 'running', progress: 55, step: '改配置', ago: [60, 37] },
  { title: '批量生成 20 条短视频文案', executor: 'pool', project: 'content', category: 'content', status: 'running', progress: 85, step: '17/20', ago: [15, 8] },
  { title: '20 条短视频选题初筛', executor: 'pool', project: 'content', category: 'content', status: 'queued', ago: [12] },
  { title: '容器日志轮转配置', executor: 'codex', project: 'demo-server', category: 'ops', status: 'queued', ago: [30] },
  { title: '登录 Codex 云端，续期 OAuth', executor: 'me', project: '', category: 'personal', status: 'inbox', step: '需要本人扫码', ago: [90] },
  { title: '确认 API 025 的返回字段', executor: 'me', project: 'demo-feed', category: 'dev', status: 'inbox', step: 'Claude 卡在需求不明确', ago: [50] },
  { title: '给 36氪 源写抓取规则说明', executor: 'me', project: 'demo-feed', category: 'docs', status: 'inbox', ago: [200] },
  { title: 'API 025 参数校验', executor: 'claude', project: 'demo-feed', category: 'dev', status: 'done', ago: [300, 280, 230] },
  { title: '本周专栏提纲', executor: 'pool', project: 'content', category: 'content', status: 'done', ago: [400, 390, 370] },
  { title: '投递清单整理', executor: 'me', project: 'demo-jobs', category: 'personal', status: 'done', ago: [600, 580, 500] },
  { title: '修复 demo-server 上 RSSHub 内存泄漏', executor: 'codex', project: 'demo-feed', category: 'ops', status: 'failed', step: '构建超时', ago: [180, 170, 120] },
];
for (const t of tasks) {
  const created = createTask({ title: t.title, executor: t.executor, project: t.project, category: t.category, status: t.status, progress: t.progress ?? null, step: t.step ?? '' }, t.executor === 'me' ? 'me' : t.executor);
  backdate(created.id, t.ago[0], t.ago[1], t.ago[2]);
}
// older finished tasks for the 14-day stats
for (let i = 0; i < 28; i++) {
  const ex = ['claude', 'claude', 'codex', 'pool'][i % 4];
  const cat = ['dev', 'content', 'ops', 'docs', 'dev'][i % 5];
  const t = createTask({ title: `历史任务 #${i + 1}`, executor: ex, category: cat, project: ['demo-feed', 'content', 'demo-server'][i % 3], status: i % 9 === 4 ? 'failed' : 'done' }, ex);
  const day = 1 + (i % 13);
  backdate(t.id, day * 1440 + 90, day * 1440 + 80, day * 1440 + 80 - (12 + (i * 7) % 40));
}

const merge = createTask({ title: '合并 feat/rss-dedupe 到 main', executor: 'claude', project: 'demo-feed', category: 'dev', status: 'running' }, 'claude');
createApproval({ task_id: merge.id, title: '运行：git push origin feat/rss-dedupe:main', risk: 'medium', rule_name: '推送或合并代码', tool_name: 'Bash', source: 'claude-hook',
  summary: '目录：~/code/demo-feed\n说明：把去重分支合并进 main\n$ git push origin feat/rss-dedupe:main\n\n+214 −38 · 9 文件 · 测试 42/42' });
const del = createTask({ title: '清理 legacy/ 旧脚本', executor: 'codex', project: 'demo-server', category: 'ops', status: 'running' }, 'codex');
createApproval({ task_id: del.id, title: '运行：rm -rf legacy/', risk: 'high', rule_name: '删除文件', tool_name: 'Bash', executor: 'codex', summary: '目录：/opt/demo-server\n$ rm -rf legacy/\n\n将删除 14 个文件，共 1,203 行' });
const dep = createTask({ title: '部署 v0.3.2 到 demo-server', executor: 'pool', project: 'demo-feed', category: 'ops', status: 'running' }, 'pool');
createApproval({ task_id: dep.id, title: '运行：ssh demo-server "docker compose up -d"', risk: 'high', rule_name: '部署与远程操作', tool_name: 'Bash', executor: 'pool', summary: '$ ssh demo-server "cd /srv/demo-feed && docker compose pull && docker compose up -d"' });
db().prepare("UPDATE approvals SET created_at = ? WHERE id = 1").run(minsAgo(18));
db().prepare("UPDATE approvals SET created_at = ? WHERE id = 2").run(minsAgo(6));
db().prepare("UPDATE approvals SET created_at = ? WHERE id = 3").run(minsAgo(2));
// some decided history
for (let i = 0; i < 9; i++) {
  const t = createTask({ title: `历史审批 #${i + 1}`, executor: 'claude', project: 'demo-feed', status: 'running' }, 'claude');
  const a = createApproval({ task_id: t.id, title: `运行：git push origin fix-${i}`, rule_name: i % 3 ? '推送或合并代码' : '删除文件', risk: 'medium' });
  decideApproval(a.id, i === 4 ? 'changes' : i === 7 ? 'takeover' : 'approved', i === 4 ? '先补测试再推送' : '');
  updateTask(t.id, { status: 'done' }, 'claude');
}

// usage: 14 days
const recs = [];
const shape = [[300, 180, 90], [420, 260, 180], [520, 200, 120], [380, 300, 160], [260, 120, 60], [180, 80, 40], [610, 220, 240], [420, 260, 180], [610, 220, 240], [380, 340, 120], [720, 300, 260], [300, 120, 90], [880, 410, 300], [960, 520, 340]];
const days = lastDays(14);
const accts: Record<string, string[]> = { claude: ['Claude Max · 主号'], codex: ['Codex · Plus'], pool: ['反代 A', '反代 B', '反代 C'] };
const projects = ['demo-feed', 'content', 'demo-server', 'demo-jobs'];
days.forEach((d, i) => {
  (['claude', 'codex', 'pool'] as const).forEach((ex, j) => {
    const total = shape[i][j] * 1000;
    for (let k = 0; k < 4; k++) {
      recs.push({
        source_key: `demo:${d}:${ex}:${k}`, ts: `${d}T0${2 + k}:30:00+08:00`, executor: ex,
        account: accts[ex][k % accts[ex].length], model: ex === 'claude' ? 'claude-opus-5-5' : ex === 'codex' ? 'gpt-5-codex' : 'mixed',
        project: projects[(k + j) % projects.length], input_tokens: Math.round(total * 0.18), output_tokens: Math.round(total * 0.07), cache_tokens: Math.round(total * 0.9),
      });
    }
  });
});
ingestUsage(recs);

upsertAccount('Claude Max · 主号', { executor: 'claude', via: '官方会话', window_pct: 62, reset_note: '1h 48m', status: 'ok' });
upsertAccount('Codex · Plus', { executor: 'codex', via: '云端任务', window_pct: 41, reset_note: '周一', status: 'ok' });
upsertAccount('反代 A', { executor: 'pool', via: 'CLI 反代', window_pct: 88, reset_note: '32m', status: 'near' });
upsertAccount('反代 B', { executor: 'pool', via: 'CLI 反代', window_pct: 35, reset_note: '3h 10m', status: 'ok' });
upsertAccount('反代 C', { executor: 'pool', via: 'CLI 反代', window_pct: 0, reset_note: '', status: 'relogin' });

heartbeat('demo-workstation', { meta: 'linux · 16 核 · 已运行 15.2h', metrics: { load: 3.5, cores: 16, mem_used_gb: 18, mem_total_gb: 62.5, disk_pct: 41, temp_c: 52, containers: 9,
  gpus: [{ name: 'Tesla T10', temp: 42, util: 0, mem_used: 0.1, mem_total: 16 }, { name: 'Tesla T10', temp: 31, util: 0, mem_used: 0, mem_total: 16 }] } });
heartbeat('demo-server', { meta: '云主机 · RSSHub · 演示项目', metrics: { load: 0.4, cores: 2, mem_used_gb: 1.3, mem_total_gb: 2, temp_c: undefined, containers: 3 } });

// 自媒体（055.1）：三件内容，七个平台各 1–3 条，同一件内容在各平台的 piece 一样。
// 数全是编的，链接一律 example.com，账号名一律 @demo-…。
const PIECES = [
  { piece: 'EP01', title: '我用一群 AI 给自己搭了个工作台', days: 2 },
  { piece: 'EP02', title: '一个月电费 1200 块，我把家里的服务器重装了一遍', days: 8 },
  { piece: 'EP03', title: '20 条短视频文案，我全丢给反代池了', days: 12 },
];
const ON: Record<string, string[]> = {
  bilibili: ['EP01', 'EP02'],
  xiaohongshu: ['EP01', 'EP03'],
  douyin: ['EP01', 'EP02', 'EP03'],
  channels: ['EP01', 'EP02'],
  x: ['EP01', 'EP03'],
  instagram: ['EP01'],
  facebook: ['EP01'],
};
const HANDLES: Record<string, [string, number]> = {
  bilibili: ['@demo-bili', 12800],
  xiaohongshu: ['@demo-xhs', 6400],
  douyin: ['@demo-douyin', 23100],
  channels: ['@demo-channels', 3800],
  x: ['@demo-x', 1750],
  instagram: ['@demo-ig', 960],
  facebook: ['@demo-fb', 540],
};
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
// 每个平台的「基本盘」，让播放量的高低和粉丝量对得上，不至于像随机数。
const REACH: Record<string, number> = { bilibili: 3200, xiaohongshu: 2100, douyin: 5200, channels: 1400, x: 620, instagram: 380, facebook: 240 };

for (const [platform, pieces] of Object.entries(ON)) {
  for (const [nth, piece] of pieces.entries()) {
    const p = PIECES.find((x) => x.piece === piece)!;
    const post = createPost({
      platform, piece: p.piece, title: p.title,
      url: `https://example.com/${platform}/${p.piece.toLowerCase()}`,
      published_at: daysAgo(p.days),
    });
    // 每条 1–3 次快照：发布第二天、快一周、现在。播放从几百到几万。
    for (const [i, d] of [p.days - 1, p.days - 5, 0].filter((x) => x >= 0).entries()) {
      const views = Math.round(REACH[platform] * (1 + 0.3 * nth) * Math.pow(2.6, i));
      addStats(post.id, {
        views, likes: Math.round(views * 0.062), comments: Math.round(views * 0.009),
        shares: Math.round(views * 0.005), saves: Math.round(views * 0.011), at: daysAgo(d),
      });
    }
  }
}
for (const [platform, [handle, followers]] of Object.entries(HANDLES)) {
  setAccount({ platform, handle, followers });
}

console.log('演示数据已写入：', process.env.WB_DB ?? './data/workbench.db');
