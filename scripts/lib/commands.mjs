// 034：命令只在这里写一遍。页面、setup 向导、README、AGENT-INSTALL 都跟着它走——
// 之前同一句命令散在六七个地方，改一处漏一处，新用户照着旧的那句敲就撞上「已经有一个在跑」。
//
// 为什么常驻要经过守卫：守卫用 pid 锁保证同时只有一个 runner。手动开的窗口和开机自启撞在一起时，
// 两个 runner 会各领各的任务并行跑，同一份额度花两遍，还会互相踩同一个 worktree。
export const RUNNER_CMD = 'node scripts/runner-guard.mjs';
/** 自检不干活，也不该占位，所以直接问 runner 本体。 */
export const RUNNER_CHECK_CMD = 'node scripts/runner.mjs --check';
/** 报错时唯一要人做的一件事：把这段输出发出来。 */
export const DIAGNOSE_CMD = 'npm run diagnose';
