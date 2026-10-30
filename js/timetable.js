// 時間割：時限の定義（data/timetable.json）と、授業データ（アプリ上で編集できるコレクション）を扱う
//
// 授業の形
// {
//   id, name, short?, room, teacher?, color, memo?, syllabus?, aliases: [],
//   slots: [{ day: 1, period: 3 }, { day: 1, period: 4 }],  day: 1=月 … 5=金。空ならオンデマンド
//   changes: {                                            特定の日だけの変更
//     '2026-11-05': { cancel: true, note },               休講
//     '2026-11-12': { room: '52-102', note },             教室変更
//   },
//   makeups: [{ id, date: '2026-11-21', period: 3, endPeriod: 4, room, note }],  補講
// }

import { addDays, atTime, startOfDay, toDateInput } from './dateutil.js';

export class Timetable {
  constructor(data) {
    this.periods = data.periods; // [{ period, start, end }]
    this.days = data.days; // ["月", ...]（index 0 = 月曜 = day 1）
    this.seedTerm = data.term || '';
    this.seedCourses = data.courses; // 初回起動時に授業コレクションへ読み込む初期データ
    this.term = this.seedTerm;
    this.setCourses(data.courses);
    this.setArchived([]);
  }

  static async load(url = './data/timetable.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`時間割の読み込みに失敗しました (${res.status})`);
    return new Timetable(await res.json());
  }

  /** 授業コレクションの内容で置き換える（編集のたびに呼ぶ） */
  setCourses(courses) {
    this.courses = [...courses].sort(
      (a, b) => (this._firstSlot(a) - this._firstSlot(b)) || a.name.localeCompare(b.name, 'ja'),
    );
    this._byId = new Map(this.courses.map((c) => [c.id, c]));
  }

  /** 過去の学期の授業（タスクに授業名を出すためだけに使う） */
  setArchived(courses) {
    this._archived = new Map(courses.map((c) => [c.id, c]));
  }

  _firstSlot(c) {
    return c.slots.length ? Math.min(...c.slots.map((s) => s.day * 10 + s.period)) : 999;
  }

  /** 授業を探す（今の学期 → 過去の学期の順） */
  get(id) {
    return id ? this._byId.get(id) || this._archived.get(id) || null : null;
  }

  isCurrent(id) {
    return this._byId.has(id);
  }

  /** オンデマンドなど、コマを持たない授業 */
  get onDemand() {
    return this.courses.filter((c) => !c.slots.length);
  }

  period(n) {
    return this.periods.find((p) => p.period === n);
  }

  /** 曜日(1=月)・時限 にある授業（重なっていれば最初の1つ） */
  courseAt(day, period) {
    return this.courses.find((c) => c.slots.some((s) => s.day === day && s.period === period)) || null;
  }

  /** そのコマにある授業すべて（重なりの警告用） */
  coursesAt(day, period) {
    return this.courses.filter((c) => c.slots.some((s) => s.day === day && s.period === period));
  }

  /** "月3-4・金5" のような表記（連続コマはまとめる） */
  slotLabel(course) {
    if (!course.slots.length) return 'オンデマンド';
    return groupSlots(course.slots)
      .map((g) => `${this.days[g.day - 1]}${g.from}${g.to > g.from ? `-${g.to}` : ''}`)
      .join('・');
  }

  /** 現在の時限（授業時間外なら null） */
  currentPeriod(now = new Date()) {
    const p = this.periods.find((p) => now >= atTime(now, p.start) && now <= atTime(now, p.end));
    return p ? p.period : null;
  }

  /**
   * [rangeStart, rangeEnd) の授業を列挙（連続コマは1つにまとめる）
   * 休講は status: 'cancelled' として含める。補講は status: 'makeup'、教室変更は status: 'room'
   * @returns {Array<{ course, key, start: Date, end: Date, period, endPeriod, room, status, note }>}
   */
  occurrences(rangeStart, rangeEnd, courses = this.courses) {
    const out = [];
    for (let d = startOfDay(rangeStart); d < rangeEnd; d = addDays(d, 1)) {
      const key = toDateInput(d);
      for (const c of courses) {
        const change = (c.changes || {})[key];
        for (const g of groupSlots(c.slots.filter((s) => s.day === d.getDay()))) {
          out.push({
            course: c, key,
            start: atTime(d, this.period(g.from).start),
            end: atTime(d, this.period(g.to).end),
            period: g.from, endPeriod: g.to,
            room: change?.room || c.room,
            status: change?.cancel ? 'cancelled' : change?.room ? 'room' : null,
            note: change?.note || '',
          });
        }
        for (const m of c.makeups || []) {
          if (m.date !== key) continue;
          out.push({
            course: c, key, makeupId: m.id,
            start: atTime(d, this.period(m.period).start),
            end: atTime(d, this.period(m.endPeriod || m.period).end),
            period: m.period, endPeriod: m.endPeriod || m.period,
            room: m.room || c.room, status: 'makeup', note: m.note || '',
          });
        }
      }
    }
    return out.filter((o) => o.start >= rangeStart && o.start < rangeEnd).sort((a, b) => a.start - b.start);
  }

  /** その授業の「次回」の開始時刻（休講は飛ばし、補講も含める） */
  nextClassStart(course, now = new Date()) {
    if (!course || (!course.slots.length && !(course.makeups || []).length)) return null;
    const next = this.occurrences(now, addDays(now, 60), [course]).find((o) => o.status !== 'cancelled' && o.start > now);
    return next ? next.start : null;
  }
}

/** 同じ曜日の連続コマをまとめる [{ day, from, to }] */
export function groupSlots(slots) {
  const sorted = [...slots].sort((a, b) => a.day - b.day || a.period - b.period);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.day === s.day && last.to + 1 === s.period) last.to = s.period;
    else out.push({ day: s.day, from: s.period, to: s.period });
  }
  return out;
}
