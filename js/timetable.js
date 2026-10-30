// 時間割データ（data/timetable.json）の読み込みと検索
// 学期が変わったら JSON を差し替えるだけでよいよう、ここではデータの形だけに依存する

import { addDays, atTime, startOfDay } from './dateutil.js';

export class Timetable {
  constructor(data) {
    this.term = data.term || '';
    this.periods = data.periods; // [{ period, start, end }]
    this.days = data.days; // ["月", ...]（index 0 = 月曜 = day 1）
    this.courses = data.courses;
    this._byId = new Map(this.courses.map((c) => [c.id, c]));
  }

  static async load(url = './data/timetable.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`時間割の読み込みに失敗しました (${res.status})`);
    return new Timetable(await res.json());
  }

  get(id) {
    return id ? this._byId.get(id) || null : null;
  }

  /** オンデマンドなど、コマを持たない授業 */
  get onDemand() {
    return this.courses.filter((c) => !c.slots.length);
  }

  period(n) {
    return this.periods.find((p) => p.period === n);
  }

  /** 曜日(1=月)・時限 にある授業 */
  courseAt(day, period) {
    return this.courses.find((c) => c.slots.some((s) => s.day === day && s.period === period)) || null;
  }

  /** "月2・金5" のような表記 */
  slotLabel(course) {
    if (!course.slots.length) return 'オンデマンド';
    return course.slots.map((s) => `${this.days[s.day - 1]}${s.period}`).join('・');
  }

  /** 現在の時限（授業時間外なら null） */
  currentPeriod(now = new Date()) {
    const p = this.periods.find((p) => now >= atTime(now, p.start) && now <= atTime(now, p.end));
    return p ? p.period : null;
  }

  /** その授業の「次回」の開始時刻（now より後で最も近いコマ） */
  nextClassStart(course, now = new Date()) {
    if (!course || !course.slots.length) return null;
    let best = null;
    for (let i = 0; i <= 7; i++) {
      const day = addDays(startOfDay(now), i);
      const dow = day.getDay();
      for (const s of course.slots) {
        if (s.day !== dow) continue;
        const t = atTime(day, this.period(s.period).start);
        if (t > now && (!best || t < best)) best = t;
      }
      if (best) break;
    }
    return best;
  }
}
