# sagawa-monitor

佐川急便・ヤマト運輸の配送状況を定期的に確認し、返品候補を Google スプレッドシートへ記録するシステム。

## 全体の流れ

```
Cloud Scheduler（1日2〜3回）
  ↓ POST /run
Cloud Run（Node.js + Playwright + Chromium）
  ↓ 読み取り
Google スプレッドシート「返品管理」
  ↓ 未完了の伝票だけ照会
佐川急便 / ヤマト運輸 の荷物問い合わせページ
  ↓ 判定
Google スプレッドシートへ書き戻し（E〜I列）
```

## スプレッドシートの列

| 列 | 内容 | 入力者 |
|----|------|--------|
| A | 注文番号 | 人 |
| B | 配送会社（`佐川` または `ヤマト`） | 人 |
| C | 伝票番号 | 人 |
| D | 発送日 | 人 |
| E | 最終ステータス | システム |
| F | 最終確認日時 | システム |
| G | 返品候補（空 / `要確認` / `返品濃厚`） | システム |
| H | 通知済（`TRUE`） | システム |
| I | 備考 | システム |

## ファイルの役割

| ファイル | 役割 |
|----------|------|
| `index.js` | Cloud Run の入口（HTTP サーバー） |
| `monitor.js` | 処理全体の流れ |
| `judge.js` | 返品候補かどうかの判定ルール |
| `sheets.js` | スプレッドシートの読み書き |
| `browser.js` | Chromium の起動・終了 |
| `config.js` | 設定（環境変数） |
| `logger.js` | ログ出力 |
| `carriers/sagawa.js` | 佐川急便のページ解析 |
| `carriers/yamato.js` | ヤマト運輸のページ解析 |
| `carriers/index.js` | 配送会社の振り分け |
| `test.js` | 通信なしの判定テスト（`npm test`） |

## URL

| URL | 動作 |
|-----|------|
| `GET /` | 設定内容を表示するだけ。**監視は実行されない** |
| `GET /run` | 監視を実行（ブラウザからのテスト用） |
| `POST /run` | 監視を実行（Cloud Scheduler 用） |
| `GET /health` | 生存確認 |

## 環境変数

| 名前 | 既定値 | 意味 |
|------|--------|------|
| `SPREADSHEET_ID` | （必須） | スプレッドシートの ID |
| `SHEET_NAME` | `返品管理` | シート名 |
| `STALE_DAYS` | `7` | 発送から何日で「要確認」にするか |
| `MAX_MONITOR_DAYS` | `45` | 何日で監視を打ち切るか |
| `REQUEST_INTERVAL_MS` | `3000` | 1件ごとの待ち時間 |
| `MAX_PER_RUN` | `150` | 1回の実行で照会する上限 |
| `YAMATO_STATUS_JUDGE` | `off` | ヤマトの文言で返品判定するか |
| `DUMP_PAGE_TEXT` | `on` | ページ本文をログに出すか |
| `RUN_TOKEN` | （空） | 設定すると `/run?token=` が必要になる |
| `LOG_LEVEL` | `info` | ログの詳しさ |

## 判定ルール

1. **配達完了** → 監視終了。以後照会しない
2. **返送 / 返品 / 受取拒否 / 受取辞退** → `返品濃厚`
3. **調査中 / 持戻り / 長期不在** → `要確認`
4. **発送から `STALE_DAYS` 日を超えて未完了** → `要確認`（文言に依存しない安全網）
5. 想定外の文言 → `要確認`（気づけるようにするため）

### 佐川ページ解析の要点（実データで確認済み）

- 履歴の最新の1行だけ `⇒` が付く。**必ずこの行を見る**
- ページ全文のキーワード検索は禁止。`集荷に関するお問い合せ` という共通ラベルで誤ヒットする
- **返品された荷物に「返品」とは表示されない**。実例では `調査中` + 履歴テーブル消失だった

## デプロイ

GitHub の main ブランチへの push → Cloud Build（GitHub 継続デプロイ）→ Cloud Run。
`cloudbuild.yaml` は使用していません。Cloud Run の設定は Google Cloud コンソール側で管理します。

## 将来の移行先

公開ページの巡回ではなく、公式 API への移行を推奨します。
`carriers/` の中身を差し替えるだけで移行できる構造にしてあります。

- 佐川急便 スマートAPI: https://www.sagawa-exp.co.jp/business/send/service/option/smart-api/
- ヤマト運輸 クロネコメンバーズサービス連携API: https://business.kuronekoyamato.co.jp/service/lineup/business_members/api/km/
