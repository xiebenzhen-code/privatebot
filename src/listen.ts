// 024a.1：不用 Docker 时（`npm start`、`node src/server.ts`）默认也只绑本机。
//
// 为什么单独放一个模块：Docker 那条路靠 compose 的 `ports: ${WB_BIND:-127.0.0.1}` 控制宿主机侧，
// 但直接跑 Node 时没有任何东西管监听地址——不设 HOST 就监听所有网卡，一开机就被整个局域网看见。
// 这里把判断收成纯函数，便于测试，也免得 server.ts 一 import 就真的起服务。

/** 监听地址：没设 HOST 就是 127.0.0.1；显式设成 0.0.0.0 才对外（局域网/容器内）。 */
export const listenHost = (env: Record<string, string | undefined> = process.env): string => {
  const raw = String(env.HOST ?? '').trim();
  return raw || '127.0.0.1';
};

/** 日志里给人看的地址：监听所有网卡时显示 localhost。 */
export const displayHost = (host: string): string =>
  host === '0.0.0.0' || host === '::' || host === '127.0.0.1' ? 'localhost' : host;
