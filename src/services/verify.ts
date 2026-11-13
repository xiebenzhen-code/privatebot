// 066 · 执行器自己跑了一遍测试，这里把结果和「执行者怎么说的」对照起来。
//
// 结果是程序的退出码，执行者改不了；它的说法来自它最后那段话。两边对不上，就在点头卡上明说。
// 这里不拦、不打回——只把事实摆出来，决定还是审的那位和你来做。
import type { Task } from './tasks.ts';

export type Verify = {
  status: 'pass' | 'fail' | 'timeout' | 'error' | 'skipped' | 'none';
  cmd: string; code: number; tail: string; ms: number; why: string; where: string;
};

const STATUSES = new Set(['pass', 'fail', 'timeout', 'error', 'skipped', 'none']);
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const clean = (v: unknown, max: number): string => String(v ?? '').replace(INVISIBLE, '').slice(0, max);

/** 执行器报上来的东西只取认得的字段，限长；不认得的状态当没报。 */
export function normalizeVerify(raw: unknown): Verify | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const status = String(o.status ?? '');
  if (!STATUSES.has(status)) return null;
  return {
    status: status as Verify['status'], cmd: clean(o.cmd, 120).replace(/\s+/g, ' '), code: Number.isFinite(Number(o.code)) ? Math.trunc(Number(o.code)) : -1,
    tail: clean(o.tail, 1500), ms: Math.max(0, Math.min(Number(o.ms) || 0, 24 * 3600_000)), why: clean(o.why, 40), where: o.where === 'sandbox' ? 'sandbox' : o.where === 'host' ? 'host' : '',
  };
}

export function verifyOf(t: Pick<Task, 'verify'>): Verify | null {
  if (!t.verify) return null;
  try { return normalizeVerify(JSON.parse(t.verify)); } catch { return null; }
}

/**
 * 它在最后那段话里是怎么说测试的。只认明确的说法；模棱两可的算「没提」。
 * 先看否定（没跑 / 没过），再看肯定——「没有通过」里也有「通过」两个字。
 */
export function claimOf(text: string): 'pass' | 'fail' | 'none' | 'silent' {
  const raw = String(text ?? '').replace(/\s+/g, ' ');
  // 「0 失败」「没有失败」是在说通过：先换成一个记号，免得下面把「失败」两个字当成没过。
  const s = raw.replace(/(^|[^\d.])0\s*个?\s*(failed|failures?|failing|失败)|没有失败|无失败|零失败/gi, '$1 ZEROFAIL ');
  if (!/测试|单测|用例|\btests?\b|npm test|\bpassed\b|\bfailed\b|\d\s*(个|条|项)?\s*(通过|失败)|ZEROFAIL/i.test(s)) return 'silent';
  if (/(没有?|未|尚未|没来得及|无法)\s*(运行|跑|执行)[^。.；;]{0,12}(测试|用例|tests?)|(测试|用例|tests?)[^。.；;]{0,12}(没有?跑|未运行|未执行|没运行|没执行|跑不起来|无法运行)|did ?n[o']t run (the )?tests?|tests? (were )?not run/i.test(s)) return 'none';
  if (/(测试|用例|tests?)[^。.；;]{0,24}(没过|未通过|没有通过|不通过|失败|挂了|报错)|\b[1-9]\d*\s*(failed|failing|个?失败)|tests? (are )?failing/i.test(s)) return 'fail';
  if (/(测试|用例|tests?)[^。.；;]{0,24}(全部|都|均|已)?\s*(通过|跑通|全绿|ok\b)|all tests pass|tests? pass(ed|es)?\b|ZEROFAIL/i.test(s)) return 'pass';
  return 'silent';
}

export type VerifyLine = { level: 'ok' | 'warn' | 'info'; text: string };

const SKIP: Record<string, string> = {
  'scripts-changed': '它改了测试命令本身，工作台没替它跑——这条要你看一眼',
  'sandbox-missing': '沙箱里没跑成测试，没有核对',
  'bad-command': '配置里的测试命令写得不合规，没有核对',
};

/** 点头卡上那一行。没有可说的返回 null。 */
export function verifyLine(t: Pick<Task, 'verify' | 'result_text'>): VerifyLine | null {
  const v = verifyOf(t);
  if (!v) return null;
  const said = claimOf(t.result_text ?? '');
  const where = v.where === 'sandbox' ? '在沙箱里' : '';
  switch (v.status) {
    case 'pass':
      return said === 'fail' || said === 'none'
        ? { level: 'info', text: `测试核对过：通过（它自己说${said === 'fail' ? '没过' : '没跑'}，工作台${where}跑了一遍是过的）` }
        : { level: 'ok', text: `测试核对过：通过（工作台${where}自己跑的 ${v.cmd}）` };
    case 'fail':
      return said === 'pass'
        ? { level: 'warn', text: `它说测试通过，工作台${where}自己跑了一遍：没过` }
        : said === 'none' ? { level: 'warn', text: `它没跑测试，工作台${where}跑了一遍：没过` }
        : { level: 'warn', text: `工作台${where}自己跑了一遍测试：没过` };
    case 'timeout': return { level: 'info', text: `测试跑了 ${Math.max(1, Math.round(v.ms / 60_000))} 分钟还没完，没核对成${said === 'pass' ? '（它自己说通过）' : ''}` };
    case 'error': return { level: 'info', text: '测试命令没跑起来，没核对成' };
    case 'skipped': return { level: v.why === 'scripts-changed' ? 'warn' : 'info', text: SKIP[v.why] ?? '这次没有核对测试' };
    case 'none': return said === 'pass' ? { level: 'info', text: '它说测试通过；这个项目没配测试命令，工作台核对不了' } : null;
  }
}

/** 给审的那位的一句固定的话（只含状态，不含任何输出原文）。没什么可说返回空串。 */
export function verifyForReviewer(t: Pick<Task, 'verify' | 'result_text'>): string {
  const line = verifyLine(t);
  return line && line.level === 'warn' ? `工作台核对的结果：${line.text}。这一条请重点看。` : '';
}
