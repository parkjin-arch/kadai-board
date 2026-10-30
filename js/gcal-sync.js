// 段階2：Google Calendar API による自動同期
// config.js の google.clientId を設定すると app.js から読み込まれる。
//
// しくみ
//   - Google Identity Services（GIS）の「トークンモデル」でアクセストークンを取得（サーバー不要）
//   - 専用カレンダー「課題」を作成し、その ID を store の meta に保存（Firebase 利用時は端末間で共有される）
//   - タスク保存時：期限あり → イベント作成/更新、期限なし → イベント削除
//   - タスク削除時：イベント削除
//   - イベントIDはタスクの gcalEventId に保存
//
// 注意：アクセストークンは約1時間で切れる。切れたら次の操作時に自動で再取得を試みる
//       （一度許可していれば通常はポップアップが一瞬出るだけ）。

import { eventTitle, eventRange, eventDescription } from './calendar.js';

const API = 'https://www.googleapis.com/calendar/v3';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Google のスクリプトを読み込めませんでした'));
    document.head.append(s);
  });
}

export class GcalSync {
  /**
   * @param {import('./store.js').LocalCollection} store タスクのコレクション
   * @param {import('./timetable.js').Timetable} tt
   * @param {{ clientId: string, calendarName: string, scope: string }} opts
   */
  constructor(store, tt, opts) {
    this.store = store;
    this.tt = tt;
    this.opts = opts;
    this.token = null;
    this.tokenExpires = 0;
    this.calendarId = null;
    this.onStatusChange = () => {};
    // 以前接続したことがあれば、操作時に自動でトークンを取りに行く
    this.wasConnected = localStorage.getItem('kadai-board.gcal.connected') === '1';
  }

  get connected() {
    return !!this.token && Date.now() < this.tokenExpires;
  }

  /** トークンを取得（prompt: 'consent' は初回、'' は再取得） */
  async _requestToken(prompt) {
    await loadScript(GIS_SRC);
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.opts.clientId,
        scope: this.opts.scope,
        callback: (res) => {
          if (res.error) return reject(new Error(res.error_description || res.error));
          this.token = res.access_token;
          this.tokenExpires = Date.now() + (res.expires_in - 60) * 1000;
          localStorage.setItem('kadai-board.gcal.connected', '1');
          this.wasConnected = true;
          this.onStatusChange();
          resolve();
        },
        error_callback: (err) => reject(new Error(err.message || 'ログインがキャンセルされました')),
      });
      client.requestAccessToken({ prompt });
    });
  }

  /** 設定画面の「接続」ボタンから呼ぶ */
  async connect() {
    await this._requestToken('consent');
    await this._ensureCalendar();
    await this.syncAll();
  }

  async _ensureToken() {
    if (this.connected) return true;
    if (!this.wasConnected) return false; // 一度も接続していなければ何もしない
    await this._requestToken('');
    return true;
  }

  /** API 呼び出し（JSON） */
  async _api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Calendar API エラー (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** 専用カレンダー「課題」を用意する（保存済み ID → 名前で検索 → 新規作成 の順） */
  async _ensureCalendar() {
    if (this.calendarId) return this.calendarId;
    const saved = this.store.getMeta('gcalCalendarId');
    if (saved) {
      try {
        await this._api('GET', `/calendars/${encodeURIComponent(saved)}`);
        return (this.calendarId = saved);
      } catch (e) {
        if (e.status !== 404) throw e; // 消されていたら作り直す
      }
    }
    // calendar.app.created スコープでは一覧が取れない場合があるので失敗しても続行
    try {
      const list = await this._api('GET', '/users/me/calendarList?minAccessRole=owner');
      const found = list.items.find((c) => c.summary === this.opts.calendarName);
      if (found) {
        await this.store.setMeta('gcalCalendarId', found.id);
        return (this.calendarId = found.id);
      }
    } catch { /* 権限不足は無視 */ }

    const cal = await this._api('POST', '/calendars', { summary: this.opts.calendarName, timeZone: 'Asia/Tokyo' });
    await this.store.setMeta('gcalCalendarId', cal.id);
    return (this.calendarId = cal.id);
  }

  /** タスク → イベント本体 */
  _toEvent(task) {
    const course = this.tt.get(task.courseId);
    const { start, end } = eventRange(task);
    return {
      summary: (task.done ? '✓ ' : '') + eventTitle(task, course),
      description: eventDescription(task, course),
      location: course && course.slots.length ? course.room : undefined,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Tokyo' },
      end: { dateTime: end.toISOString(), timeZone: 'Asia/Tokyo' },
      colorId: task.done ? '8' : undefined, // 完了したらグレー
      reminders: task.done ? { useDefault: false, overrides: [] } : { useDefault: false, overrides: [{ method: 'popup', minutes: 24 * 60 }] },
      // あとでタスクと突き合わせられるように ID を埋め込んでおく
      extendedProperties: { private: { kadaiTaskId: task.id } },
    };
  }

  /** 1件を同期。戻り値は最新の eventId（なければ null） */
  async _push(task) {
    const cal = encodeURIComponent(await this._ensureCalendar());
    if (!task.due) {
      if (task.gcalEventId) await this._delete(task.gcalEventId);
      return null;
    }
    const body = this._toEvent(task);
    if (task.gcalEventId) {
      try {
        await this._api('PATCH', `/calendars/${cal}/events/${task.gcalEventId}`, body);
        return task.gcalEventId;
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e; // カレンダー側で消されていたら作り直す
      }
    }
    const ev = await this._api('POST', `/calendars/${cal}/events`, body);
    return ev.id;
  }

  async _delete(eventId) {
    const cal = encodeURIComponent(await this._ensureCalendar());
    try {
      await this._api('DELETE', `/calendars/${cal}/events/${eventId}`);
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }

  /** app.js から：タスクが保存された */
  async onSaved(task) {
    try {
      if (!(await this._ensureToken())) return;
      const eventId = await this._push(task);
      if (eventId !== task.gcalEventId) await this.store.update(task.id, { gcalEventId: eventId });
    } catch (e) {
      console.warn('カレンダー同期に失敗', e);
    }
  }

  /** app.js から：タスクが削除された */
  async onRemoved(task) {
    if (!task.gcalEventId) return;
    try {
      if (!(await this._ensureToken())) return;
      await this._delete(task.gcalEventId);
    } catch (e) {
      console.warn('カレンダーからの削除に失敗', e);
    }
  }

  /** 全タスクを同期（初回接続時・「再同期」ボタン） */
  async syncAll() {
    if (!(await this._ensureToken())) return 0;
    let n = 0;
    for (const t of [...this.store.all()]) {
      const eventId = await this._push(t);
      if (eventId !== t.gcalEventId) await this.store.update(t.id, { gcalEventId: eventId });
      if (eventId) n++;
    }
    return n;
  }
}
