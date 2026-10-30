// 自分で追加する予定（旅行・サークル・通院など）
//
// 予定の形
// {
//   id, title, allDay: boolean,
//   start, end,   終日なら 'YYYY-MM-DD'（end はその日を含む）、時刻ありなら ISO 文字列
//   color: '#5b8def', memo, createdAt, updatedAt
// }

import { addDays, fmtTime, WEEKDAYS } from './dateutil.js';
import { icsText, utcStamp } from './calendar.js';

// 予定の色の候補（iPhone のカレンダーに近い色）
export const EVENT_COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#a2845e'];

const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function makeEvent(fields) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    title: '',
    allDay: false,
    start: null,
    end: null,
    color: EVENT_COLORS[5],
    memo: '',
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

/** 予定の開始・終了（end は含まない時刻）を Date で */
export function eventSpan(ev) {
  if (ev.allDay) return { start: fromKey(ev.start), end: addDays(fromKey(ev.end || ev.start), 1) };
  return { start: new Date(ev.start), end: new Date(ev.end || ev.start) };
}

/** 範囲 [rangeStart, rangeEnd) に少しでもかかる予定 */
export function eventsInRange(events, rangeStart, rangeEnd) {
  return events.filter((ev) => {
    const { start, end } = eventSpan(ev);
    return start < rangeEnd && (end > rangeStart || +start === +end && start >= rangeStart);
  });
}

/** "11/8(日)〜11/12(木)" / "11/8(日) 10:00–12:00" のような表示 */
export function eventWhen(ev) {
  const { start, end } = eventSpan(ev);
  const md = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  if (ev.allDay) {
    const last = addDays(end, -1);
    return +last === +start ? `${md(start)} 終日` : `${md(start)}〜${md(last)}`;
  }
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay ? `${md(start)} ${fmtTime(start)}–${fmtTime(end)}` : `${md(start)} ${fmtTime(start)}〜${md(end)} ${fmtTime(end)}`;
}

/** Googleカレンダーに追加する URL */
export function eventUrl(ev) {
  const { start, end } = eventSpan(ev);
  const dates = ev.allDay
    ? `${dateKey(start).replace(/-/g, '')}/${dateKey(end).replace(/-/g, '')}` // 終日は終了日を含まない日付で渡す
    : `${utcStamp(start)}/${utcStamp(end)}`;
  const p = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, details: ev.memo || '', ctz: 'Asia/Tokyo' });
  return `https://calendar.google.com/calendar/render?${p}&dates=${dates}`;
}

/** .ics の VEVENT 行 */
export function eventIcsLines(ev) {
  const { start, end } = eventSpan(ev);
  const lines = ['BEGIN:VEVENT', `UID:event-${ev.id}@kadai-board`, `DTSTAMP:${utcStamp(new Date())}`];
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateKey(start).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${dateKey(end).replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`);
  }
  lines.push(`SUMMARY:${icsText(ev.title)}`);
  if (ev.memo) lines.push(`DESCRIPTION:${icsText(ev.memo)}`);
  lines.push('END:VEVENT');
  return lines;
}
