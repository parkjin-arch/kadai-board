// アプリ設定
// 下の firebase と google.clientId を埋めると、クラウド保存と Googleカレンダー自動同期が有効になる（README 参照）。
// どちらの値も公開して問題ないもの（アクセスは Firebase のルールと Google の承認済みドメインで守られる）。

// Firebase コンソール > プロジェクトの設定 > マイアプリ の firebaseConfig をそのまま貼る
const firebase = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: '',
};

export const CONFIG = {
  // Firebase の設定があればクラウド（Firestore＋Googleログイン）、なければこの端末の localStorage に保存
  storage: firebase.apiKey ? 'firebase' : 'local',
  firebase,

  // Google Calendar API 自動同期
  google: {
    // Google Cloud Console の「ウェブアプリケーション」の OAuth クライアントID。空なら無効
    clientId: '',
    // 書き込み先の専用カレンダー名
    calendarName: '課題',
    // このアプリが作ったカレンダーだけを操作できる最小権限のスコープ
    scope: 'https://www.googleapis.com/auth/calendar.app.created',
  },

  timeZone: 'Asia/Tokyo',
};
