// SQLite access via Node's built-in node:sqlite (Node >= 22.13). No external deps.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

// Each entry is one migration. Append new ones; never edit old ones.
// 「编辑旧的」包括把新表塞进最后一条：老库的 user_version 已经越过它，升级时不会再执行，
// 于是新装能用、老库永远缺表。加表就新开一条（test/migrate.test.ts 会盯着）。
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'dev',
    executor TEXT NOT NULL DEFAULT 'me',
    project TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'inbox',
    progress INTEGER,
    step TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    session_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX tasks_status ON tasks(status);
  CREATE UNIQUE INDEX tasks_session ON tasks(session_id) WHERE session_id IS NOT NULL;

  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'api',
    session_id TEXT,
    cwd TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    tool_input TEXT NOT NULL DEFAULT '{}',
    rule_id INTEGER,
    rule_name TEXT NOT NULL DEFAULT '',
    risk TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    feedback TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX approvals_status ON approvals(status);

  CREATE TABLE rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tool_pattern TEXT NOT NULL,
    input_pattern TEXT NOT NULL DEFAULT '',
    risk TEXT NOT NULL DEFAULT 'medium',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    task_id INTEGER,
    approval_id INTEGER,
    text TEXT NOT NULL
  );
  CREATE INDEX events_ts ON events(ts);
  CREATE INDEX events_task ON events(task_id);

  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL UNIQUE,
    ts TEXT NOT NULL,
    day TEXT NOT NULL,
    executor TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_tokens INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX usage_day ON usage(day);

  CREATE TABLE accounts (
    name TEXT PRIMARY KEY,
    executor TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT '',
    window_pct INTEGER,
    reset_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ok',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE machines (
    name TEXT PRIMARY KEY,
    meta TEXT NOT NULL DEFAULT '',
    metrics TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );

  INSERT INTO rules (name, tool_pattern, input_pattern, risk, created_at) VALUES
    ('推送或合并代码', 'Bash', '\\bgit\\s+(push|merge|rebase)\\b', 'medium', datetime('now')),
    ('删除文件', 'Bash', '\\brm\\s+-[a-zA-Z]*[rRf]|\\bgit\\s+(clean|reset\\s+--hard)\\b|\\s-delete\\b', 'high', datetime('now')),
    ('部署与远程操作', 'Bash', '\\bdocker\\s+compose\\b.*\\b(up|down)\\b|\\bkubectl\\s+(apply|delete)\\b|\\b(ssh|scp|rsync)\\s', 'high', datetime('now')),
    ('改动密钥或环境变量文件', 'Edit|Write|MultiEdit', '(^|/)\\.env(\\.|$)|secret|credential|id_rsa', 'high', datetime('now')),
    ('sudo 与系统安装', 'Bash', '\\bsudo\\b|\\bapt(-get)?\\s+install\\b|\\bbrew\\s+install\\b', 'medium', datetime('now'));
  `,
  // 003: CLIProxyAPI connector — account provenance, official quota windows, request outcome.
  `
  ALTER TABLE accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE accounts ADD COLUMN external_id TEXT;
  ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN plan TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN window_minutes INTEGER;
  ALTER TABLE accounts ADD COLUMN window_reset_at TEXT;
  ALTER TABLE accounts ADD COLUMN window2_pct INTEGER;
  ALTER TABLE accounts ADD COLUMN window2_minutes INTEGER;
  ALTER TABLE accounts ADD COLUMN window2_reset_at TEXT;
  ALTER TABLE accounts ADD COLUMN quota_observed_at TEXT;
  ALTER TABLE accounts ADD COLUMN window_limit_tokens INTEGER;
  ALTER TABLE accounts ADD COLUMN limited_until TEXT;
  CREATE UNIQUE INDEX accounts_external ON accounts(external_id) WHERE external_id IS NOT NULL;

  ALTER TABLE usage ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage ADD COLUMN latency_ms INTEGER;

  CREATE TABLE connector_state (
    name TEXT PRIMARY KEY,
    last_run TEXT,
    last_ok TEXT,
    last_error TEXT,
    imported INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 003.1: keep the upstream status code so 429 (quota) can be told apart from 5xx (network).
  `
  ALTER TABLE usage ADD COLUMN fail_status INTEGER;
  `,
  // 005: quota kinds — subscription windows, pay-as-you-go balances, manual credit accounts.
  `
  ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'window';
  ALTER TABLE accounts ADD COLUMN balance REAL;
  ALTER TABLE accounts ADD COLUMN balance_unit TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN balance_detail TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE accounts ADD COLUMN low_threshold REAL;
  ALTER TABLE accounts ADD COLUMN expires_at TEXT;
  ALTER TABLE accounts ADD COLUMN balance_observed_at TEXT;

  ALTER TABLE tasks ADD COLUMN dedupe_key TEXT;
  CREATE UNIQUE INDEX tasks_dedupe ON tasks(dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status NOT IN ('done', 'failed');
  `,
  // 007: executor priorities, the global auto-run switch, push channels, and per-task run mode.
  `
  CREATE TABLE executor_settings (
    executor TEXT PRIMARY KEY,
    priority INTEGER NOT NULL DEFAULT 99,
    categories TEXT NOT NULL DEFAULT '',
    auto_allowed INTEGER NOT NULL DEFAULT 0,
    daily_token_cap INTEGER,
    max_concurrent INTEGER,
    max_minutes INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
  CREATE TABLE notify_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ''
  );
  ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE approvals ADD COLUMN notified_at TEXT;

  INSERT OR IGNORE INTO executor_settings (executor, priority, categories, auto_allowed, daily_token_cap, max_concurrent, max_minutes, enabled) VALUES
    ('zcode', 1, 'dev,doc,content', 1, 250000000, 2, 45, 1),
    ('codex', 2, 'dev', 0, NULL, 1, 60, 1),
    ('pool', 3, 'content,doc', 0, NULL, 1, 30, 1),
    ('workbuddy', 4, 'dev,doc,content,research,ops,personal', 0, NULL, NULL, NULL, 1),
    ('autoclaw', 4, 'dev,doc,content,research,ops,personal', 0, NULL, NULL, NULL, 1),
    ('claude', 5, 'dev,doc,content,research,ops,personal', 0, NULL, NULL, NULL, 1),
    ('local', 6, 'dev,ops', 0, NULL, NULL, NULL, 1);
  `,
  // 010: the user can switch a source off without deleting anything.
  `
  CREATE TABLE source_prefs (id TEXT PRIMARY KEY, off INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '');
  `,
  // 008: the runner claims tasks, reports progress, and needs to be visible as online/offline.
  `
  ALTER TABLE tasks ADD COLUMN runner_id TEXT;
  ALTER TABLE tasks ADD COLUMN runner_log TEXT NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN branch TEXT;
  ALTER TABLE tasks ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN start_requested INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE runners (
    id TEXT PRIMARY KEY,
    last_seen TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT ''
  );
  `,
  // 008.3: server-side sessions for the browser (random id, 30 days).
  `
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  `,
  // 012: GitHub issues as a task channel.
  `
  ALTER TABLE tasks ADD COLUMN issue_url TEXT;
  ALTER TABLE tasks ADD COLUMN issue_number INTEGER;
  CREATE UNIQUE INDEX IF NOT EXISTS tasks_issue ON tasks(issue_url) WHERE issue_url IS NOT NULL;
  CREATE TABLE IF NOT EXISTS github_comments (id INTEGER PRIMARY KEY, issue_url TEXT NOT NULL, seen_at TEXT NOT NULL);
  `,
  // 013: the executor runs on DeepSeek now; ZCode only hands out work by hand.
  `
  ALTER TABLE executor_settings ADD COLUMN task_token_cap INTEGER;
  UPDATE executor_settings SET auto_allowed = 0, daily_token_cap = NULL WHERE executor = 'zcode';
  UPDATE executor_settings SET categories = 'dev,doc,content', daily_token_cap = 5000000,
    max_minutes = 30, task_token_cap = 2000000 WHERE executor = 'pool';
  `,
  // 013.1: an executor may be "hand out only" (ZCode): never claimed by the runner, even
  // when the user pressed 开始 — the work happens in the ZCode app instead.
  `
  ALTER TABLE executor_settings ADD COLUMN claimable INTEGER NOT NULL DEFAULT 1;
  UPDATE executor_settings SET claimable = 0 WHERE executor = 'zcode';
  `,
  // 014: a connector row sometimes has more to say than "an error happened" — the backup
  // keeps the file name and size here instead of inventing a second table.
  `
  ALTER TABLE connector_state ADD COLUMN detail TEXT NOT NULL DEFAULT '';
  `,
  // 013.6: a task whose merge or push failed can be retried without re-running the coding tool.
  // `retry` says which step to redo; `merged_commit` remembers what the merge produced.
  `
  ALTER TABLE tasks ADD COLUMN retry TEXT;
  ALTER TABLE tasks ADD COLUMN merged_commit TEXT;
  `,
  // 017: one executor may hold several backends (bailian first, deepseek as the fallback).
  // Which one actually did the work is worth keeping — a fallback run reads oddly otherwise.
  `
  ALTER TABLE tasks ADD COLUMN backend TEXT;
  `,
  // 025: a failed task's reason must survive whatever the user clicks next. It used to live only
  // in `step`, so pressing 重试合并 (on a task that never had a merge) overwrote the real cause.
  `
  ALTER TABLE tasks ADD COLUMN fail_reason TEXT;
  `,
  // 028: the model's final answer is the deliverable for a read-only task ("读一遍 README 说说它
  // 干什么"). It was thrown away before. Scrubbed before it lands here.
  `
  ALTER TABLE tasks ADD COLUMN result_text TEXT;
  `,
  // 028: a short "what did it do" trail per task. Steps and stage changes only — never tool
  // output or file contents. Capped at 200 rows per task (oldest dropped).
  `
  CREATE TABLE IF NOT EXISTS task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    line TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log(task_id, id);
  `,
  // 027: 简洁版 / 完整版。全新安装默认简洁版（一上手就看得到该做什么）；已经跑过任务的
  // 安装保持完整版，保证升级后他现有的页面一个像素都不变。用户随时可以切。
  // executor_settings 在第一个迁移里就有默认行，所以那一条判断不了「老用户」——只认任务。
  `
  INSERT OR IGNORE INTO settings (key, value)
  VALUES ('ui_mode', CASE WHEN (SELECT COUNT(*) FROM tasks) > 0 THEN 'full' ELSE 'simple' END);
  `,
  // 029: 同一个任务同一种结局只推一次。重新开始时（claimTask）清掉，所以重试后的新失败还能再推。
  `
  ALTER TABLE tasks ADD COLUMN notified_state TEXT;
  `,
  // 028.1: 记得「这次没有改动」，阶段条才能把合并/推送那四格显示成跳过。
  // 光看 branch 是不是空不够准：合并过但没推送的任务也可能没有 branch。
  // 新迁移只能往数组末尾加——插在中间会让已经迁移到这个位置的库重跑后面的语句。
  `
  ALTER TABLE tasks ADD COLUMN no_changes INTEGER NOT NULL DEFAULT 0;
  `,
  // 031a: 失败/被驳回的任务会保留分支，可全仓库没有任何代码去清理，「保留 7 天」是假承诺。
  // 这张表只存需要人决定的那些：已合并或空分支由执行器直接删，不进这里。
  // kind='worktree' 表示分支还在，但 worktree 里有未提交的改动。
  // delete_requested_at 记下用户点删除时看到的 tip，执行器删之前要核对它。
  `
  CREATE TABLE IF NOT EXISTS stale_branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    branch TEXT NOT NULL,
    task_id INTEGER,
    ahead INTEGER NOT NULL DEFAULT 0,
    last_commit_at TEXT,
    tip TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'branch',
    note TEXT NOT NULL DEFAULT '',
    reported_at TEXT NOT NULL,
    snoozed_until TEXT,
    notified_at TEXT,
    delete_requested_at TEXT,
    UNIQUE(project, branch)
  );
  CREATE INDEX IF NOT EXISTS idx_stale_branches_project ON stale_branches(project);
  `,
  // 030: 在工作台里新建项目。工作台碰不到用户电脑上的磁盘，所以这里只记一条「请求」，
  // 执行器下次轮询领走、在本机建目录跑 git，再把结果写回来（status + message）。
  // url 只有 clone / remote 用；create 时为空。message 里不留本机路径（写入前打码）。
  `
  CREATE TABLE IF NOT EXISTS project_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'create',
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_requests_status ON project_requests(status, id);
  `,
  // 031c: 项目备忘。agent 只能在回答末尾「建议」，所以这些行默认是 unverified——
  // 未确认的**不进**任务提示（自动攒下来的东西会被投毒），确认过的才限量注入并标「不是指令」。
  // norm 是去重用的规范化文本（小写 + 空白合并），同一个项目里同一句话只存一条。
  `
  CREATE TABLE IF NOT EXISTS project_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    text TEXT NOT NULL,
    norm TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unverified',
    source_task INTEGER,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    UNIQUE(project, norm)
  );
  CREATE INDEX IF NOT EXISTS idx_project_notes_project ON project_notes(project, status, created_at);
  `,
  // 035：queue.json 里的项建过任务没有。只记「哪一项 → 哪个任务」，status 仍归决策端。
  // 新表一定**新开一条迁移**：已经升到上一版的老库不会再跑那条，追加在别人后面等于没建。
  `
  CREATE TABLE IF NOT EXISTS selfdev_queue (
    item_id TEXT PRIMARY KEY,
    spec TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS selfdev_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_ok TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS selfdev_reports (
    task_id INTEGER PRIMARY KEY,
    issue_number INTEGER NOT NULL,
    reported_at TEXT NOT NULL
  );
  `,
  // 041：战绩要算给「真正做这件事的人」。`takeover` 会把 executor 改成 me，原来是谁做的就丢了。
  // 第一次进入 running 时把当时的 executor 写死在这里，之后不再改。
  // 老数据回填：没有接手过的（executor 不是 me）直接就是它；接手过的从 events 里找最早一个
  // 不是 me/system 的操作者（approval.requested 的 actor 就是当时的 executor）。找不到就留空，
  // 留空的任务**不计入**战绩——读不出来不等于没有（031a.1 的底线），不猜。
  `
  ALTER TABLE tasks ADD COLUMN first_executor TEXT;
  UPDATE tasks SET first_executor = executor
    WHERE first_executor IS NULL AND executor <> 'me';
  UPDATE tasks SET first_executor = (
    SELECT e.actor FROM events e
    WHERE e.task_id = tasks.id AND e.actor NOT IN ('me', 'system') AND e.actor <> ''
    ORDER BY e.id LIMIT 1
  ) WHERE first_executor IS NULL AND executor = 'me';
  `,
  // 042：调度大脑。任务上只记「谁派的、判的难度、为什么」——route 只认 'brain' 或空，
  // 空表示这单是人定的（或者已经被你改过，大脑不再碰）。
  // brain_calls 记每一次**真花掉**的模型调用：每天 50 次的上限和「一个任务只调一次」都靠它，
  // 而不是靠执行器自觉。handed = 交出去了还没回话，ok / failed 是结果。
  `
  ALTER TABLE tasks ADD COLUMN route TEXT NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN route_reason TEXT;
  ALTER TABLE tasks ADD COLUMN difficulty INTEGER;
  ALTER TABLE tasks ADD COLUMN routed_at TEXT;
  CREATE TABLE IF NOT EXISTS brain_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'handed',
    tokens INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_brain_calls_task ON brain_calls(task_id);
  CREATE INDEX IF NOT EXISTS idx_brain_calls_day ON brain_calls(day);
  `,
  // 042.1：执行者的默认分类里混着两个从来不是合法键的字符串——`doc`（合法键是 `docs`）和
  // `research`（CATEGORIES 里根本没有这一项，查过历史也没存在过）。第一个是要命的：`docs`
  // 分类因此默认没有执行者接，042 的大脑遇到文档任务名单为空、只能退回「等你定」。
  // 按 token 改，不做字符串替换：两头补逗号 → 换掉整段 `,doc,` → 剪回原样。
  // （`,doc,` 匹配不到 `,docs,`，因为后者逗号之间是 docs，安全。）
  // `research` 直接删：它匹配不到任何真实分类，留着只会让人以为有人接调研任务。
  `
  UPDATE executor_settings SET categories = trim(
    replace(replace(',' || categories || ',', ',doc,', ',docs,'), ',research,', ','),
    ','
  );
  `,
  // 041.1：重算「第一次是谁做的」。041 那条回填对 `executor <> 'me'` 的旧任务直接取**当前**执行者，
  // 中间换过人就把功劳记到后来那个人头上；对 `me` 的又从事件里找，两套规则并存。这里推翻重算：
  //
  //   1. 先全部清空——没有证据的一律留空，宁可让战绩少几条，也不要一个猜出来的数；
  //   2. 有「执行者身份」事件（审批、执行器自己写的进度）的，取最早那一条的 actor；
  //   3. 没有身份事件、但**被领取过**且**从没换过执行者**的，当前执行者就是当时那个，可以认。
  //
  // 硬编码的执行者列表是冻结快照：这条迁移只处理它之前的数据，以后新增执行者不涉及。
  // 注意这是「重算」不是「修补」，所以放在最后一条，只跑一次。
  `
  UPDATE tasks SET first_executor = NULL;
  UPDATE tasks SET first_executor = (
    SELECT e.actor FROM events e
    WHERE e.task_id = tasks.id
      AND e.actor IN ('claude','codex','pool','local','workbuddy','zcode','autoclaw','dsh')
    ORDER BY e.id LIMIT 1
  )
  WHERE EXISTS (
    SELECT 1 FROM events e WHERE e.task_id = tasks.id
      AND e.actor IN ('claude','codex','pool','local','workbuddy','zcode','autoclaw','dsh')
  );
  UPDATE tasks SET first_executor = executor
  WHERE executor <> 'me'
    AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.kind = 'task.claimed')
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.kind = 'task.executor');
  `,
  // 042.2：把「这活只用读、不改文件」这个约束记在任务上。以前它只活在模型的一次回话里，
  // 后面额度改派、回退规则都看不到它，于是写任务能一路被塞给只读的 dsh。
  // 追加一列，不动历史。
  `
  ALTER TABLE tasks ADD COLUMN route_read_only INTEGER;
  `,
  // 043 F：「只要一个回答」。没勾的任务跑完一个文件都没改，就不算完成（以前算，于是有了假完成）。
  // 老数据：已经按「没有改动」完成过的，本来就是只要回答的活，补成 1，重跑不会突然变失败。
  // 043 C：分类白名单不再当默认拦截手段。值**正好等于**某个出厂默认（042.1 修正后的写法）就清空 = 全接；
  // 用户自己改过的值（哪怕只差一个分类）不动——能判断是不是默认值，所以不算猜。
  `
  ALTER TABLE tasks ADD COLUMN answer_only INTEGER NOT NULL DEFAULT 0;
  UPDATE tasks SET answer_only = 1 WHERE no_changes = 1;
  UPDATE executor_settings SET categories = ''
  WHERE categories IN ('dev', 'dev,docs,content', 'content,docs', 'dev,ops', 'dev,docs,content,ops,personal');
  `,
  // 044：取消「简洁版 / 完整版」（用户 2026-11-03：只是少了点东西，还会吞东西）。存过简洁版的一律回到完整版。
  `
  UPDATE settings SET value = 'full' WHERE key = 'ui_mode';
  `,
  // 043：洗历史。025 之前点过「重试合并」的任务会永久留着 retry='merge'，哪怕后来每次领取都
  // 卡在执行阶段（项目没配、连分支都没跑）——卡片于是永远给「重试合并」，点一次还是同一个原因。
  // 新数据由 finishTask 的 retry: null 保证；这条只清理已经脏掉的老行。
  `
  UPDATE tasks SET retry = NULL
  WHERE status = 'failed' AND retry = 'merge'
    AND (fail_reason LIKE '没有配置项目路径%' OR fail_reason LIKE '没有配置执行者%');
  `,
  // 045：运行与账号槽。一个任务可以跑很多次，每次是一条 runs；重试不再覆盖上一次。
  // 账号槽 = accounts 里 slot_dir 非空的那几行：只记目录名，不记任何凭据。
  // 回填只补「真的开跑过」的任务（started_at 非空），读不出来的字段留空，不猜（031a.1）。
  `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    executor TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT '',
    backend TEXT,
    model TEXT NOT NULL DEFAULT '',
    slot TEXT NOT NULL DEFAULT '',
    route TEXT NOT NULL DEFAULT '',
    sandbox TEXT NOT NULL DEFAULT 'none',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT NOT NULL DEFAULT 'running',
    reason TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    tokens_base INTEGER NOT NULL DEFAULT 0,
    backfilled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, attempt);
  CREATE INDEX IF NOT EXISTS idx_runs_slot ON runs(slot, started_at);
  ALTER TABLE approvals ADD COLUMN run_id INTEGER;
  ALTER TABLE accounts ADD COLUMN slot_dir TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN label TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN slot_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE accounts ADD COLUMN slot_priority INTEGER NOT NULL DEFAULT 50;
  INSERT INTO runs (task_id, attempt, executor, backend, route, started_at, ended_at, outcome, reason, tokens, backfilled)
  SELECT id, 1, COALESCE(NULLIF(first_executor, ''), executor), backend,
         CASE WHEN route = 'brain' THEN 'brain' ELSE '' END,
         started_at,
         CASE WHEN status IN ('done', 'failed') THEN COALESCE(completed_at, updated_at) END,
         CASE status WHEN 'done' THEN 'done' WHEN 'failed' THEN 'failed' ELSE 'running' END,
         CASE WHEN status = 'failed' THEN fail_reason END,
         tokens_used, 1
  FROM tasks
  WHERE started_at IS NOT NULL AND status IN ('done', 'failed', 'running', 'review');
  `,
  // 048：执行器领取待回写评论。租约让同一条评论不会同时交给两个执行器。
  `
  CREATE TABLE github_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL UNIQUE,
    dedupe TEXT UNIQUE,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    lease TEXT NOT NULL DEFAULT '',
    available_at TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    sent_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_github_outbox_pending ON github_outbox(sent_at, available_at, id);
  `,
  // 055.1：自媒体数据看板。一条内容在一个平台上的一次发布一行；数据只追加快照，不覆盖，曲线从快照画。
  `
  CREATE TABLE media_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    piece TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    task_id INTEGER,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_media_posts_platform ON media_posts(platform, published_at);
  CREATE TABLE media_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, followers INTEGER,
    source TEXT NOT NULL DEFAULT 'manual'
  );
  CREATE INDEX idx_media_stats_post ON media_stats(post_id, at);
  CREATE TABLE media_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL DEFAULT '',
    followers INTEGER,
    at TEXT NOT NULL
  );
  CREATE INDEX idx_media_accounts ON media_accounts(platform, at);
  `,
  // 055.2：提问卡片。agent 在回答末尾附 wb-ask，执行器报上来，存成一行，等人选。
  // status：open（等你选）→ answered（你选了，等执行器来取）→ taken（执行器取走了，只取一次）；
  // 你终止 / 重新开始 / 删任务时，没走完的置 cancelled。
  // session_id 是原会话（沙箱任务留空：会话随容器销毁）；prior_result 是上一轮的回答，接不上原会话时当资料带上。
  `
  CREATE TABLE task_asks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    cards TEXT NOT NULL DEFAULT '[]',
    answers TEXT NOT NULL DEFAULT '{}',
    session_id TEXT NOT NULL DEFAULT '',
    sandbox TEXT NOT NULL DEFAULT 'none',
    prior_result TEXT NOT NULL DEFAULT '',
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    taken_at TEXT
  );
  CREATE INDEX idx_task_asks_task ON task_asks(task_id, status);
  `,
  // 046.8：收尾上报的幂等键。执行器回报 finish 遇到断网会重发，同一个键第二次到达时什么都不做——
  // 否则会多建一条合并审批、多记一条日志。
  `ALTER TABLE tasks ADD COLUMN finish_key TEXT NOT NULL DEFAULT ''`,
];

export function openDb(file: string = process.env.WB_DB ?? './data/workbench.db', opts: { at?: number } = {}): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db, opts.at);
  return db;
}

/**
 * 测试要造「上一版」的库时，别再靠 `user_version - 1`——那只在「我刚加的就是最后一条」时成立，
 * 下一条迁移一进来就假红（041 和 042 各踩过一次）。按「哪一条迁移加了这一列」去查，永远准。
 */
export function versionAfter(pattern: string): number {
  const i = MIGRATIONS.findIndex((m) => m.includes(pattern));
  return i < 0 ? MIGRATIONS.length : i + 1;
}

function migrate(db: DB, until = MIGRATIONS.length): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const stop = Math.min(until, MIGRATIONS.length);
  for (let v = row.user_version; v < stop; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

let current: DB | null = null;
export function db(): DB {
  if (!current) current = openDb();
  return current;
}
/** Tests swap in an in-memory database. */
export function useDb(next: DB): void {
  current = next;
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}
