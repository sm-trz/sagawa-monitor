/**
 * sheets.js
 * Google スプレッドシートの読み書き。
 *
 * 認証は Application Default Credentials（ADC）。
 * Cloud Run ではサービスアカウントの権限がそのまま使われるため、
 * 鍵ファイルは不要です（対象シートに編集者として共有しておくこと）。
 *
 * 列の構成:
 *   A 注文番号 / B 配送会社 / C 伝票番号 / D 発送日
 *   E 最終ステータス / F 最終確認日時 / G 返品候補 / H 通知済 / I 備考
 */

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const logger = require('./logger');
const config = require('./config');

const READ_RANGE = 'A:I';

const COL = {
  ORDER_NO: 0,     // A
  CARRIER: 1,      // B
  TRACKING_NO: 2,  // C
  SHIP_DATE: 3,    // D
  STATUS: 4,       // E
  CHECKED_AT: 5,   // F
  RETURN_FLAG: 6,  // G
  NOTIFIED: 7,     // H
  NOTE: 8,         // I
};

// ── リトライ設定 ─────────────────────────────────────────────
const RETRY_MAX = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 10000;
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE',
]);
const RETRYABLE_MSGS = ['premature close', 'socket hang up', 'invalid response body'];

let _sheets = null;

async function getSheetsClient() {
  if (_sheets) return _sheets;
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  _sheets = google.sheets({ version: 'v4', auth: authClient });
  return _sheets;
}

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err.code || '';
      const msg = (err.message || '').toLowerCase();
      const status = err.status || (err.response && err.response.status) || 0;
      const retryable =
        RETRYABLE_CODES.has(code) ||
        RETRYABLE_MSGS.some((m) => msg.includes(m)) ||
        status === 429 || status === 500 || status === 503;

      if (!retryable || attempt === RETRY_MAX) {
        logger.error(`${label}: 失敗しました`, { code, status, message: err.message });
        throw err;
      }
      const waitMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      logger.warn(`${label}: ${waitMs}ms 後に再試行します (${attempt}/${RETRY_MAX - 1})`, {
        code, status, message: err.message,
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function cell(row, index) {
  return String((row && row[index]) || '').trim();
}

/** 伝票番号からハイフン・空白を取り除いて数字だけにする */
function cleanTrackingNo(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

/**
 * シート全体を読み、1行ずつのオブジェクトにして返す。
 */
async function fetchRows() {
  if (!config.SPREADSHEET_ID) {
    throw new Error('環境変数 SPREADSHEET_ID が設定されていません');
  }
  const sheets = await getSheetsClient();
  const res = await withRetry('シート読み取り', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${config.SHEET_NAME}!${READ_RANGE}`,
    })
  );

  const values = res.data.values || [];
  logger.info(`シートから ${values.length} 行を読み込みました（見出し行を含む）`);

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    const trackingNo = cleanTrackingNo(cell(raw, COL.TRACKING_NO));
    if (!trackingNo) continue;

    rows.push({
      rowIndex: i + 1, // シート上の実際の行番号
      orderNo: cell(raw, COL.ORDER_NO),
      carrierRaw: cell(raw, COL.CARRIER),
      trackingNo,
      shipDate: cell(raw, COL.SHIP_DATE),
      status: cell(raw, COL.STATUS),
      checkedAt: cell(raw, COL.CHECKED_AT),
      returnFlag: cell(raw, COL.RETURN_FLAG),
      notified: cell(raw, COL.NOTIFIED),
      note: cell(raw, COL.NOTE),
    });
  }
  return rows;
}

/**
 * 複数行の E〜I 列をまとめて更新する（API 呼び出しは1回）。
 * @param {Array<{rowIndex:number, status:string, checkedAt:string,
 *                returnFlag:string, notified:string, note:string}>} updates
 */
async function writeRows(updates) {
  if (!updates || updates.length === 0) return 0;
  const sheets = await getSheetsClient();

  const data = updates.map((u) => ({
    range: `${config.SHEET_NAME}!E${u.rowIndex}:I${u.rowIndex}`,
    values: [[u.status, u.checkedAt, u.returnFlag, u.notified, u.note]],
  }));

  await withRetry('シート書き込み', () =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    })
  );

  logger.info(`シートの ${updates.length} 行を更新しました（1回のAPI呼び出し）`);
  return updates.length;
}

/** 見出し行が新しい列構成になっているか確認する（起動時の事故防止） */
async function checkHeader() {
  const sheets = await getSheetsClient();
  const res = await withRetry('見出し行の確認', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${config.SHEET_NAME}!A1:I1`,
    })
  );
  const header = (res.data.values && res.data.values[0]) || [];
  const b = String(header[1] || '').trim();
  const ok = b.includes('配送会社');
  if (!ok) {
    logger.warn(
      'B列の見出しが「配送会社」ではありません。列の構成が古い可能性があります',
      { header }
    );
  }
  return { ok, header };
}

module.exports = { fetchRows, writeRows, checkHeader, cleanTrackingNo, COL };
