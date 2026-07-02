/**
 * sagawa-monitor / src/sheets.js
 * Google Sheets API クライアント
 *
 * 認証方式:
 *   - Cloud Run 上では Workload Identity (Application Default Credentials) を使用
 *   - ローカル開発では GOOGLE_APPLICATION_CREDENTIALS 環境変数でサービスアカウントキーを指定
 *
 * 対策済み問題:
 *   - ERR_STREAM_PREMATURE_CLOSE / Premature close / ECONNRESET / socket hang up
 *     → 指数バックオフ付きリトライ（最大 5 回）で自動復旧
 *   - keepAlive による接続再利用がストリームエラーを引き起こす問題
 *     → gaxios の keepAlive を無効化
 */

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { Gaxios } = require('gaxios');
const http = require('http');
const https = require('https');
const logger = require('./logger');

const SHEET_NAME = process.env.SHEET_NAME || '返品管理';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// リトライ設定
const RETRY_MAX       = 5;
const RETRY_BASE_MS   = 500;  // 初回待機: 500ms → 1s → 2s → 4s → 8s
const RETRY_MAX_MS    = 10000;

// リトライ対象エラーコード・メッセージ
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']);
const RETRYABLE_MSGS  = ['premature close', 'socket hang up', 'invalid response body'];

// 列インデックス定義（0始まり）
const COL = {
  ORDER_NO:     0, // A: 注文番号
  TRACKING_NO:  1, // B: 伝票番号
  SHIP_DATE:    2, // C: 発送日
  LAST_STATUS:  3, // D: 最終ステータス
  LAST_CHECKED: 4, // E: 最終確認日時
  RETURN_FLAG:  5, // F: 返品候補
  NOTIFIED:     6, // G: 通知済
};

// ── keepAlive 無効の HTTP/HTTPS エージェント ────────────────────────────────
// keepAlive を有効にしたままだと、Cloud Run ↔ Google API 間で
// 再利用された接続がサーバー側に切られた後も使われ Premature close が発生する
const httpAgent  = new http.Agent ({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// ── 認証クライアント（プロセス内でキャッシュ） ──────────────────────────────
let _authClient = null;

async function getAuthClient() {
  if (_authClient) return _authClient;

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _authClient = await auth.getClient();
  return _authClient;
}

// ── Sheets クライアント（keepAlive 無効の gaxios を注入） ───────────────────
async function getSheetsClient() {
  const authClient = await getAuthClient();

  // gaxios インスタンスに keepAlive 無効エージェントを渡す
  const gaxiosInstance = new Gaxios({
    agent: (parsedUrl) =>
      parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
  });

  return google.sheets({
    version: 'v4',
    auth: authClient,
    // googleapis v100 以降は fetchImplementation ではなく
    // options.gaxios でカスタムインスタンスを渡せる
    options: { gaxios: gaxiosInstance },
  });
}

// ── 指数バックオフ付きリトライラッパー ─────────────────────────────────────
/**
 * @param {string} label - ログ用ラベル
 * @param {() => Promise<T>} fn - リトライしたい非同期処理
 * @returns {Promise<T>}
 */
async function withRetry(label, fn) {
  let lastErr;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const code    = err.code || '';
      const msg     = (err.message || '').toLowerCase();
      const status  = err.status || err.response?.status || 0;

      const isRetryable =
        RETRYABLE_CODES.has(code) ||
        RETRYABLE_MSGS.some((m) => msg.includes(m)) ||
        status === 429 ||   // Rate Limit
        status === 503 ||   // Service Unavailable
        status === 500;     // Internal Server Error

      if (!isRetryable) {
        logger.error(`${label}: リトライ対象外エラー`, { code, status, message: err.message });
        throw err;
      }

      if (attempt === RETRY_MAX) break;

      const waitMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      logger.warn(`${label}: リトライ ${attempt}/${RETRY_MAX - 1} (${waitMs}ms 後)`, {
        code, status, message: err.message,
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  logger.error(`${label}: 最大リトライ回数 (${RETRY_MAX}) に達しました`, {
    message: lastErr.message,
  });
  throw lastErr;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * スプレッドシートから伝票番号が入力されている行を全件取得する
 */
async function fetchTrackingRows() {
  if (!SPREADSHEET_ID) throw new Error('環境変数 SPREADSHEET_ID が設定されていません');

  const sheets = await getSheetsClient();

  const response = await withRetry('fetchTrackingRows', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:G`,
    })
  );

  const rows = response.data.values || [];
  logger.info(`スプレッドシートから ${rows.length} 行取得しました`);

  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const trackingNo = (row[COL.TRACKING_NO] || '').trim();
    if (!trackingNo) continue;

    result.push({
      rowIndex:    i + 1,
      orderNo:     (row[COL.ORDER_NO]     || '').trim(),
      trackingNo,
      shipDate:    (row[COL.SHIP_DATE]    || '').trim(),
      lastStatus:  (row[COL.LAST_STATUS]  || '').trim(),
      lastChecked: (row[COL.LAST_CHECKED] || '').trim(),
      returnFlag:  (row[COL.RETURN_FLAG]  || '').trim(),
      notified:    (row[COL.NOTIFIED]     || '').trim(),
    });
  }

  logger.info(`処理対象行数: ${result.length}`);
  return result;
}

/**
 * 1行分の結果をスプレッドシートへ書き戻す（D〜F列）
 */
async function updateRow(rowIndex, { status, checkedAt, isReturn }) {
  if (!SPREADSHEET_ID) throw new Error('環境変数 SPREADSHEET_ID が設定されていません');

  const sheets = await getSheetsClient();
  const range  = `${SHEET_NAME}!D${rowIndex}:F${rowIndex}`;
  const values = [[status, checkedAt, isReturn ? 'TRUE' : '']];

  await withRetry(`updateRow(${rowIndex})`, () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    })
  );

  logger.info(`行 ${rowIndex} を更新しました`, { status, checkedAt, isReturn });
}

/**
 * G列（通知済）を TRUE に更新する
 */
async function markAsNotified(rowIndex) {
  if (!SPREADSHEET_ID) throw new Error('環境変数 SPREADSHEET_ID が設定されていません');

  const sheets = await getSheetsClient();

  await withRetry(`markAsNotified(${rowIndex})`, () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!G${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['TRUE']] },
    })
  );

  logger.info(`行 ${rowIndex} を通知済みにしました`);
}

module.exports = { fetchTrackingRows, updateRow, markAsNotified };
