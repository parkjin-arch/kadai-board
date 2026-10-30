// 日付まわりの小さなユーティリティ（すべて端末のローカル時刻で扱う）

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** その日の 0:00 */
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** n 日後（時刻は維持） */
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 今週の月曜 0:00（週は月曜はじまり） */
export function startOfWeek(d) {
  const x = startOfDay(d);
  const diff = (x.getDay() + 6) % 7; // 月=0 … 日=6
  return addDays(x, -diff);
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const pad = (n) => String(n).padStart(2, '0');

/** "11/6(金)" */
export function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

/** "23:59" */
export function fmtTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "11/6(金) 23:59" */
export function fmtDateTime(d) {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** <input type="date"> 用 "2026-11-06" */
export function toDateInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** <input type="time"> 用 "23:59" */
export function toTimeInput(d) {
  return fmtTime(d);
}

/** date input と time input の値から Date を作る（日付が空なら null） */
export function fromInputs(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '23:59').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** "HH:MM" を指定日の Date にする */
export function atTime(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const x = new Date(day);
  x.setHours(h, m, 0, 0);
  return x;
}

/** 期限までの残りを人間向けに表示（"あと3時間" / "2日超過" など） */
export function relative(due, now = new Date()) {
  const diff = due - now;
  const abs = Math.abs(diff);
  let text;
  if (abs < HOUR) text = `${Math.max(1, Math.round(abs / 60000))}分`;
  else if (abs < DAY) text = `${Math.floor(abs / HOUR)}時間`;
  else {
    // 日数は「カレンダー上の日付差」で数える方が直感に合う
    const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
    text = `${Math.abs(days)}日`;
  }
  return diff >= 0 ? `あと${text}` : `${text}超過`;
}

/** "90" → "1時間30分" */
export function fmtMinutes(min) {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}
