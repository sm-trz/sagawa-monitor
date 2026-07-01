# sagawa-monitor

佐川急便の配送状況を定期監視し、Google スプレッドシートへ自動反映するシステム。

Cloud Run + Playwright + Google Sheets API で構成されており、Cloud Scheduler から定期実行することを想定しています。

---

## アーキテクチャ

```
Cloud Scheduler
    │  (HTTP POST /run)
    ▼
Cloud Run (sagawa-monitor)
    │
    ├── Google Sheets API  ←→  スプレッドシート「返品管理」
    │       読み取り: B列（伝票番号）
    │       書き込み: D列（ステータス）/ E列（確認日時）/ F列（返品候補）/ G列（通知済）
    │
    └── Playwright (Chromium headless)
            └── 佐川急便 荷物問い合わせページ
```

---

## ディレクトリ構成

```
sagawa-monitor/
├── src/
│   ├── index.js      # エントリーポイント（HTTP サーバー）
│   ├── monitor.js    # 監視処理のメインロジック
│   ├── sagawa.js     # Playwright スクレイピング
│   ├── sheets.js     # Google Sheets API クライアント
│   ├── logger.js     # Winston ロガー設定
│   └── test.js       # ローカル動作確認スクリプト
├── Dockerfile        # Cloud Run 向けコンテナ定義
├── cloudbuild.yaml   # Cloud Build デプロイ設定
├── package.json
├── .env.example      # 環境変数サンプル
├── .gitignore
└── README.md
```

---

## スプレッドシートの構成

シート名: **返品管理**

| 列 | 内容 | 説明 |
|---|---|---|
| A | 注文番号 | 社内管理番号 |
| B | 伝票番号 | 佐川急便の10桁または12桁の伝票番号 |
| C | 発送日 | 出荷日 |
| D | 最終ステータス | ← 本システムが自動更新 |
| E | 最終確認日時 | ← 本システムが自動更新 |
| F | 返品候補 | ← 返品系ステータスのとき TRUE を設定 |
| G | 通知済 | ← 返品候補として通知済みのとき TRUE を設定 |

### 判定するステータス

| ステータス | 返品フラグ |
|---|---|
| 配達完了 | - |
| 配達中 | - |
| 輸送中 | - |
| 集荷 | - |
| 保管中 | - |
| 持戻り | ✅ TRUE |
| 受取拒否 | ✅ TRUE |
| 受取辞退 | ✅ TRUE |
| 返送 | ✅ TRUE |
| 返品 | ✅ TRUE |
| 長期不在 | ✅ TRUE |
| 伝票不明 | - |
| エラー | - |

---

## セットアップ手順

### 1. Google Cloud プロジェクトの準備

```bash
# プロジェクト ID を設定
export PROJECT_ID=your-gcp-project-id
gcloud config set project $PROJECT_ID

# 必要な API を有効化
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  sheets.googleapis.com \
  secretmanager.googleapis.com
```

### 2. サービスアカウントの作成

```bash
# Cloud Run 用サービスアカウント
gcloud iam service-accounts create sagawa-monitor-sa \
  --display-name="Sagawa Monitor Service Account"

export SA_EMAIL=sagawa-monitor-sa@${PROJECT_ID}.iam.gserviceaccount.com

# Google Sheets へのアクセス権限
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/editor"
```

### 3. スプレッドシートの共有設定

1. Google スプレッドシートを開く
2. 右上の「共有」をクリック
3. 上記で作成したサービスアカウントのメールアドレスを「編集者」として追加
   ```
   sagawa-monitor-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
   ```

### 4. Secret Manager への環境変数登録

```bash
# スプレッドシート ID を Secret Manager へ登録
echo -n "your_spreadsheet_id" | \
  gcloud secrets create SPREADSHEET_ID \
    --data-file=- \
    --replication-policy=automatic

# サービスアカウントに Secret へのアクセス権を付与
gcloud secrets add-iam-policy-binding SPREADSHEET_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

### 5. GitHub リポジトリへ Push

```bash
# リモートリポジトリが設定済みの場合
git add .
git commit -m "feat: 佐川急便配送状況監視システム 初期実装"
git push origin main
```

### 6. Cloud Build トリガーの設定

Cloud Console または gcloud コマンドでトリガーを作成します。

```bash
gcloud builds triggers create github \
  --repo-name=sagawa-monitor \
  --repo-owner=YOUR_GITHUB_USERNAME \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml \
  --name="sagawa-monitor-deploy"
```

### 7. Cloud Run への初回デプロイ

```bash
# 手動デプロイ（Cloud Build を使用）
gcloud builds submit --config cloudbuild.yaml \
  --substitutions="_SERVICE_NAME=sagawa-monitor,_REGION=asia-northeast1"
```

### 8. Cloud Run に環境変数を設定

```bash
gcloud run services update sagawa-monitor \
  --region=asia-northeast1 \
  --service-account=$SA_EMAIL \
  --set-secrets="SPREADSHEET_ID=SPREADSHEET_ID:latest" \
  --set-env-vars="SHEET_NAME=返品管理,NODE_ENV=production"
```

### 9. Cloud Scheduler の設定

```bash
# Cloud Run の URL を取得
export RUN_URL=$(gcloud run services describe sagawa-monitor \
  --region=asia-northeast1 \
  --format='value(status.url)')

# Scheduler 用サービスアカウントの作成
gcloud iam service-accounts create sagawa-scheduler-sa \
  --display-name="Sagawa Scheduler SA"

export SCHEDULER_SA=sagawa-scheduler-sa@${PROJECT_ID}.iam.gserviceaccount.com

# Cloud Run 呼び出し権限を付与
gcloud run services add-iam-policy-binding sagawa-monitor \
  --region=asia-northeast1 \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker"

# スケジュールジョブ作成（毎日 9:00, 13:00, 17:00 JST に実行）
gcloud scheduler jobs create http sagawa-monitor-job \
  --location=asia-northeast1 \
  --schedule="0 9,13,17 * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="${RUN_URL}/" \
  --http-method=GET \
  --oidc-service-account-email=$SCHEDULER_SA \
  --oidc-token-audience=$RUN_URL
```

---

## ローカル開発

### 環境構築

```bash
# 依存パッケージのインストール
npm install

# Playwright の Chromium をインストール
npx playwright install chromium

# 環境変数の設定
cp .env.example .env
# .env を編集して SPREADSHEET_ID 等を設定
```

### ローカル実行

```bash
# サーバー起動
npm start

# 起動直後に監視処理を実行する場合
RUN_ON_STARTUP=true npm start
```

### 動作テスト

```bash
# ステータス判定ロジックの単体テスト
npm test

# 特定の伝票番号でスクレイピングテスト
node src/test.js --tracking 1234567890

# HTTP エンドポイントの手動テスト
curl http://localhost:8080/health
curl -X POST http://localhost:8080/run
```

### Docker でローカルテスト

```bash
# イメージをビルド
docker build -t sagawa-monitor .

# コンテナを起動（.env の内容を渡す）
docker run --rm \
  --env-file .env \
  -p 8080:8080 \
  sagawa-monitor

# 動作確認
curl http://localhost:8080/health
curl http://localhost:8080/
```

---

## API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/health` | ヘルスチェック（Cloud Run の起動確認用） |
| GET | `/` | 監視処理を非同期で実行（Cloud Scheduler 用） |
| POST | `/run` | 監視処理を非同期で実行（手動トリガー用） |

---

## 環境変数一覧

| 変数名 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `SPREADSHEET_ID` | ✅ | - | Google スプレッドシートの ID |
| `SHEET_NAME` | - | `返品管理` | 対象シート名 |
| `PORT` | - | `8080` | HTTP サーバーのポート番号 |
| `RUN_ON_STARTUP` | - | `false` | 起動直後に監視処理を実行するか |
| `LOG_LEVEL` | - | `info` | ログレベル（debug/info/warn/error） |
| `GOOGLE_APPLICATION_CREDENTIALS` | ローカルのみ | - | サービスアカウントキー JSON のパス |

---

## トラブルシューティング

### Playwright が起動しない

Cloud Run のメモリが不足している可能性があります。`cloudbuild.yaml` の `--memory` を `2Gi` 以上に増やしてください。

```bash
gcloud run services update sagawa-monitor \
  --region=asia-northeast1 \
  --memory=2Gi
```

### Google Sheets API の認証エラー

サービスアカウントにスプレッドシートの編集権限が付与されているか確認してください。

```bash
# Cloud Run のサービスアカウントを確認
gcloud run services describe sagawa-monitor \
  --region=asia-northeast1 \
  --format='value(spec.template.spec.serviceAccountName)'
```

### ステータスが「不明」になる

佐川急便のページ構造が変わった可能性があります。`src/sagawa.js` の `tableSelectors` と `STATUS_KEYWORDS` を確認・更新してください。

ローカルでデバッグする際は `headless: false` に変更すると画面を確認できます。

### Cloud Scheduler から呼び出せない

Cloud Run が `--no-allow-unauthenticated` で保護されているため、Scheduler のサービスアカウントに `roles/run.invoker` 権限が必要です。セットアップ手順 9 を確認してください。

---

## コスト見積もり

月 90 回実行（1 日 3 回 × 30 日）、1 回あたり 5 分の場合：

| リソース | 試算 |
|---|---|
| Cloud Run（2 vCPU / 2GB / 5分 × 90回） | 約 $1〜2 |
| Cloud Build（1800秒 × ビルド回数） | 約 $0〜1 |
| Cloud Scheduler | 無料枠内 |
| **合計** | **約 $1〜3/月** |

---

## ライセンス

MIT
