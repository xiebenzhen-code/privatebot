# 给 agent 的安装手册

你在给一个用户装**工作台**（ai-workbench）：一个跑在他自己机器上的、单用户的 AI 工作台。派任务给 coding agent、审批、看用量。

**做完的样子**：工作台在 `http://localhost:3200` 能登录，执行器在线，`GET /api/setup/status` 里六项必做全部 `ok: true`，能跑完一个只读示例任务。

只读这一页就够。要懂内部结构了再去看 `README.md` 的「执行架构」一节，**不要**去读 `docs/specs/` 里那几十张需求单。

---

## 0. 三条硬规矩

1. **不碰用户的密钥**。key、令牌、密码不写进仓库、不提交、不贴进聊天、不写进日志。key 只从环境变量或文件读。
2. **不替用户批审批、不替用户点「开始」**。审批是用户的权利，你只准备到「等用户点」。
3. **遇到要装系统软件、要管理员权限、要用户登录某个账号，停下来问用户**。别自己装 Node、Docker、Claude Code。

---

## 1. 先检查环境（只读，不改任何东西）

Windows（PowerShell）：

```powershell
node -v
git --version
docker --version
claude --version
```

macOS / Linux：

```bash
node -v && git --version && docker --version && claude --version
```

| 命令 | 期望看到 | 没有怎么办 |
|---|---|---|
| `node -v` | `v22.18.0` 或更高 | 停下来告诉用户：「去 nodejs.org 装 LTS，装完重开终端」。**不要自己装** |
| `git --version` | `git version 2.x` | 停下来让用户装 git |
| `docker --version` | `Docker version 2x.x` | 不算错。没有 Docker 就用 `npm start` 直接跑 |
| `claude --version` | `2.x.x (Claude Code)` | 不算错，但执行器没法干活。告诉用户去哪装（Claude Code 官方文档），让他自己装 |

Node 低于 22.18 就别往下走了：`npm start` 会直接报错，装完也是白装。

---

## 2. 问用户四件事（一次问完，别自己发挥）

| # | 问什么 | 说明 |
|---|---|---|
| 1 | 有没有现成的代码仓库要让 AI 改？有就给**完整路径**和一个**短名** | **可以没有**——大多数人没有，就别追问。不给 `--project`，安装脚本会在 `~/ai-projects/first` 建一个空仓库当第一个项目，用户以后在网页上「＋ 新建项目」或重跑 setup 再加。给了的话：短名只用字母、数字、`-`、`_`；路径要存在、是 git 仓库 |
| 2 | 用哪家模型接口：DeepSeek 官方 / 阿里云百炼 / 自定义 | 默认 DeepSeek 官方 |
| 3 | key 怎么给我 | **让用户把 key 放进一个文件（例如 `~/.wb-key`），或者设成环境变量。不要让用户贴进聊天** |
| 4 | 要不要装自动备份、手机访问、GitHub Issue 通道 | 默认都**不装**，以后在网页设置里加 |
| 5 | 要不要让同一 Wi-Fi 下的手机也能打开工作台 | 默认**不要**（024）。要的话加 `--lan`，等于 `.env` 里写 `WB_BIND=0.0.0.0`；局域网是明文，公司/咖啡店的网络别这样开。出门用手机走 Tailscale serve，不要端口转发 |

问完就开干，不要在中途再问第五个问题（第 5 条问完就够了）。真卡住了（比如 key 是 401），把错误原文（脱敏后）给用户，问一句「key 是不是没开通这个模型」。

---

## 3. 装（四步，每步一条命令）

### 3.1 拿代码

```bash
git clone <仓库地址> ai-workbench
cd ai-workbench
```

期望：目录里有 `package.json`、`src/`、`scripts/`。失败：网络问题就重试；私有仓库要用户先配好 git 凭据。

### 3.2 跑安装脚本（不提问模式）

key 从环境变量给（**不要**写成 `--key`，脚本会拒绝）：

```bash
# macOS / Linux
WB_SETUP_KEY_DEEPSEEK='<用户的 key>' node scripts/setup.mjs --yes --json \
  --project my-app=/absolute/path/to/repo --backend deepseek

# Windows PowerShell
$env:WB_SETUP_KEY_DEEPSEEK='<用户的 key>'; node scripts/setup.mjs --yes --json `
  --project my-app=C:/path/to/repo --backend deepseek
```

或者用文件（更稳，不会进 shell 历史）：

```bash
node scripts/setup.mjs --yes --json --project my-app=/path/to/repo --backend deepseek --key-file ~/.wb-key
```

输出是**一行一个 JSON**：

```json
{"step":"env-check","status":"ok","detail":"Node 22.22.2"}
{"step":"project","status":"ok","detail":"my-app 可用"}
{"step":"backend","status":"ok","detail":"DeepSeek 官方 deepseek-chat：可用"}
{"step":"env","status":"ok","detail":"WB_TOKEN 已生成，WB_PASSWORD 已生成"}
{"step":"password","status":"generated","once":true,"value":"..."}
{"step":"config","status":"ok","detail":"项目 my-app；后端 deepseek"}
{"step":"start","status":"skipped","detail":"没替你启动。下一步自己跑：npm start"}
{"done":true,"ok":true,"next":["..."]}
```

**`password` 那一行里的 `value` 是用户登录网页的密码，只出现这一次。** 你的职责：原样转告用户本人（他可以改），然后**忘掉它**——不要写进任何文件、不要贴进汇报以外的位置。令牌（`WB_TOKEN`）不用给人看，它已经在 `.env` 里了。

退出码就是结论：

| 码 | 意思 | 你怎么办 |
|---|---|---|
| 0 | 装好了 | 往下走第 4 步 |
| 1 | 缺必填项（没给项目、没给 key） | 看最后一个事件的 `detail`，把缺的那件问用户 |
| 2 | 环境不满足（Node 太旧等） | 停下来让用户处理，别硬来 |
| 3 | 验证失败（key 401、仓库不对） | 把 `detail` 给用户，问是不是 key 没开通 / 路径错了 |
| 4 | 其他（参数写错等） | 看 stderr，改命令重跑；**重复跑是安全的** |

想先看看会做什么、不写任何文件：加 `--dry-run`。注意它**仍然会校验项目、仍然真调一次模型接口**（只是不落盘），所以 `--project` 和 key 一样要给。

其他参数都可不填，需要时再用：`--tz`（时区，默认 `Asia/Shanghai`）、`--worktree-root`（执行器放工作树的目录）、`--backup-dir`、`--base-url` + `--model`（`--backend custom` 时必填，地址写到 `/v1` 或 `/anthropic` 之前）、`--workbench`（工作台地址，默认 `http://localhost:3200`）。

`--start` 只把选择写进配置，**不会真的替你启动**，启动还是走 3.3。

用户没有现成仓库就**去掉 `--project`**，别替他找、别 `git init` 他的文件夹：脚本验过 key 之后自己建 `~/ai-projects/first`（事件 `{"step":"project","status":"created"}`），重复跑会直接复用。`~/ai-projects/first` 已经存在但不是仓库时退出码 3，问用户换个位置（`--projects-root`）。给 `--project` 时必须写成 `短名=路径`，两半都不能少。

### 3.3 启动工作台

有 Docker：

```bash
docker compose up -d
```

没有 Docker：

```bash
npm start
```

期望：`docker compose ps` 里 `ai-workbench` 是 `healthy`；或 `npm start` 打印出监听端口、没有报错。默认端口 3200。

**监听地址（024a.1）**：`npm start` 默认只绑 `127.0.0.1`，只有本机能打开；要让同一局域网的手机访问，设 `HOST=0.0.0.0`（局域网明文，别在共用网络里这样开）。Docker 那条路由 `WB_BIND` 控制宿主机侧，容器里固定 `HOST=0.0.0.0`，不用你管。两者都**不要**配路由器端口转发。

### 3.4 启动执行器（让它能干活）

```bash
node scripts/runner-guard.mjs
```

期望：第一行说门禁配置就绪，然后每 30 秒心跳一次，**手动启动的这个窗口不能关**（关了就等于没开）。要开机自启见 `docs/INSTALL-WINDOWS.md` 的「让执行器（runner）也开机自启」，那里会把同一个守卫挂到「登录时运行」的计划任务上。

---

## 4. 验证（全过才算装好）

按顺序跑，每一条都有明确判据：

```bash
# 1. 工作台活着
curl -s http://localhost:3200/api/health
# 期望：{"ok":true}

# 2. 执行器自检（在工作台那台机器上；令牌从 .env 读，别打印出来）
WB_TOKEN=$(sed -n 's/^WB_TOKEN=//p' ai-workbench/.env) WB_URL=http://localhost:3200 \
  node scripts/runner.mjs --check
# 期望：最后一行「一切就绪，可以跑任务了。」，退出码 0

# 3. 清单（带令牌读，脚本能读、网页也能看）
curl -s -H "Authorization: Bearer $(sed -n 's/^WB_TOKEN=//p' ai-workbench/.env)" \
  http://localhost:3200/api/setup/status
# 期望：看返回里的 "all_ok"，不要自己数 ok 的个数

# 4. 重启后的自检（Docker 部署才有意义）
npm run postboot
# 期望：最后一行「全部通过（N/N）」，N 随你装了几样而变
```

Windows 的 agent 别用 `sed`，命令见本节末尾的「Windows 写法」。

**第 2 步有一行可能不过**：`编码工具（pool）` 在没装 Claude Code 时是 `✗`，退出码 1。用户不打算自动干活就不会有这个命令，**这不是装坏了**——告诉用户「要自动干活才需要装」，其余行全 `✓` 就算这一步过了。

**第 3 步的 `first_task` 一开始一定是 `false`**——那表示「还没跑过任务」，不是装错了。所以装完那一刻 `all_ok` 是 `false` 属于正常：**到这里就停下，交给用户**——让他在网页上新建一个只读任务点「开始」，跑完 `first_task` 才会变 `true`。不要去点，也不要反复重试到超时。

**第 4 步不追求满分**：没接反代（没有 CLIProxyAPI）时，`反代容器`、`反代模型列表`、`反代里的登录账号`、`容器内连反代` 这几项会显示不过或跳过，那是没装那部分，不是坏了。判据是「最后一行说全部通过，或只有反代相关的几项没过」。

Windows 写法（在项目目录里跑）：

```powershell
$line = Select-String -Path ../.env -Pattern '^WB_TOKEN=' | Select-Object -First 1
$env:WB_TOKEN = $line.Line -replace '^WB_TOKEN=',''
node scripts/runner.mjs --check
Invoke-RestMethod -Uri http://localhost:3200/api/setup/status -Headers @{ Authorization = "Bearer $env:WB_TOKEN" }
```

---

## 5. 出问题看这张表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `npm start` 报 `SyntaxError` 或 `Bad option` | Node 太旧（< 22.18） | 升级 Node，不要试图改代码绕过 |
| 打开 3200 打不开 | 工作台没起 / 端口被占 | `docker compose ps` 看状态；端口占就用 `PORT=3201 npm start` 换一个（Docker 部署的端口写死在 `docker-compose.yml` 的 `3200:3200`，改那里） |
| 页面能开，登录说「网页登录已关闭」 | `.env` 里 `WB_PASSWORD` 没填或少于 12 位，或和 `WB_TOKEN` 相同 | 改 `.env` 后**重启**工作台（只改不重启没用） |
| `docker compose up` 报连不上 Docker Hub | 拉不到 `node:22-slim` | `.env` 里加 `NODE_IMAGE=docker.m.daocloud.io/library/node:22-slim`，重跑 |
| `--check` 说「找不到 claude」 | 没装 Claude Code | 让用户装，装完重开终端 |
| `backend` 一步退出码 3，`detail` 说「key 不对」 | key 错了 / 没开通这个模型 / 用错了站（国内站和国际站 key 不通用） | 让用户确认 key 和站别；百炼的 key 只能在百炼用 |
| `detail` 说「地址或模型名不对」 | `--base-url` 少写或多写了 `/v1` | 地址写到 `/v1` **之前**，例如 `https://api.deepseek.com/anthropic` |
| 清单里 `projects` 一直是 false | 执行器没在跑，或配置里没有项目 | 先跑执行器；没有项目就重跑 setup（不带 `--project` 会建 `~/ai-projects/first`） |
| 清单里 `runner` 变回 false | 执行器窗口被关了，或机器睡眠 | 重新 `node scripts/runner-guard.mjs`；想开机自启见 `docs/INSTALL-WINDOWS.md` |
| 敲了守卫，输出「接手监护，不再起第二个」 | 已经有一个 runner 在跑（多半是开机自启那个） | 不用管：新守卫会接过来看，并请旧守卫让位，始终只有一个 runner |
| PowerShell 说「无法将“node”项识别为…」 | Node 没装，或装完没重开终端 | 装 Node 22.18+，**重开** PowerShell 再试 |
| 执行器窗口一闪就没了 | 缺依赖目录、或配置文件读不出来 | 在同一个窗口里跑 `npm run diagnose`，把输出发出来（已打码） |
| 执行器说「门禁自检失败」 | 项目里有 `.claude/settings.json` | 删掉那个文件，或者换一个没有它的仓库 |
| 任务一直「排队」 | 执行器没开 / 任务没人点开始 / 执行者被暂停 | 分别检查：执行器在线、点「开始」、设置里的总开关 |
| 任务「可能卡住了」 | 执行器进程没了 | 任务详情里点「标记失败」，重开执行器 |
| 合并 / 推送一直等审批 | 审批只能人来点 | 告诉用户去网页点，**不要自己批** |
| `.env` 里的值好像被改了 | 有人手改过 | setup 只补空值，不改已有值；改的是你自己或用户 |

---

## 6. 做完怎么汇报

按这个模板给用户，别写成长文：

```
装好了：
- 工作台：http://localhost:3200（密码：见下面单独发给你的那条）
- 执行器：在线，项目 <名字>
- 后端：<DeepSeek 官方 / 百炼>，自检通过
- 清单：六项必做全过（first_task 要等你跑一个任务）
没装（按你说的跳过）：自动备份 / 手机访问 / GitHub 通道
下一步建议：新建一个只读任务试试，比如「读一遍 README，用三句话说这个项目做什么」
遗留问题：<没有就写「无」>
```

密码单独说一次，不要在汇报正文里重复第二遍。

---

## 7. 卸载 / 重来

- 配置在 `~/.ai-workbench-runner.json`（执行器）和仓库里的 `.env`（工作台）。删掉这两个就回到没装的状态。
- 数据在 Docker volume `workbench-data`（或 `data/*.db`）。`docker compose down -v` 会**一起删掉数据**，除非用户明确要求，不要执行。
- 重跑 `node scripts/setup.mjs` 是安全的：已有的值不动，只补缺的。

## GitHub 通道（可选）

在执行器的 `~/.ai-workbench-runner.json` 里填 `githubToken`，或只给执行器进程设置 `GITHUB_TOKEN`。令牌只授权需要的仓库，权限给 Issues 读写、Contents 只读。老用户把令牌从工作台 `.env` 移到这里，保留工作台上的 `GITHUB_REPOS`、`GITHUB_ALLOWED_AUTHORS`，再重启工作台和执行器。

如果本机需要代理才能访问 GitHub，在执行器配置加 `githubProxy`，填 HTTP(S) 代理地址。这个设置只用于执行器的 GitHub API 请求，需要支持 `--use-env-proxy` 的 Node（如 22.21 或更新的 LTS）。执行器空闲时每 5 分钟转发，离线时暂缓收发。

## 可选的任务沙箱

先在执行器所在的电脑安装并启动 Docker Desktop，再在仓库根目录运行 `npm run sandbox:build`。第一次需要联网下载 Node 基础镜像和 Claude Code。Debian 源报错时运行 `npm run sandbox:build -- --apt-mirror mirrors.tuna.tsinghua.edu.cn`。

编辑执行器配置 `~/.ai-workbench-runner.json`，在 API Key 类型的 Claude Code 执行者配置里加 `"sandbox": "docker"`，例如 `executors.pool.sandbox`。执行者自己的设置优先于全局设置。第一档支持 Claude Code + API Key，WorkBuddy、dsh 和订阅账号槽继续使用 `"sandbox": "none"`。宿主使用 Clash fake-ip 时，在执行器配置顶层加 `"sandboxFakeIp": true`。保存后重启执行器。

用 PowerShell 跑真容器检查 ` $env:WB_SANDBOX_FAKEIP='1'; node --test test/sandbox0462-docker.test.ts`，未使用 fake-ip 时省去环境变量。白名单应返回 200，其他站点和内部名称应返回 403。执行器仍在宿主运行，任务代码在一次性容器运行，真实模型密钥由网关持有。补丁检查通过后进入合并审批。运行记录 API 的 `sandbox` 字段可核对实际模式，当前详情页尚未显示此字段。
