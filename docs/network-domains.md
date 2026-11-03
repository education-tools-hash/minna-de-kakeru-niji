# 通信先ドメインの一覧（学校のネットワーク確認用）

作成：2026年11月3日。対象：本番（https://minna-de-kakeru-niji.web.app）。
このアプリは静的な HTML／JS と Firebase（Realtime Database・匿名認証）だけで動く。広告・解析・外部フォント・外部 CDN（Firebase SDK を除く）は使っていない。

学校のネットワークで、下の表のドメインに **HTTPS（443）** で接続でき、**WebSocket（wss://）** が遮断されていないことを確認してほしい。

| 用途 | ドメイン | 通信の種類 | 必要な画面 |
|---|---|---|---|
| 画面の配信（HTML・JS・CSS・録音の音声） | `minna-de-kakeru-niji.web.app` | HTTPS | すべて |
| Firebase JS SDK の読み込み | `www.gstatic.com` | HTTPS | すべて |
| 匿名ログイン（ユーザー ID の発行） | `identitytoolkit.googleapis.com` | HTTPS | すべて |
| ログインの維持（トークンの更新。1時間ごと） | `securetoken.googleapis.com` | HTTPS | すべて（長時間の利用時） |
| 部屋のデータの読み書き（リアルタイム同期） | `minna-de-kakeru-niji-default-rtdb.asia-southeast1.firebasedatabase.app` | HTTPS と **WebSocket（wss）** | 先生・子ども |
| 同上（WebSocket が使えないときの代替） | `s-*.asia-southeast1.firebasedatabase.app`（SDK が自動で選ぶ。`*.firebasedatabase.app` を許可） | HTTPS（long polling） | 先生・子ども |

## 確認のしかた（学校の iPad・PC で）
1. Safari で `https://minna-de-kakeru-niji.web.app` を開き、「部屋をつくる（先生）」のボタンが出ること（配信と SDK の読み込み）。
2. ボタンを押して先生の画面が出ること（匿名ログインとデータベースへの書き込み）。
3. 子どもの端末で参加用のアドレスを開き、先生の画面に「参加希望」が出ること（データベースのリアルタイム同期）。
4. 承認後、子どものタップが相手の画面に数秒以内に反映されること。反映に 10 秒以上かかる場合は、WebSocket が遮断されて代替（long polling）に落ちている可能性がある。
5. 読み上げの声が出ること（音声ファイルの配信。`minna-de-kakeru-niji.web.app` の `audio/*.m4a`）。

## 補足
- 通信先はすべて Google（Firebase）のドメイン。IP アドレスは固定されていないので、ドメインで許可する。
- 児童生徒の氏名・顔写真・メールアドレス等は送信しない。送るのは匿名のユーザー ID、部屋 ID、カウンタの数値だけ。
- 「どのまな」など他のサービスには接続しない。
- エミュレータ（開発用、`localhost`）は学校では使わない。
- 表のドメインは、ソースコード（`public/app.js`・`public/firebase-config.js`）と Firebase SDK の仕様から挙げたもの。
- 実際の通信の確認（2026年11月3日、Claude Code のブラウザで本番の最初の画面を開いた時点）：`minna-de-kakeru-niji.web.app`・`www.gstatic.com`・`identitytoolkit.googleapis.com` の3つだけに通信した（録音の音声もこの時点で先読みされる）。データベース（`*.firebasedatabase.app`）と `securetoken.googleapis.com` は、部屋を作る・参加する操作のあと、または1時間後に使われるため、この時点では現れていない。学校での確認は上の手順 2〜4 まで行うこと。
