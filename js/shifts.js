// バイトのシフト：繰り返しの展開・例外・集計・重なり検出・カレンダー出力
//
// シフトの形（1件 = 単発 or 毎週のシリーズ）
// {
//   id, kind: 'once' | 'weekly',
//   place: '塾講師',            勤務先・種類
//   date: '2026-11-03',         単発のときの日付
//   weekday: 2,                 毎週のときの曜日（0=日 … 6=土）
//   from: '2026-10-01',         毎週のときの開始日
//   until: '2027-01-31' | null, 毎週のときの終了日（null = 無期限）
//   start: '18:00', end: '21:00', 終了 <= 開始 なら日をまたぐ（22:00–02:00 など）
//   wage: 1500 | null,          時給（任意）
//   memo: '',
//   exceptions: {               毎週シフトの特定日だけの変更
//     '2026-11-10': { cancel: true },                 休み
//     '2026-11-17': { start: '19:00', end: '22:00' }, 時間変更
//   },
//   createdAt, updatedAt
// }

import { addDays, atTime, startOfDay, toDateInput, WEEKDAYS, HOUR } from './dateutil.js';
import { icsText, utcStamp } from './calendar.js';

/** "2026-11-03" → その日 0:00 */
export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function makeShift(fields) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    kind: 'once',
    place: '',
    date: null,
    weekday: null,
    from: null,
    until: null,
    start: '18:00',
    end: '21:00',
    wage: null,
    memo: '',
    exceptions: {},
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

/** ある日の開始・終了 Date（日またぎ対応） */
function span(day, start, end) {
  const s = atTime(day, start);
  let e = atTime(day, end);
  if (e <= s) e = addDays(e, 1);
  return { start: s, end: e };
}

/** "毎週火 18:00–21:00" のようなラベル */
export function shiftRuleLabel(shift) {
  const time = `${shift.start}–${shift.end}`;
  if (shift.kind === 'weekly') return `毎週${WEEKDAYS[shift.weekday]} ${time}`;
  const d = fromKey(shift.date);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${time}`;
}

/**
 * [rangeStart, rangeEnd) の範囲に始まる勤務を列挙する
 * 休みにした回も { cancelled: true } として含める（週ビューで取り消せるように）
 * @returns {Array<{ shift, key, start: Date, end: Date, cancelled: boolean, changed: boolean, memo: string }>}
 */
export function occurrences(shift, rangeStart, rangeEnd) {
  const out = [];
  const push = (day) => {
    const key = toDateInput(day);
    const ex = (shift.exceptions || {})[key] || {};
    const { start, end } = span(day, ex.start || shift.start, ex.end || shift.end);
    if (start < rangeStart || start >= rangeEnd) return;
    out.push({
      shift, key, start, end,
      cancelled: !!ex.cancel,
      changed: !ex.cancel && !!(ex.start || ex.end),
      memo: ex.memo || shift.memo || '',
    });
  };
  if (shift.kind === 'once') {
    if (shift.date) push(fromKey(shift.date));
    return out;
  }
  // 毎週：範囲内で曜日が一致する日を順に見る（前日開始の日またぎ分も拾うため1日手前から）
  const from = shift.from ? fromKey(shift.from) : startOfDay(rangeStart);
  const until = shift.until ? fromKey(shift.until) : null;
  let d = startOfDay(addDays(rangeStart, -1));
  if (d < from) d = from;
  for (; d < rangeEnd; d = addDays(d, 1)) {
    if (until && d > until) break;
    if (d.getDay() === shift.weekday) push(d);
  }
  return out;
}

/** 全シフトの勤務を範囲内で列挙（開始順） */
export function allOccurrences(shifts, rangeStart, rangeEnd) {
  return shifts.flatMap((s) => occurrences(s, rangeStart, rangeEnd)).sort((a, b) => a.start - b.start);
}

/** 勤務時間と概算収入の集計（休みの回は除く） */
export function summarize(occs) {
  let hours = 0, income = 0, unpaidHours = 0;
  for (const o of occs) {
    if (o.cancelled) continue;
    const h = (o.end - o.start) / HOUR;
    hours += h;
    if (o.shift.wage) income += h * o.shift.wage;
    else unpaidHours += h;
  }
  return { hours, income: Math.round(income), unpaidHours };
}

// ---------------------------------------------------------------------
// 重なりの検出
// ---------------------------------------------------------------------

/** 範囲内の授業（休講は除く。補講は含む） */
export function classOccurrences(tt, rangeStart, rangeEnd) {
  return tt.occurrences(rangeStart, rangeEnd).filter((o) => o.status !== 'cancelled');
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const inside = (t, iv) => iv.start < t && t < iv.end; // ちょうど開始・終了時刻は重なりとみなさない

const fmtHM = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const fmtMD = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;

/**
 * 授業・バイト・タスク期限の重なりを調べる
 * @returns {Array<{ key: string, at: Date, text: string, shiftIds: string[], taskIds: string[] }>}
 */
export function findConflicts({ tt, shifts, tasks, rangeStart, rangeEnd }) {
  const classes = classOccurrences(tt, rangeStart, rangeEnd);
  const work = allOccurrences(shifts, rangeStart, rangeEnd).filter((o) => !o.cancelled);
  const dues = tasks
    .filter((t) => !t.done && t.due)
    .map((t) => ({ task: t, at: new Date(t.due) }))
    .filter((d) => d.at >= rangeStart && d.at < rangeEnd);
  const out = [];
  const label = (w) => `${w.shift.place || 'バイト'}（${fmtHM(w.start)}–${fmtHM(w.end)}）`;

  work.forEach((w, i) => {
    for (const c of classes) {
      if (overlaps(w, c)) {
        out.push({ key: w.key, at: w.start, text: `${fmtMD(w.start)} ${label(w)} と ${c.course.short || c.course.name}（${fmtHM(c.start)}–${fmtHM(c.end)}）が重なっています`, shiftIds: [w.shift.id], taskIds: [] });
      }
    }
    for (const w2 of work.slice(i + 1)) {
      if (overlaps(w, w2)) {
        out.push({ key: w.key, at: w.start, text: `${fmtMD(w.start)} ${label(w)} と ${label(w2)} が重なっています`, shiftIds: [w.shift.id, w2.shift.id], taskIds: [] });
      }
    }
  });
  for (const d of dues) {
    for (const w of work) {
      if (inside(d.at, w)) out.push({ key: w.key, at: d.at, text: `「${d.task.title}」の期限 ${fmtMD(d.at)} ${fmtHM(d.at)} がバイト ${label(w)} の最中です`, shiftIds: [w.shift.id], taskIds: [d.task.id] });
    }
    for (const c of classes) {
      if (inside(d.at, c)) out.push({ key: c.key, at: d.at, text: `「${d.task.title}」の期限 ${fmtMD(d.at)} ${fmtHM(d.at)} が ${c.course.short || c.course.name} の授業中です`, shiftIds: [], taskIds: [d.task.id] });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------
// Googleカレンダー / .ics
// ---------------------------------------------------------------------

const eventTitle = (shift) => `💼 ${shift.place || 'バイト'}`;

function details(shift, memo) {
  const lines = [];
  if (shift.wage) lines.push(`時給: ${shift.wage}円`);
  if (memo) lines.push(memo);
  return lines.join('\n');
}

/** 1回分を Googleカレンダーに追加する URL */
export function shiftOccurrenceUrl(occ) {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: eventTitle(occ.shift), details: details(occ.shift, occ.memo), ctz: 'Asia/Tokyo' });
  return `https://calendar.google.com/calendar/render?${p}&dates=${utcStamp(occ.start)}/${utcStamp(occ.end)}`;
}

/** 毎週の予定として追加する URL（例外は URL では表せないので、休みの日は追加後に手で消す） */
export function shiftSeriesUrl(shift) {
  const first = occurrences(shift, fromKey(shift.from), addDays(fromKey(shift.from), 8))[0];
  if (!first) return null;
  const p = new URLSearchParams({ action: 'TEMPLATE', text: eventTitle(shift), details: details(shift, shift.memo), ctz: 'Asia/Tokyo' });
  let rule = 'RRULE:FREQ=WEEKLY';
  if (shift.until) rule += `;UNTIL=${shift.until.replace(/-/g, '')}T235959Z`;
  p.set('recur', rule);
  return `https://calendar.google.com/calendar/render?${p}&dates=${utcStamp(first.start)}/${utcStamp(first.end)}`;
}

/**
 * .ics の VEVENT 行を返す
 *   単発   → VEVENT 1つ
 *   毎週   → RRULE 付き VEVENT ＋ 休みは EXDATE ＋ 時間変更は RECURRENCE-ID 付きの上書き VEVENT
 */
export function shiftIcsLines(shift) {
  const stamp = utcStamp(new Date());
  const uid = `shift-${shift.id}@kadai-board`;
  const base = (start, end, memo) => [
    `DTSTAMP:${stamp}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${icsText(eventTitle(shift))}`,
    `DESCRIPTION:${icsText(details(shift, memo))}`,
    'CATEGORIES:バイト',
  ];

  if (shift.kind === 'once') {
    if (!shift.date) return [];
    const o = occurrences(shift, fromKey(shift.date), addDays(fromKey(shift.date), 1))[0];
    if (!o || o.cancelled) return [];
    return ['BEGIN:VEVENT', `UID:${uid}`, ...base(o.start, o.end, o.memo), 'END:VEVENT'];
  }

  // 毎週：開始日以降の最初の回を DTSTART にする（BYDAY は付けず DTSTART の曜日で繰り返す）
  const from = fromKey(shift.from);
  const first = span(addDays(from, (shift.weekday - from.getDay() + 7) % 7), shift.start, shift.end);
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, ...base(first.start, first.end, shift.memo)];
  let rule = 'RRULE:FREQ=WEEKLY';
  if (shift.until) rule += `;UNTIL=${utcStamp(span(fromKey(shift.until), shift.start, shift.end).start)}`;
  lines.push(rule);

  const overrides = [];
  for (const [key, ex] of Object.entries(shift.exceptions || {})) {
    // RECURRENCE-ID / EXDATE は「本来の開始時刻」で指定する
    const original = span(fromKey(key), shift.start, shift.end).start;
    if (ex.cancel) lines.push(`EXDATE:${utcStamp(original)}`);
    else {
      const s = span(fromKey(key), ex.start || shift.start, ex.end || shift.end);
      overrides.push('BEGIN:VEVENT', `UID:${uid}`, `RECURRENCE-ID:${utcStamp(original)}`, ...base(s.start, s.end, ex.memo || shift.memo), 'END:VEVENT');
    }
  }
  lines.push('END:VEVENT');
  return [...lines, ...overrides];
}
