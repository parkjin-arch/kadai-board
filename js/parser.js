// 1行入力の簡易パーサ
// 例: 「回路理論B レポート 11/6 23:59 !高 2h」
//   → { title: "レポート", courseId: "kairo-b", due: 2026-11-06 23:59, priority: "high", estimateMin: 120 }
//
// 対応している書き方
//   日付  : 11/6, 11月6日, 2026/11/6, 今日, 明日, 明後日, 3日後, 金曜, 来週月曜, 次回(=授業の次のコマ)
//   時刻  : 23:59, 23時, 23時30分, 9時半, 2限(=その時限の開始時刻)
//   優先度: !高 !中 !低, !!(=高), 至急, 重要
//   所要  : 2h, 1.5時間, 90分, 30min
//   授業  : 時間割の授業名 or aliases（最長一致）

import { addDays, startOfDay, startOfWeek, atTime, DAY } from './dateutil.js';

const WD = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

// 正規表現用エスケープ
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 授業名 → 照合用正規表現（空白の有無を無視、英字は単語境界を要求） */
function courseRegex(name) {
  const body = [...name.replace(/\s+/g, '')].map(esc).join('\\s*');
  const ascii = /^[A-Za-z0-9]/.test(name);
  return new RegExp(ascii ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, 'i');
}

/**
 * @param {string} text 入力文字列
 * @param {import('./timetable.js').Timetable} tt 時間割
 * @param {Date} now 基準時刻（テスト用に差し替え可能）
 */
export function parseQuickInput(text, tt, now = new Date()) {
  // 全角英数・記号を半角に寄せる（"１１／６" → "11/6", "！" → "!"）
  let s = ' ' + text.normalize('NFKC') + ' ';
  const out = { title: '', due: null, courseId: null, priority: 'mid', estimateMin: null };

  // 抜き出した部分は空白に置換していき、最後に残った文字列をタイトルにする
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return false;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    fn(m);
    return true;
  };

  // ---- 授業（最長一致） ----
  const cands = [];
  for (const c of tt.courses) {
    for (const n of [c.name, ...(c.aliases || [])]) cands.push({ c, n: n.normalize('NFKC') });
  }
  cands.sort((a, b) => b.n.length - a.n.length);
  for (const { c, n } of cands) {
    if (take(courseRegex(n), () => (out.courseId = c.id))) break;
  }
  const course = tt.get(out.courseId);

  // ---- 優先度 ----
  take(/[!#](高|中|低)|優先度\s*(高|中|低)/, (m) => {
    out.priority = { 高: 'high', 中: 'mid', 低: 'low' }[m[1] || m[2]];
  }) ||
    take(/!{2,}|至急|重要/, () => (out.priority = 'high'));

  // ---- 日付 ----
  let date = null; // その日の 0:00
  let dateIsClass = false; // 「次回」指定（時刻も授業開始にする）
  let plainWeekday = false; // 「金曜」のような曜日だけの指定
  const today = startOfDay(now);

  const ymd = (y, m, d) => {
    const x = new Date(y, m - 1, d);
    // 存在しない日付（2/30 など）は無視
    return x.getMonth() === m - 1 ? x : null;
  };

  take(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?/, (m) => (date = ymd(+m[1], +m[2], +m[3]))) ||
    take(/(?<![\d:])(\d{1,2})(?:\/|月)(\d{1,2})日?(?![\d:])/, (m) => {
      let y = now.getFullYear();
      date = ymd(y, +m[1], +m[2]);
      // 2か月以上前の日付になったら翌年とみなす（12月に「1/10」と書いた場合など）
      if (date && today - date > 60 * DAY) date = ymd(y + 1, +m[1], +m[2]);
    }) ||
    take(/明後日|あさって/, () => (date = addDays(today, 2))) ||
    take(/明日|あした/, () => (date = addDays(today, 1))) ||
    take(/今日|きょう/, () => (date = today)) ||
    take(/(\d+)日後/, (m) => (date = addDays(today, +m[1]))) ||
    take(/(来週|再来週|今週)?の?([月火水木金土日])曜日?/, (m) => {
      const wd = WD[m[2]];
      if (m[1]) {
        // 来週月曜 = 来週の週（月曜はじまり）のその曜日
        const offset = { 今週: 0, 来週: 7, 再来週: 14 }[m[1]];
        date = addDays(startOfWeek(today), offset + ((wd + 6) % 7));
      } else {
        // ただの「金曜」は今日以降で最も近いその曜日
        date = addDays(today, (wd - today.getDay() + 7) % 7);
        plainWeekday = true;
      }
    }) ||
    take(/次回|次の授業/, () => {
      const next = tt.nextClassStart(course, now);
      if (next) {
        date = next;
        dateIsClass = true;
      }
    });

  // 日付の後ろの "(金)" などの曜日表記は捨てる
  take(/\(\s*[月火水木金土日]\s*\)/, () => {});

  // ---- 時刻 ----
  let time = null; // [h, m]
  take(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/, (m) => (time = [+m[1], +m[2]])) ||
    take(/(\d{1,2})時(?:(\d{1,2})分|(半))?(?!間)/, (m) => (time = [+m[1], m[2] ? +m[2] : m[3] ? 30 : 0])) ||
    take(/([1-9])限/, (m) => {
      const p = tt.period(+m[1]);
      if (p) time = p.start.split(':').map(Number);
    });
  // 24:00 は扱いにくいので 23:59 に寄せる
  if (time && time[0] >= 24) time = [23, 59];

  // ---- 所要時間 ----
  take(/(?:約|所要)?\s*(\d+(?:\.\d+)?)\s*(?:h|hr|時間)(?![a-z])/i, (m) => (out.estimateMin = Math.round(+m[1] * 60))) ||
    take(/(?:約|所要)?\s*(\d+)\s*(?:分|min|m)(?![a-z])/i, (m) => (out.estimateMin = +m[1]));

  // ---- 期限を組み立てる ----
  if (dateIsClass) {
    out.due = date;
  } else if (date) {
    out.due = new Date(date);
    if (time) out.due.setHours(time[0], time[1], 0, 0);
    else out.due.setHours(23, 59, 0, 0); // 時刻なしは 23:59 締切とみなす
    // 今日と同じ曜日を指定して、その時刻をもう過ぎていたら来週にする
    if (plainWeekday && out.due <= now) out.due = addDays(out.due, 7);
  } else if (time) {
    // 時刻だけ → 今日のその時刻。過ぎていれば明日
    out.due = atTime(today, `${time[0]}:${time[1]}`);
    if (out.due <= now) out.due = addDays(out.due, 1);
  }

  out.title = s.replace(/\s+/g, ' ').trim();
  if (!out.title) out.title = course ? '課題' : '';
  return out;
}
