# CLAUDE.md — 给接手维护的 coding agent

这是一个**单用户、自托管**的 AI 工作台。读完这页再动手。用户文档在 README.md。

**分工**：决策端（可以是 Claude，也可以是任何能读仓库、能跑命令的模型）写需求单、界面和安全核心，并审查本机实现；本机 agent 实现其他任务、做真机验证和独立安全复核，部署由用户批准。待办的需求单在 `docs/specs/`，流程和回报模板见 `docs/specs/README.md`。只做需求单里写的事，拿不准就停下来问用户。

## 硬约束

- **零 npm 依赖。** 运行时只有 Node ≥ 22.18 的内置模块（`node:http`、`node:sqlite`、`node:crypto`、`node:test`）。不要加 Express / React / ORM / Tailwind / 构建工具。真觉得非加不可，先停下来问用户。
- **Node 直接跑 `.ts`（type stripping），没有编译。** 所以：
  - import 必须带 `.ts` 后缀；纯类型 import 用 `import type` 或 `import { type X }`。
  - 禁止 `enum`、`namespace`、构造函数参数属性（`constructor(public x)`）、装饰器等需要转译的语法。
  - 运行在用户机器上的脚本（`scripts/*.mjs`）用纯 JS，只要求 Node 18+。
- **界面文案是中文。** 新增文案保持口语、简短，和现有页面一致。
- **所有 HTML 都用 `html\`\`` 模板**（`src/views/html.ts`），它会自动转义。不要拼接字符串插入用户内容，不要用 `raw()` 包用户数据。
- **改数据库只能追加迁移**（`src/db.ts` 的 `MIGRATIONS` 数组末尾加一条），永远不要改已有的迁移。

## 目录

各组件跑在哪台机器上、哪些是可选的（工作台 / 执行器 / 反代 / Hook / GitHub），以 README 的「执行架构」一节为准；这里只列代码目录。

```
src/
  server.ts          入口：检查 WB_TOKEN、打开数据库、启动 HTTP
  app.ts             路由表 + 请求处理（页面、/api/*、静态文件、鉴权、错误）
  auth.ts            单令牌鉴权：Bearer（脚本）/ HttpOnly Cookie（浏览器）、同源检查
  db.ts              node:sqlite、迁移、tx()
  domain.ts          执行者 / 状态 / 分类 / 风险的定义、时间与格式化工具
  services/
    core.ts          HttpError、审计日志 logEvent、输入校验小工具
    tasks.ts         任务 CRUD、会话 → 任务映射
    approvals.ts     审批规则匹配、审批创建 / 决定 / 过期、Claude Code hook 事件处理
    media.ts         自媒体账号、内容和数据快照
    metrics.ts       用量入库与统计、账号额度、机器心跳、各页面聚合数据、pulse
  views/media.ts     自媒体页面
  views/             服务端渲染页面（每页一个文件）+ components.ts 共享组件 + layout.ts 侧边栏
public/
  style.css          全部样式；颜色等设计变量在 :root
  app.js             渐进增强：data-api 表单、data-api-click 按钮、data-api-toggle 勾选框、自动刷新
scripts/
  claude-hook.mjs    装在用户电脑上的 Claude Code hook
  sync-usage.mjs     读本地会话日志上报 token
  lib/sandbox/       沙箱 provider、代理、模型网关和补丁检查
  sandbox/           容器入口
  heartbeat.sh       服务器心跳
  seed.ts            演示数据
docker/sandbox/      任务沙箱镜像定义

test/api.test.ts     端到端测试
```

## 核心概念

- **控制面**。工作台负责派单、审批、审计和数据，执行器在宿主领取任务并调用编码工具，可选将代码任务放进一次性 Docker 容器。
- **运行记录**。`runs.sandbox` 记录实际模式 `docker` 或 `none`，可从 `GET /api/tasks/:id/runs` 查询。任务详情当前尚未显示这个字段。

- **任务** `tasks.status`：`inbox`（待分派）→ `queued` → `running` → `review`（有待审批）→ `done` / `failed`。`executor`：`claude | codex | pool | local | me`。`me` 的未完成任务就是「我的待办」。
- **审批** `approvals.status`：`pending` → `approved | rejected | changes | takeover | expired`。
  - 创建审批会把任务置为 `review`；所有待审批处理完后任务回到 `running`；`takeover` 把任务改成 `executor=me, status=inbox`。
  - `changes` 必须带 feedback；feedback 会作为 deny 理由发回给 agent。
- **规则** `rules`：`tool_pattern` 整体匹配工具名，`input_pattern` 在「命令 / 文件路径 / 整个输入 JSON」里搜索（不区分大小写），多条命中取风险最高。
- **会话任务**：Claude Code 的 `session_id` 对应唯一一个任务（`tasks.session_id` 唯一索引），第一次收到该会话的 hook 事件时自动创建。
- **审计**：凡是改变状态的操作都要 `logEvent()`。`actor` 用 `me` / `system` / 执行者 key。
- **自动刷新**：浏览器每 8 秒请求 `/api/pulse`，值变了且用户没在输入就刷新。新增会影响页面的表，记得把它加进 `pulse()`。

## 常见改动怎么做

- **加一个页面**：`src/views/xxx.ts` 导出返回 `Safe` 的函数 → `app.ts` 里 `on('GET', '/xxx', …, { page: true })` → `layout.ts` 的 `navGroups` 加入口。
- **加一个接口**：业务逻辑放 `services/`，校验失败抛 `HttpError(400, '中文原因')`；`app.ts` 里 `on(...)` 注册。默认需要鉴权，公开接口显式传 `{ public: true }`。
- **加字段 / 表**：在 `MIGRATIONS` 末尾追加 SQL；更新对应 service 的类型和 `clean()` 校验。
- **前端交互**：优先用 `data-api` 系列属性，避免写新 JS。确实要写就加在 `public/app.js`，保持无框架。
- **新的执行者**：只改 `domain.ts` 的 `EXECUTORS`（和 `AGENT_EXECUTORS`），其他地方都从这里读。
- **新的额度来源**：写适配器（`services/balances.ts` 或读取器配置）→ 在 `services/sources.ts` 的 `SOURCES` 加一项（`configured` / `lastOk` / `nextStep`）→ 加测试。接入状态面板、`GET /api/sources`、停用开关都从注册表读，别处不用改。

## 验证

```bash
npm test                         # 必须全绿
npm run dev                      # 然后打开 http://localhost:3200 实际点一遍改动的页面
WB_DB=/tmp/demo.db npm run seed  # 想看满数据的样子
```

改动涉及 hook 行为时，`test/api.test.ts` 里「claude-hook.mjs (real script)」那组测试会真的起子进程跑脚本，保持它们通过。

## 设计

视觉稿在用户的 Claude 设计画布「个人 AI 工作台」。设计变量（`public/style.css` 的 `:root`）：底色 `#F4F4F0`、面板白、墨色 `#18181B`、强调色荧光黄绿 `#D7F25A`（只用在主按钮和当前导航）、警示橙 `#9A3412`/`#FFF6EE`、危险红 `#B91C1C`。执行者配色在 `domain.ts`。不引入外部字体（国内网络访问不了 Google Fonts），用系统字体栈。
