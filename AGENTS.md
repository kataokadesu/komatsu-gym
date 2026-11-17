# AGENTS

パーソナルジム向けの予約・チケット（回数券）管理 Web アプリです。
HTML 1 枚と設定ファイル 1 枚で動き、ビルドも npm も使いません。
データの保存とログインは Firebase（Authentication / Firestore / Storage）を使います。
公開は Firebase Hosting（公開先は `.firebaserc` に書いた Firebase プロジェクト）です。

## 基本ルール

1. 応答、コードコメント、コミットメッセージ、PR の本文は日本語で書く。
2. セッションタイトルは動詞から始め、30 文字以内にする（例: `予約画面に人数選択を追加`）。
3. 変更する前に、該当するセクションのコードを実際に読む。`index.html` は 2,000 行を超えるので、下の構造マップから当たりを付けてから読む。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | アプリ本体。店舗固有の値は書かず、すべて `SHOP` から読む |
| `config.js` | 店舗設定（`SHOP`）と Firebase 接続情報（`FIREBASE_CONFIG`）。店舗ごとに書き換える唯一のファイル |
| `firestore.rules` | Firestore のセキュリティルール。Firebase コンソールに貼り付けて使う |
| `storage.rules` | 会員写真用 Storage のルール（写真機能を使う店舗のみ） |
| `sw.js` | 通知用の service worker。キャッシュはしない |
| `manifest.json`, `icons/` | ホーム画面追加（PWA）用 |
| `README.md` | 利用者向けの機能説明 |
| `mail-worker/` | お知らせメールを Resend で送る Cloudflare Worker。準備は `mail-worker/README.md`。Hosting には出さない |
| `SETUP.md` | 新しいジムへ導入する手順書 |
| `引継ぎ-はじめにお読みください.md` | 全体の地図。制約と運用の注意 |
| `見本/config-first.js` | 先行店舗の `config.js` の実物。書き方の見本（接続情報は空） |
| `mail-gas/` | お店の Gmail からお知らせメールを送る Google Apps Script。準備は `mail-gas/README.md` |

現在の `config.js` は新しいジム用のひな形です。店名・配色・契約書は仮の値が入っています。
`FIREBASE_CONFIG` は未入力なので、そのまま開くとデモモードで起動します。

## index.html の構造マップ

`<head>` で Firebase compat SDK 10.14.1 と `config.js` を読み込み、`<style>`、マークアップ（`header.brand`、`main#screen`、`nav.tabs`、モーダル）の後に、1 本の長いスクリプトが続きます。
スクリプトは `/* ===== ... ===== */` 形式のコメントで区切られており、順番は次のとおりです。

- 起動時の判定: `DEMO`（`SHOP.demo === true` または `FIREBASE_CONFIG.apiKey` が未入力）、`SETTINGS`（営業時間の初期値）
- 利用契約書: `fillTerms` / `openTerms` / `agreeFromTerms`（`{{氏名}}` などの差し込み）
- ロゴとスプラッシュ: `logoMark` / `showSplash`
- 通知: `pushSupport` / `registerSW` / `enablePush` / `pushCard`。`savePushToken` は未実装のスタブ
- `init()`: DOMContentLoaded で起動。デモなら `startDemo()`、それ以外は Firebase を初期化して `makeFirebaseSb()`
- デモモード: `seedDB` / `makeMockSb`。データは localStorage に保存する
- Firebase アダプタ `makeFirebaseSb`: Supabase 互換の `sb.from(table).select(...).eq(...)` 形式の API を Firestore で実装したもの。関連データの結合は `hydrate` が担当
- 認証: `doAuth` / `afterLogin` / `logout`。最初に登録したアカウントが自動で `admin` になる
- 描画: `buildTabs` / `render` が `curTab` に応じて各ビュー関数を呼ぶ
- 会員向けビュー: `memberReserveView`（予約、月カレンダー）、`memberMineView`（マイ予約）、`memberGroupView`（グループ）、`memberMeView`（マイページ）、ヒアリングシートのウィザード（`wiz*`）
- 管理者向けビュー: `adminReserveView`、`adminTicketsView`、`adminMembersView`（会員写真を含む）、`adminSettingsView`
- 共通 UI: `openOv` / `closeOv` / `askConfirm` / `toast`

## データモデル（Firestore コレクション）

コレクション名は Supabase 時代のテーブル名をそのまま使っています。

| コレクション | ドキュメント ID | 主なフィールド |
| --- | --- | --- |
| `profiles` | Auth UID | `name`, `role`（`admin` / `member`）, `tickets`, `tickets2`（`SHOP.courses` の2つ目のコースのチケット）, `terms_agreed_at`, `trial_used`（初回体験を使ったか）, `booked_once`（一度でも予約したか）, `intake_done`（登録直後にヒアリングを書き終えたか。どちらかが true なら下のタブを出す） |
| `settings` | 固定 `"1"` / `"staff"` / `"bootstrap"` | `"1"`: 営業時間など。`"staff"`: スタッフの合言葉 `code`（オーナーだけ読み書き）。`"bootstrap"`: トレーナー登録済みの印と `owner_uid`（オーナー＝最初に登録したトレーナー） |
| `reservations` | 自動 | `user_id`, `date`（`YYYY-MM-DD`）, `hour`, `party`, `guests`, `tickets_used`, `trainer_id`, `trial`（初回体験）, `course`（`SHOP.courses` の2つ目以降のコースの id。1つ目は書かない） |
| `reservation_participants` | 自動 | `reservation_id`, `user_id`（相乗り） |
| `blocks` | 自動 | `date`, `hour`, `trainer_id`（`null` は全員）, `memo`, `by`（予約をとめた枠） |
| `groups` | 自動 | `name`, `invite_code`, `owner_id`（`SHOP.groups === true` の店舗のみ使用） |
| `group_members` | 自動 | `group_id`, `user_id` |
| `member_photos` | `会員ID__ファイル名` | `user_id`, `name`, `data`（縮めた JPEG の data URL）。`SHOP.photoStore` が `"firestore"` の店舗だけ使う（トレーナーのみ読み書き） |
| `ticket_history` | 自動 | `user_id`, `delta`, `memo`, `by_admin`, `course`（予約と同じ） |
| `intake_sheets` | user_id | ヒアリングシートの回答（`SHOP.intake` の `key` ごと）と `completed_at`（最後まで入力した日時。予約の必須条件）、`email`（お知らせメールの宛先） |

## 変更するときの約束

- 店舗ごとの差分は `config.js` だけに置く。`index.html` に店名、色、文言などの固有値を直書きしない。新しい設定項目は `SHOP` に追加し、未指定でも動く既定値を `index.html` 側に持たせる。
- Firestore のコレクション、フィールド、クエリを増やしたら、同じ変更で `firestore.rules` も更新する。ルールが古いままだと本番で権限エラーになる。
- `sb` API で新しいクエリの形を使うときは、`makeFirebaseSb` と `makeMockSb` の両方で動くようにする。デモモードは営業提案で使うので壊さない。
- チケットの消費と返却はクライアント側で行っている。枚数を変える処理は必ず `ticket_history` に履歴を残す。
- 「最初に登録したアカウントが管理者（オーナー）になる」仕様は維持する。スタッフの合言葉はオーナーだけが扱える。
- 外部依存を増やさない。npm やビルド工程を持ち込まず、Firebase SDK は compat 版 10.14.1 のままにする。
- ヒアリングシート、電話番号、写真は個人情報なので、ルールは「本人と管理者だけが読める」形を保つ。
- 実店舗の Firebase 設定値や会員の個人情報をコミットしない。

## 動かし方と確認

自動テストはありません。確認はブラウザで行います。

```bash
python -m http.server 8080
```

`http://localhost:8080/` を開くとデモモードで起動し、画面上部の黄色いバーで会員とトレーナーを切り替えられます。
`file://` で直接開いても動きますが、service worker は登録されません。

変更後は、少なくとも次を通してください。

- 会員: 予約 → マイ予約で確認 → 取消
- トレーナー: 予約状況、会員一覧（名前の横でチケット枚数も修正）、設定
- コンソールにエラーが出ていない
- モバイル幅（375px）で崩れていない。主にスマホから使われるアプリです

Firebase の実環境での確認は、各店舗の Firebase プロジェクトで行います。
ルールの反映は `firebase deploy --only firestore:rules`、または Firebase コンソールへの貼り付けです。
打ち合わせ用に見せるときは、本番ではなくプレビューチャンネル（`firebase hosting:channel:deploy demo --expires 30d`）を使います。

## Git と PR

- 既定ブランチは `main`。共同開発なので `main` へ直接 push せず、ブランチを切って PR で取り込む。
- コミットメッセージは `feat:` / `fix:` / `chore:` の接頭辞と日本語の要約（例: `feat: 契約書に会員情報を差し込める仕組みを追加`）。
- コミット作成は `git-commit` スキル、PR の作成と更新は `git-pullrequest` スキルに従う。
- 本番反映は `firebase deploy --only hosting`（`main` を手元に取り込んでから実行）。`main` へのマージだけでは反映されないので、マージ後にデプロイする。自動デプロイは未設定。

## エージェントの使い分け

- `reviewer`: コミットや PR の前に、規約違反や明らかなバグを読み取り専用で確認する。`reviewer-deep` はチケットの増減、`firestore.rules`、認証まわりなど高リスクな箇所に限って使う。
- `debugger`: 原因がすぐに分からない不具合の調査（読み取り専用）。
- `verifier`: このリポジトリにはテストや lint がないため、出番は少ない。
- `ui-review` / `ux-persona`: 画面を変えた後の見た目と使い勝手の確認。デモモードの URL を渡す。
- `web-ui` スキル: 見た目を変えるときに読み込む。色は `SHOP.theme` の 7 色の範囲で使い、新しい色を増やさない。

## Review guidelines

- `index.html` に店舗固有の値が入っていないか
- `firestore.rules` と実装が合っているか（新しい書き込み先に `allow` があるか、逆に緩めすぎていないか）
- モックと Firebase の両アダプタで同じ結果になるか
- チケット枚数の増減が `ticket_history` に残るか
- 当日キャンセルなどの業務ルールが README の説明と一致するか
- スマホ幅での表示が崩れていないか
