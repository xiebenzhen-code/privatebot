// 064 · 执行者增减：请进来 / 先歇着 / 叫回来 / 移除。
//
// 执行者是固定的那几种（Claude、Codex、反代池……，见 domain.ts 的 EXECUTORS），这里管的是「谁在你的队伍里」：
//   在队里   enabled = 1               头像亮着，能接活
//   歇着     enabled = 0, resting = 1  头像还在，灰的，不接活；设置都留着，随时叫回来
//   不在队里 enabled = 0, resting = 0  头像没了，在「＋」里，随时请进来
// 手上还有事的不能歇、不能移——先等它做完或换人，免得活悬在半空。
import { db } from '../db.ts';
import { EXECUTORS, execLabel } from '../domain.ts';
import { HttpError, logEvent } from './core.ts';

export type CrewState = 'in' | 'rest' | 'out';
export type CrewInfo = { key: string; label: string; brief: string; state: CrewState; busy: number; /** 派给它、但还没开始的事 */ idle: number };

const known = (key: string): boolean => key !== 'me' && Object.hasOwn(EXECUTORS, key);

/** 手上还没了结的事：排着的、在做的、做到一半停下来等你批准的（review）、等你回话的；以及它正在审的。 */
export function busyCount(key: string): number {
  const own = (db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE executor = ? AND status IN ('queued', 'running', 'review', 'asking')").get(key) as { n: number }).n;
  const reviewing = (db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE reviewer = ? AND review_state = 'reviewing'").get(key) as { n: number }).n;
  return own + reviewing;
}

export function crewInfo(key: string): CrewInfo | null {
  if (!known(key)) return null;
  const row = db().prepare('SELECT enabled, resting FROM executor_settings WHERE executor = ?').get(key) as { enabled: number; resting: number } | undefined;
  if (!row) return null;
  return { key, label: execLabel(key), brief: EXECUTORS[key].brief, state: row.enabled ? 'in' : row.resting ? 'rest' : 'out', busy: busyCount(key),
    idle: (db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE executor = ? AND status = 'inbox'").get(key) as { n: number }).n };
}

/** 「＋」里列的：歇着的在前，然后是不在队里的。 */
export function crewOutside(): CrewInfo[] {
  const rows = db().prepare("SELECT executor FROM executor_settings WHERE enabled = 0 AND executor != 'me' ORDER BY resting DESC, priority, executor").all() as { executor: string }[];
  return rows.map((r) => crewInfo(r.executor)).filter((x): x is CrewInfo => !!x);
}

export function setCrew(key: string, to: CrewState, actor: string): CrewInfo {
  const cur = crewInfo(key);
  if (!cur) throw new HttpError(404, '没有这位执行者');
  if (cur.state === to) return cur;
  if (to !== 'in' && cur.state === 'in' && cur.busy) {
    throw new HttpError(409, `${cur.label} 手上还有 ${cur.busy} 件事：等它做完，或者先把活换给别人`);
  }
  db().prepare('UPDATE executor_settings SET enabled = ?, resting = ? WHERE executor = ?').run(to === 'in' ? 1 : 0, to === 'rest' ? 1 : 0, key);
  const word = to === 'in' ? (cur.state === 'rest' ? '叫回来了' : '请进来了') : to === 'rest' ? '先歇着' : '移出了队伍';
  logEvent({ actor, kind: 'crew.changed', text: `${cur.label} ${word}` });
  return crewInfo(key)!;
}
