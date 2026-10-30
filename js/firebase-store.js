// 段階2：Firestore + Googleログインによる保存層（スマホとPCで同期）
// config.js で storage: 'firebase' にすると LocalTaskStore の代わりに使われる。
// インターフェースは store.js の LocalTaskStore と同じ。
//
// データ構造
//   users/{uid}/tasks/{taskId}   … タスク1件
//   users/{uid}/meta/settings    … カレンダーIDなどの設定

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDocs, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { makeTask } from './store.js';

export class FirestoreTaskStore {
  constructor(firebaseConfig) {
    this.app = initializeApp(firebaseConfig);
    this.auth = getAuth(this.app);
    // オフラインでも読み書きでき、オンライン復帰時に自動で同期される
    this.db = initializeFirestore(this.app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    this.user = null;
    this.tasks = [];
    this.meta = {};
    this.listeners = new Set();
    this.authListeners = new Set();
    this._unsubs = [];
  }

  /** ログイン状態が確定するまで待つ */
  init() {
    return new Promise((resolve) => {
      let first = true;
      onAuthStateChanged(this.auth, async (user) => {
        this.user = user;
        this._unsubs.forEach((u) => u());
        this._unsubs = [];
        this.tasks = [];
        this.meta = {};
        if (user) {
          await this._migrateFromLocal();
          this._listen();
        }
        this._emit();
        this.authListeners.forEach((fn) => fn(user));
        if (first) { first = false; resolve(); }
      });
    });
  }

  _tasksCol() {
    return collection(this.db, 'users', this.user.uid, 'tasks');
  }

  _metaDoc() {
    return doc(this.db, 'users', this.user.uid, 'meta', 'settings');
  }

  /** 他の端末での変更をリアルタイムに受け取る */
  _listen() {
    this._unsubs.push(
      onSnapshot(this._tasksCol(), (snap) => {
        this.tasks = snap.docs.map((d) => d.data());
        this._emit();
      }),
      onSnapshot(this._metaDoc(), (snap) => {
        this.meta = snap.data() || {};
      }),
    );
  }

  /** 初回ログイン時、Firestore が空なら localStorage のタスクをアップロード */
  async _migrateFromLocal() {
    const local = JSON.parse(localStorage.getItem('kadai-board.tasks.v1') || '[]');
    if (!local.length || localStorage.getItem('kadai-board.migrated') === this.user.uid) return;
    const existing = await getDocs(this._tasksCol());
    if (existing.empty && confirm(`この端末の ${local.length} 件のタスクをアカウントに移しますか？`)) {
      const batch = writeBatch(this.db);
      for (const t of local) batch.set(doc(this._tasksCol(), t.id), makeTask(t));
      await batch.commit();
    }
    localStorage.setItem('kadai-board.migrated', this.user.uid);
  }

  // ---- ログイン ----
  async signIn() {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(this.auth, provider);
    } catch (e) {
      // iPhone のホーム画面アプリなどでポップアップが使えない場合はリダイレクト
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(this.auth, provider);
      } else throw e;
    }
  }

  signOut() {
    return signOut(this.auth);
  }

  onAuthChange(fn) {
    this.authListeners.add(fn);
  }

  // ---- LocalTaskStore と同じインターフェース ----
  _requireUser() {
    if (!this.user) throw new Error('ログインしてください（設定 → 同期）');
  }

  // Firestore の書き込み Promise はサーバーに届くまで解決しない（オフラインだと待ち続ける）。
  // ローカルキャッシュには即座に反映され onSnapshot も発火するので、ここでは待たずにエラーだけ拾う。
  _write(promise) {
    promise.catch((e) => {
      console.error('Firestore 書き込み失敗', e);
      alert('保存に失敗しました: ' + e.message);
    });
  }

  all() {
    return this.tasks;
  }

  async add(task) {
    this._requireUser();
    this._write(setDoc(doc(this._tasksCol(), task.id), task));
    return task;
  }

  async update(id, patch) {
    this._requireUser();
    const updated = { ...this.tasks.find((t) => t.id === id), ...patch, updatedAt: new Date().toISOString() };
    this._write(updateDoc(doc(this._tasksCol(), id), { ...patch, updatedAt: updated.updatedAt }));
    return updated;
  }

  async remove(id) {
    this._requireUser();
    this._write(deleteDoc(doc(this._tasksCol(), id)));
  }

  async replaceAll(tasks) {
    this._requireUser();
    // 一括書き込みは 500 件までなので分割
    const old = await getDocs(this._tasksCol());
    const ops = [
      ...old.docs.map((d) => (b) => b.delete(d.ref)),
      ...tasks.map((t) => (b) => b.set(doc(this._tasksCol(), t.id), makeTask(t))),
    ];
    for (let i = 0; i < ops.length; i += 450) {
      const batch = writeBatch(this.db);
      ops.slice(i, i + 450).forEach((op) => op(batch));
      await batch.commit();
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getMeta(key) {
    return this.meta[key] ?? null;
  }

  async setMeta(key, value) {
    this.meta[key] = value;
    if (this.user) await setDoc(this._metaDoc(), { [key]: value }, { merge: true });
  }

  _emit() {
    for (const fn of this.listeners) fn(this.tasks);
  }
}
