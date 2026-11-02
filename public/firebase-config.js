// Firebase の Web 設定。apiKey 等はブラウザに配られる公開前提の値で、秘密ではない。
// データの保護は Security Rules（database.rules.json）が担う。

export const PRODUCTION_CONFIG = {
  apiKey: 'AIzaSyCsSriTSSK2dzge-KNRrFpyOiWnE3EWPCk',
  authDomain: 'minna-de-kakeru-niji.firebaseapp.com',
  databaseURL: 'https://minna-de-kakeru-niji-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'minna-de-kakeru-niji',
  appId: '1:376740541460:web:01852c44aea24431aca301',
};

export const EMULATOR_CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'demo-niji.firebaseapp.com',
  projectId: 'demo-niji',
  databaseURL: 'http://127.0.0.1:9000?ns=demo-niji-default-rtdb',
};
