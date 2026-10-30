// タスクの保存層
// UI はこのインターフェースだけを使う。段階2では FirestoreTaskStore（firebase-store.js）に差し替える。
//
//   init()              : 読み込み（Promise）
//   all()               : 現在のタスク配列（同期・キャッシュから）
//   add(task)           : 追加して保存したタスクを返す
//   update(id, patch)   : 部分更新して更新後のタスクを返す
//   remove(id)          : 削除
//   replaceAll(tasks)   : バックアップからの復元用
//   subscribe(fn)       : 変更時に fn(tasks) を呼ぶ。解除関数を返す
//   getMeta(key) / setMeta(key, value) : 設定値（カレンダーIDなど）

/**
 * タスクの形
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string|null} due        ISO 文字列（期限なしは null）
 * @property {string|null} courseId   timetable.json の course.id
 * @property {'high'|'mid'|'low'} priority
 * @property {string} memo
 * @property {number|null} estimateMin 所要時間（分）
 * @property {boolean} done
 * @property {string|null} gcalEventId 段階2: 同期した Google カレンダーのイベントID
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
}

/** 入力値から正規化したタスクを作る */
export function makeTask(fields) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: '',
    due: null,
    courseId: null,
    priority: 'mid',
    memo: '',
    estimateMin: null,
    done: false,
    gcalEventId: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

export class LocalTaskStore {
  constructor(key = 'kadai-board.tasks.v1') {
    this.key = key;
    this.metaKey = key + '.meta';
    this.tasks = [];
    this.listeners = new Set();
  }

  async init() {
    try {
      this.tasks = JSON.parse(localStorage.getItem(this.key) || '[]');
    } catch {
      this.tasks = [];
    }
    // 別タブで変更されたら追従する
    window.addEventListener('storage', (e) => {
      if (e.key === this.key) this.init().then(() => this._emit());
    });
  }

  all() {
    return this.tasks;
  }

  async add(task) {
    this.tasks.push(task);
    this._save();
    return task;
  }

  async update(id, patch) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return null;
    this.tasks[i] = { ...this.tasks[i], ...patch, updatedAt: new Date().toISOString() };
    this._save();
    return this.tasks[i];
  }

  async remove(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this._save();
  }

  async replaceAll(tasks) {
    this.tasks = tasks.map((t) => makeTask(t));
    this._save();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getMeta(key) {
    try {
      return JSON.parse(localStorage.getItem(this.metaKey) || '{}')[key] ?? null;
    } catch {
      return null;
    }
  }

  async setMeta(key, value) {
    const meta = JSON.parse(localStorage.getItem(this.metaKey) || '{}');
    meta[key] = value;
    localStorage.setItem(this.metaKey, JSON.stringify(meta));
  }

  _save() {
    localStorage.setItem(this.key, JSON.stringify(this.tasks));
    this._emit();
  }

  _emit() {
    for (const fn of this.listeners) fn(this.tasks);
  }
}
