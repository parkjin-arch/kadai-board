// Googleカレンダー追加リンクと .ics エクスポート（段階1：OAuth 不要）

import { fmtMinutes } from './dateutil.js';

const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };
const DEFAULT_EVENT_MIN = 30; // 所要時間が未設定のときのイベントの長さ

/** カレンダー上のタイトル: "[回路理論B 1クラス] レポート" */
export function eventTitle(task, course) {
  return course ? `[${course.name}] ${task.title}` : task.title;
}

/** イベントの開始・終了。期限を「終了時刻」とし、所要時間ぶん前を開始にする */
export function eventRange(task) {
  const end = new Date(task.due);
  const start = new Date(end - (task.estimateMin || DEFAULT_EVENT_MIN) * 60000);
  return { start, end };
}

export function eventDescription(task, course) {
  const lines = [];
  if (course) lines.push(`授業: ${course.name}（${course.room}）`);
  lines.push(`優先度: ${PRIORITY_LABEL[task.priority] || '中'}`);
  if (task.estimateMin) lines.push(`所要時間: ${fmtMinutes(task.estimateMin)}`);
  if (task.memo) lines.push('', task.memo);
  return lines.join('\n');
}

/** UTC の "20261106T145900Z" 形式（タイムゾーンのずれを避けるため UTC で渡す） */
function utcStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Googleカレンダーの「予定を作成」画面を開く URL */
export function googleCalendarUrl(task, course) {
  const { start, end } = eventRange(task);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: eventTitle(task, course),
    details: eventDescription(task, course),
    ctz: 'Asia/Tokyo',
  });
  if (course && course.slots.length) params.set('location', course.room);
  // dates の "/" はエンコードしない形が公式の書式なので、別に付け足す
  return `https://calendar.google.com/calendar/render?${params}&dates=${utcStamp(start)}/${utcStamp(end)}`;
}

// ---------- .ics（RFC 5545） ----------

/** テキスト値のエスケープ */
function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 1行 75 オクテットで折り返す（日本語の途中で切らないよう文字単位で数える） */
function fold(line) {
  const enc = new TextEncoder();
  const parts = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    // 2行目以降は先頭の空白1文字ぶんを差し引く
    const limit = parts.length ? 74 : 75;
    if (bytes + b > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

/**
 * タスク一覧から .ics 文字列を作る（期限のあるタスクのみ）
 * @param {Array} tasks
 * @param {import('./timetable.js').Timetable} tt
 */
export function buildIcs(tasks, tt) {
  const now = utcStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kadai-board//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:課題',
    'X-WR-TIMEZONE:Asia/Tokyo',
  ];
  for (const t of tasks) {
    if (!t.due) continue;
    const course = tt.get(t.courseId);
    const { start, end } = eventRange(t);
    lines.push(
      'BEGIN:VEVENT',
      // UID を固定しておくと、同じファイルを再インポートしたとき重複せず上書きされる
      `UID:${t.id}@kadai-board`,
      `DTSTAMP:${now}`,
      `DTSTART:${utcStamp(start)}`,
      `DTEND:${utcStamp(end)}`,
      `SUMMARY:${icsText((t.done ? '✓ ' : '') + eventTitle(t, course))}`,
      `DESCRIPTION:${icsText(eventDescription(t, course))}`,
    );
    if (course) lines.push(`CATEGORIES:${icsText(course.name)}`);
    if (course && course.slots.length) lines.push(`LOCATION:${icsText(course.room)}`);
    if (!t.done) {
      // 期限の1日前に通知
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(t.title)}`, 'TRIGGER:-P1D', 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** 文字列をファイルとしてダウンロードさせる */
export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
