# 在 Windows 上安装（给 coding agent 的执行说明）

把下面整段交给在这台 Windows 电脑上运行的 coding agent（Claude Code / Codex 等）。

---

你在一台 Windows 电脑上，用 PowerShell 操作。任务：把「个人 AI 工作台」部署到这台电脑，让它常驻运行、开机自启、局域网可访问。

整体架构（每个组件跑在哪台机器、哪些是可选的）以 README 的**「执行架构：谁在哪台机器上跑什么」**一节为准，这页不重复，只讲这台 Windows 上怎么装起来。

## 现状

- 项目已解压在 `C:\Users\you\ai-workbench`（如果不在，先找到含 `src\server.ts`、`docker-compose.yml` 的目录）。
- 这是一个**零依赖**的 Node 应用：只需要 Node ≥ 22.18（用到内置的 `node:sqlite` 和直接运行 `.ts`），没有 `npm install`、没有构建步骤。启动命令：`npm start`（等价于 `node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/server.ts`，会自己读同目录的 `.env`）。
- 配置靠环境变量：`WB_TOKEN`（脚本令牌，≥12 位，必填）、`WB_PASSWORD`（网页登录密码，≥12 位，必填）、`WB_DB`（SQLite 文件路径）、`PORT`（默认 3200）、`WB_TZ`（默认 Asia/Shanghai）。
- 项目目录里已有 `.env`，其中 `WB_TOKEN=` 已经生成好。**不要重新生成或修改令牌**，用户已经记下了。
- Windows 防火墙已放行 TCP 3200 入站（规则名 `AI Workbench`），不用再加。
- 已知网络问题：这台电脑**连不上 Docker Hub**（`docker compose up -d --build` 拉 `node:22-slim` 时先报 401，执行 `docker logout` 后报 EOF），`git clone` GitHub 也失败过（schannel 握手失败）。

## 规则

- 不要修改 `src/`、`public/`、`scripts/` 里的应用代码。
- 不要关闭鉴权（不要设 `WB_NO_AUTH`）。
- 不要往数据库写演示数据（不要运行 `scripts/seed.ts`），除非用户明确要求。
- 改系统级设置（Docker Desktop 代理、系统代理、安装软件、计划任务）前，先用一句话告诉用户你要改什么。
- 每走完一步都要验证结果，失败就换下一条路，不要反复重试同一条命令。

## 第 0 步：检查 .env

```powershell
cd C:\Users\you\ai-workbench
Get-Content .env
Format-Hex .env | Select-Object -First 1
```
- `.env` 里必须有一行 `WB_TOKEN=<至少 12 位>`（给脚本和 Agent 用），以及一行 `WB_PASSWORD=<至少 12 位>`（给你自己在网页上登录用）。两者不能相同。
- **2026-10-29 起**：登录页要的是 `WB_PASSWORD`，不再是 `WB_TOKEN`。升级后已登录的浏览器（包括装成桌面应用的窗口）会失效，用新密码重新登录一次即可。
- 文件开头不能有 BOM（`EF BB BF`）。如果有，去掉 BOM 重写，内容不变：
  ```powershell
  $c = Get-Content .env -Raw; [IO.File]::WriteAllText("$PWD\.env", $c.TrimStart([char]0xFEFF), (New-Object Text.UTF8Encoding $false))
  ```

## 路线 A（优先）：Docker

目标是让本地有一个可用的 `node:22-slim` 镜像，然后 `docker compose up -d --build`。按顺序尝试，成功一个就停：

1. 本地是否已经有可用的 Node 镜像：`docker images node`。如果有 `node:22-slim`，直接跳到第 4 步。
2. 从国内镜像源拉取，再改名：
   ```powershell
   docker pull docker.m.daocloud.io/library/node:22-slim
   docker tag docker.m.daocloud.io/library/node:22-slim node:22-slim
   ```
   不通的话，看 Docker Desktop 的 Settings › Docker Engine 里有没有配置 `registry-mirrors`，用那里的地址替换 `docker.m.daocloud.io` 再试一次。
3. 检查本机是否开着代理工具：`netstat -ano | findstr LISTENING | findstr "7890 7897 10809 1080"`。有的话，告诉用户需要在 Docker Desktop 的 Settings › Resources › Proxies 里把 HTTP/HTTPS 代理设为 `http://127.0.0.1:<端口>`，请用户确认或自己去点。设置并重启 Docker 后，再 `docker pull node:22-slim`。
4. 构建并启动：
   ```powershell
   docker compose up -d --build
   docker compose ps
   ```
   确认容器状态是 running / healthy。
5. 开机自启：容器已设置 `restart: unless-stopped`。提醒用户在 Docker Desktop 设置里勾选 **Start Docker Desktop when you sign in**。

三种拿镜像的办法都失败，就转路线 B。

## 路线 B（备选）：直接用 Node 运行

1. 检查版本：`node -v`。需要 **v22.18 及以上**（v24 也可以）。
2. 版本不够或没装：先告诉用户，再执行 `winget install OpenJS.NodeJS.LTS`。winget 不通，就让用户从 https://npmmirror.com/mirrors/node/ 下载最新 LTS 的 msi 安装。装完新开一个 PowerShell，确认 `node -v`。
3. 在项目目录创建启动脚本 `start-workbench.ps1`：
   ```powershell
   $ErrorActionPreference = 'Stop'
   Set-Location $PSScriptRoot
   foreach ($line in Get-Content .env) {
     if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), 'Process') }
   }
   $env:WB_DB = "$PSScriptRoot\data\workbench.db"
   if (-not $env:PORT) { $env:PORT = '3200' }
   node --disable-warning=ExperimentalWarning src/server.ts *>> "$PSScriptRoot\data\server.log"
   ```
   先建好 `data` 目录。前台运行一次，看到「工作台已启动」后按 Ctrl+C 停掉。
4. 告诉用户后，注册登录时自动启动的计划任务（隐藏窗口）：
   ```powershell
   $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PWD\start-workbench.ps1`""
   $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   # 不要写 -ExecutionTimeLimit 0：它在任务 XML 里落成 PT0S，部分 Windows 会当成
   # 「零秒超时」，任务一启动就被结束，LastTaskResult 是 3221225786（0xC000013A）。
   # 用 3650 天表示不限时长。
   $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
   Register-ScheduledTask -TaskName 'AI Workbench' -Action $a -Trigger $t -Settings $s -Description '个人 AI 工作台' -Force
   Start-ScheduledTask -TaskName 'AI Workbench'
   ```

## 让执行器（runner）也开机自启

容器跑起来只是「网页能开」，真正干活的是宿主机上的 `scripts/runner.mjs`：它去领任务、开 worktree、调 Claude Code。没有它，点了「开始」的任务会一直排队。

1. 先自检：`node scripts/runner.mjs --check`，最后一行是「一切就绪，可以跑任务了」再往下做。
2. 建一个「登录时运行」的计划任务，**动作指向守卫脚本**而不是 runner 本体——守卫用 pid 锁文件保证同时只有一个 runner 在跑：
   ```powershell
   $node = (Get-Command node).Source
   $repo = (Get-Location).Path
   $guard = Join-Path $repo 'scripts\runner-guard.mjs'
   # 054：先把隐藏启动器装到仓库外（%LOCALAPPDATA%\ai-workbench\launch-hidden.vbs），重复跑安全。
   node scripts\install-launcher.mjs --repo $repo --node $node
   $vbs = Join-Path $env:LOCALAPPDATA 'ai-workbench\launch-hidden.vbs'
   # 054 取代 043 的做法：窗口样式 0 = 进程创建时就不分配可见控制台，Windows Terminal 的
   # 控制台交接（黑框的来源）无从发生。043 的 -WindowStyle Hidden 只管 conhost 那一层，
   # 默认终端是 Windows Terminal 时管不住它的顶层窗口，关掉那个窗口执行器整棵树就没了。
   $action  = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//nologo `"$vbs`" `"$node`" `"$guard`"" -WorkingDirectory $repo
   $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -StartWhenAvailable
   Register-ScheduledTask -TaskName 'AI Workbench Runner' -Action $action -Trigger $trigger -Settings $settings -Force
   Start-ScheduledTask -TaskName 'AI Workbench Runner'
   ```
3. 验证：`Get-ScheduledTaskInfo -TaskName 'AI Workbench Runner'` 的 `LastTaskResult` 应为 `267009`（正在运行），网页「执行者」页应出现一台在线机器。日志在 `%LOCALAPPDATA%\ai-workbench\`：`runner-autostart.log` 是守卫和 runner 的控制台输出，`runner-<日期>.log` 是 runner 自己的步骤流水。

> **已经用 043 方式注册过的机器**：不用删任务重来，停掉 Runner 后跑一遍 `node scripts\install-launcher.mjs`，它会就地把两个任务的动作换成启动器，再 `Start-ScheduledTask` 即可。
>
> **VBScript 是微软宣布弃用的组件**。哪天 Windows 移除了 wscript，改走「不管用户是否登录都运行」（`LogonType=Password`）：session 0 里根本没有窗口，代价是要输一次密码、Docker 管道与网络凭据需要重验——见 `docs/specs/054-codex.md`。

> **别把 `-ExecutionTimeLimit` 写成 `0`。** 它在任务 XML 里落成 `PT0S`，部分 Windows 会当成「零秒超时」，任务一启动就被结束，`LastTaskResult` 是 `3221225786`（`0xC000013A`），日志里只有开头一行。

## 再加一个看护任务（每分钟一次）

守卫负责「runner 卡住了就重开」，但它自己也会被带走：2026-11-06 那一晚，guard 和 runner 一起消失，日志里一行都没留下（JS 层根本没执行）。所以再加一个**每分钟新起一次的**计划任务，它只做一件事——看心跳文件，停了就拉起来，并把现场写进日志。

```powershell
$node  = (Get-Command node).Source
$repo  = (Get-Location).Path
$watch = Join-Path $repo 'scripts\watch-runner.mjs'
# 054：与 Runner 同款隐藏启动器（install-launcher.mjs 上面那步已经装好 vbs）。
$vbs = Join-Path $env:LOCALAPPDATA 'ai-workbench\launch-hidden.vbs'
$action  = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//nologo `"$vbs`" `"$node`" `"$watch`"" -WorkingDirectory $repo
# 从两分钟后开始，之后每分钟一次，不限次数；一次跑完就退出，不常驻。
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
Register-ScheduledTask -TaskName 'AI Workbench Watchdog' -Action $action -Trigger $trigger -Settings $settings -Force
```

判断只看 `%LOCALAPPDATA%\ai-workbench\runner.beat`：runner 每 30 秒写一次，**超过 90 秒没动**就算停了。不看计划任务状态——`Running` 只代表外层 powershell 在等，`Ready` 也不代表执行器没了（那天任务显示 `Ready`，guard 和 runner 都还在跑）。

- 正常时它一声不响，日志里没有任何新行。
- 出事了才写 `watch.log`：时间、原因、计划任务状态、心跳内容、`runner` 相关进程快照（pid / 父进程 / 启动时间 / 命令行）、最近十分钟的系统事件，然后是拉起结果，以及 20 秒后心跳有没有续上。
- 拉起来之后 5 分钟内不再拉第二次（配置错的时候不至于每分钟刷一遍）；下一轮如果心跳还是停的，会再拉一次并重新记现场。

> **工作树要停在带这个脚本的分支上。** 任务跑的是仓库里的 `scripts/watch-runner.mjs`，不是复制出去的一份。切到没有这个文件的分支（或删了工作树），任务每分钟都会失败，而失败是静默的——`watch.log` 一个字都不会写。查 `(Get-ScheduledTaskInfo -TaskName 'AI Workbench Watchdog').LastTaskResult`，非 `0` 就是这个原因。

## 验证（两条路线都要做）

```powershell
Invoke-RestMethod http://localhost:3200/api/health          # 应返回 ok = True
(Invoke-WebRequest http://localhost:3200/login -UseBasicParsing).StatusCode   # 应为 200
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Invoke-RestMethod "http://${ip}:3200/api/health"             # 局域网地址也应返回 ok
```
再用令牌验证 API 鉴权：
```powershell
$tok = (Get-Content .env | Where-Object { $_ -like 'WB_TOKEN*' } | Select-Object -First 1).Split('=', 2)[1].Trim()
Invoke-RestMethod http://localhost:3200/api/tasks -Headers @{ Authorization = "Bearer $tok" }   # 应返回空数组，不报 401
```

## 自动备份：设置备份目录（014）

工作台每天 03:30（`WB_TZ`）把数据库快照写成 `<项目>_<日期>_<时间>_<版本>.db`，旁边一份同名 `.json` 记着时间、版本、迁移序号和各项数量，保留最近 30 份。目录由 `WB_BACKUP_DIR` 指定，**只要是这台电脑上的普通文件夹就行**，是不是网盘同步目录都可以。

1. 建一个文件夹（名字随意，别有结尾空格）：
   ```powershell
   New-Item -ItemType Directory -Force 'C:\Users\you\wb-backups' | Out-Null
   ```
2. 在 `.env` 末尾加一行，**用正斜杠**（反斜杠在 `.env` 里容易被当成转义）：
   ```
   WB_BACKUP_DIR=C:/Users/you/wb-backups
   ```
   路径里有空格或中文也可以，不用加引号，例如 `WB_BACKUP_DIR=C:/Users/you/我的 备份`。
3. 重建容器让挂载生效（路线 A）：
   ```powershell
   docker compose up -d
   docker compose exec workbench ls -l /backups
   ```
   路线 B 不用改挂载，但 `.env` 里的变量名要换成 `WB_BACKUP_PATH`（直接跑 Node 时没有容器，路径就是这台电脑上的路径）。
4. 打开网页「设置 › 自动备份」，点**立即备份**。文件夹里应马上多出一对 `.db` / `.json` 文件，页面上也能看到文件名和大小。

### 用 Google 云端硬盘同步（用户在用这个）

**不要**把 `WB_BACKUP_DIR` 设成 `G:\我的云端硬盘` 这类虚拟盘符：Google Drive for desktop 默认是「在线流式」模式，那是虚拟盘，Docker 挂载它经常失败或者写不进去。正确做法：

1. `WB_BACKUP_DIR` 设成普通本地文件夹，比如上面的 `C:\Users\you\wb-backups`。
2. 打开 Google Drive for desktop › 齿轮 › **偏好设置 › 我的电脑 › 添加文件夹**，把这个文件夹加进去，选**同步到 Google 云端硬盘**。
3. 之后每次备份，Drive 客户端会自己上传。Google 云端硬盘同步要走代理，代理不稳时会晚一些传上去，**本地那份不受影响**。

OneDrive、坚果云、百度网盘同步盘同理：把 `WB_BACKUP_DIR` 指向它们的同步文件夹，或者把普通文件夹加进它们的同步列表。

> 备份文件里有任务、审批、用量和推送渠道地址（**没有** key 和令牌，登录会话也已删除）。当成敏感文件：只放在自己的网盘里，不要分享链接。

### 用备份恢复

恢复要停容器，网页上不做一键恢复（在网页上换数据库不安全）：

```powershell
# 1. 停服务
docker compose down
# 2. 把要恢复的那份放进数据卷（备份文件名按需替换）
docker run --rm -v ai-workbench_workbench-data:/data -v C:/Users/you/wb-backups:/backups `
  node:22-slim sh -c "cp /data/workbench.db /data/workbench.db.before-restore && cp /backups/ai-workbench_2026-10-30_0330_c6c14b2.db /data/workbench.db && rm -f /data/workbench.db-wal /data/workbench.db-shm"
# 3. 起服务
docker compose up -d
```

恢复后数据都在，但**登录会话被删了，需要重新登录一次**（用 `WB_PASSWORD`）。旧库留在数据卷里的 `workbench.db.before-restore`，确认没问题再删。

## 完成后向用户汇报

1. 用了哪条路线；中途改过哪些系统设置或装了什么软件。
2. 访问地址：`http://localhost:3200` 和 `http://<局域网IP>:3200`。
3. 令牌在 `C:\Users\you\ai-workbench\.env` 里（不要把令牌贴进聊天记录以外的地方）。
4. 启动、停止、看日志、升级的命令：
   - 路线 A：`docker compose up -d` / `docker compose down` / `docker compose logs -f` / 换新代码后 `docker compose up -d --build`
   - 路线 B：`Start-ScheduledTask 'AI Workbench'` / `Stop-ScheduledTask 'AI Workbench'` / 日志在 `data\server.log` / 换新代码后先停再启
5. 数据位置：路线 A 在 Docker 卷 `ai-workbench_workbench-data` 里，路线 B 在 `data\workbench.db`。自动备份每天 03:30 写到 `WB_BACKUP_DIR`（见上一节），网页「设置 › 自动备份」可以看到上次的时间、文件名和大小，也能立刻备份一次。

## 可选的任务沙箱和 Clash fake-ip

工作台服务和任务沙箱分别启动。先启动 Docker Desktop，在执行器的仓库目录运行 `npm run sandbox:build`。Debian 软件源报错可加 `-- --apt-mirror mirrors.tuna.tsinghua.edu.cn`。构建成功后，给 `~/.ai-workbench-runner.json` 里的 API Key Claude Code 执行者加 `"sandbox": "docker"`，建议放在 `executors.pool` 内。其他执行者继续使用 `none`，执行者配置优先于全局配置。配置保存后重启执行器守卫。

Clash 使用 fake-ip 时，在执行器配置顶层加 `"sandboxFakeIp": true`。这个选项只对白名单域名启用 IPv4 fake-ip 兼容，内部名称和其他私网目标继续拒绝。PowerShell 验证命令如下。

```powershell
$env:WB_SANDBOX_FAKEIP = '1'
node --test test/sandbox0462-docker.test.ts
Remove-Item Env:WB_SANDBOX_FAKEIP
```

检查输出中 `proxyAllowed` 为 200，`proxyDenied`、`proxyInternal` 为 403。`dnsEmbedded` 应为 false。网页打开不代表沙箱可用，最终用一个只改文档的任务核对运行记录 API 的 `sandbox=docker`，再确认生成合并审批。

### 看护运行时的暂停与待改事项

需要故意停下执行器时，先运行 `Disable-ScheduledTask -TaskName 'AI Workbench Watchdog'`，再停 Runner。只停 Runner 会被每分钟的看护重新拉起。恢复时用 `Enable-ScheduledTask -TaskName 'AI Workbench Watchdog'`。

- 待改：为 `watch.log` 设置大小上限或轮转。
- 待改：Runner 计划任务不存在时，不要每隔静默期重复记录启动失败。
