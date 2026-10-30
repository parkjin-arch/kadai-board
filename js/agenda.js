// カレンダー表示用に、授業・バイト・予定・タスク期限を同じ形の「項目」にまとめる
//
// 項目の形
// { kind: 'class' | 'shift' | 'event' | 'task', title, sub, start: Date, end: Date, allDay,
//   color, status: 'cancelled' | 'changed' | 'room' | 'makeup' | 'overdue' | null, conflict, ref }
//   ref は元のデータ（授業の回 / シフトの回 / 予定 / タスク）

import { addDays, fmtTime } from './dateutil.js';
import { allOccurrences, findConflicts } from './shifts.js';
import { eventSpan, eventsInRange } from './events.js';

export const SHIFT_COLOR = 'var(--shift)';
export const TASK_COLOR = 'var(--urgent)';
export const ALL_KINDS = { class: true, shift: true, task: true, event: true };

/**
 * @param {{ tt, tasks, shifts, events }} data
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @param {{ class, shift, task, event }} show 表示する種類
 */
export function collectItems(data, rangeStart, rangeEnd, show = ALL_KINDS) {
  const { tt, tasks, shifts, events } = data;
  const now = new Date();
  const conflicts = findConflicts({ tt, shifts, tasks, rangeStart, rangeEnd });
  const badShift = new Set(conflicts.flatMap((c) => c.shiftIds.map((id) => `${id}|${c.key}`)));
  const badTask = new Set(conflicts.flatMap((c) => c.taskIds));
  const items = [];

  if (show.class) {
    for (const o of tt.occurrences(rangeStart, rangeEnd)) {
      items.push({
        kind: 'class', title: o.course.short || o.course.name, sub: o.room,
        start: o.start, end: o.end, allDay: false, color: o.course.color,
        status: o.status === 'cancelled' ? 'cancelled' : o.status, ref: o,
      });
    }
  }
  if (show.shift) {
    // 前日から日をまたいで続くシフトも拾う
    for (const o of allOccurrences(shifts, addDays(rangeStart, -1), rangeEnd)) {
      if (o.end <= rangeStart) continue;
      items.push({
        kind: 'shift', title: o.shift.place || 'バイト', sub: `${fmtTime(o.start)}–${fmtTime(o.end)}`,
        start: o.start, end: o.end, allDay: false, color: SHIFT_COLOR,
        status: o.cancelled ? 'cancelled' : o.changed ? 'changed' : null,
        conflict: badShift.has(`${o.shift.id}|${o.key}`), ref: o,
      });
    }
  }
  if (show.event) {
    for (const ev of eventsInRange(events, rangeStart, rangeEnd)) {
      const { start, end } = eventSpan(ev);
      items.push({
        kind: 'event', title: ev.title || '（無題）', sub: ev.allDay ? '終日' : `${fmtTime(start)}–${fmtTime(end)}`,
        start, end, allDay: ev.allDay, color: ev.color, status: null, ref: ev,
      });
    }
  }
  if (show.task) {
    for (const t of tasks) {
      if (t.done || !t.due) continue;
      const due = new Date(t.due);
      if (due < rangeStart || due >= rangeEnd) continue;
      items.push({
        kind: 'task', title: t.title, sub: `期限 ${fmtTime(due)}`,
        start: due, end: due, allDay: false, color: TASK_COLOR,
        status: due < now ? 'overdue' : null, conflict: badTask.has(t.id), ref: t,
      });
    }
  }
  return items;
}

/** 日をまたぐ（または終日の）項目か。月表示・終日欄で横に伸びるバーにする */
export function isSpanning(item) {
  if (item.allDay) return true;
  const last = new Date(+item.end - 1);
  return item.end > item.start && last.toDateString() !== item.start.toDateString();
}
