// アプリ設定
// 段階1では何も変更しなくてよい。段階2で値を埋めると同期機能が有効になる（README 参照）。

export const CONFIG = {
  // 'local' = localStorage（段階1） / 'firebase' = Firestore＋Googleログイン（段階2）
  storage: 'local',

  // 段階2: Firebase コンソール > プロジェクトの設定 > マイアプリ の firebaseConfig をそのまま貼る
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    appId: '',
  },

  // 段階2: Google Calendar API 自動同期
  google: {
    // Google Cloud Console で作った「ウェブアプリケーション」の OAuth クライアントID。空なら無効
    clientId: '',
    // 書き込み先の専用カレンダー名
    calendarName: '課題',
    // このアプリが作ったカレンダーだけを操作できる最小権限のスコープ
    scope: 'https://www.googleapis.com/auth/calendar.app.created',
  },

  timeZone: 'Asia/Tokyo',
};
