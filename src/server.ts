import { createServer } from 'node:http';
import { authConfigured, AUTH_DISABLED, passwordProblem, syncPasswordFingerprint } from './auth.ts';
import { handle } from './app.ts';
import { db } from './db.ts';
import { displayHost, listenHost } from './listen.ts';
import { startConnector } from './services/cliproxyapi.ts';
import { startBalances } from './services/balances.ts';
import { startBackup } from './services/backup.ts';
import { startDigest } from './services/digest.ts';
import { startHandoffWatch } from './services/runner.ts';
import { reconcileRuns, scrubRuns } from './services/runs.ts';

if (!authConfigured()) {
  console.error('缺少 WB_TOKEN（至少 12 位）。生成一个：  openssl rand -hex 24\n仅本机调试可设 WB_NO_AUTH=1。');
  process.exit(1);
}
if (AUTH_DISABLED) console.warn('⚠ WB_NO_AUTH=1：已关闭鉴权，只能在本机调试时用。');

// 008.3: the password is a separate secret; it must exist and must not be the token.
const pwProblem = passwordProblem();
if (!AUTH_DISABLED) {
  if (process.env.WB_PASSWORD && process.env.WB_PASSWORD === process.env.WB_TOKEN) {
    console.error('WB_PASSWORD 不能和 WB_TOKEN 相同：一个是给人的密码，一个是给脚本的令牌。');
    process.exit(1);
  }
  if (pwProblem) console.warn(`⚠ ${pwProblem}`);
}

db(); // open + migrate before accepting traffic
scrubRuns(); // 045.2：补打码第一版留下的运行原因（幂等）
reconcileRuns();

// 015.3: a changed WB_PASSWORD must invalidate every browser that is still logged in.
const fp = syncPasswordFingerprint();
if (fp === 'changed') console.log('WB_PASSWORD 换过了：清掉了所有已登录的浏览器会话。');

const port = Number(process.env.PORT ?? 3200);
// 024a.1：默认 127.0.0.1。要局域网访问（或容器里映射端口）才设 HOST=0.0.0.0。
const host = listenHost();
createServer((req, res) => { void handle(req, res); }).listen(port, host, () => {
  console.log(`工作台已启动：http://${displayHost(host)}:${port}`);
  startConnector();
  startBalances();
  startBackup();
  startDigest();
  // 035.3：部署之后没人接班，5 分钟就该有人知道，而不是等到有人打开页面才发现。
  startHandoffWatch();
});
