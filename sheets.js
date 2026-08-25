/**
 * sheets.js
 * Google スプレッドシートの読み書き。
 *
 * 認証は Application Default Credentials（ADC）。
 * Cloud Run ではサービスアカウントの権限がそのまま使われるため鍵ファイルは不要。
 * （対象シートにサービスアカウントを編集者として共有しておくこと）
 *
 * 列の構成:
 *   A 注文番号 / B 配送会社 / C 伝票番号 / D 発送日時
 *   E 氏名 / F 住所 / G 電話番号
 *   H 最終ステータス / I 最終確認日時 / J 判定 / K 通知済
 *   L 配達完了日時 / M 返品・持戻り日時 / N 備考
 *
 * 書き込むのは D（空欄のときだけ）と H〜N。
 * A〜C・E〜G には一切書き込まないので、人の入力を壊しません。
 */

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const logger = require('./logger');
const config = require('./config');

const READ_RANGE = 'A:N';

const COL = {
  ORDER_NO: 0,     // A
  CARRIER: 1,      // B
  TRACKING_NO: 2,  // C
  SHIP_DATE: 3,    // D
  NAME: 4,         // E
  ADDRESS: 5,      // F
  TEL: 6,          // G
  STATUS: 7,       // H
  CHECKED_AT: 8,   // I
  FLAG: 9,         // J
  NOTIFIED: 10,    // K
  DELIVERED_AT: 11,// L
  RETURNED_AT: 12, // M
  NOTE: 13,        // N
};

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
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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
      rowIndex: i + 1,
      orderNo: cell(raw, COL.ORDER_NO),
      carrierRaw: cell(raw, COL.CARRIER),
      trackingNo,
      shipDate: cell(raw, COL.SHIP_DATE),
      name: cell(raw, COL.NAME),
      address: cell(raw, COL.ADDRESS),
      tel: cell(raw, COL.TEL),
      status: cell(raw, COL.STATUS),
      checkedAt: cell(raw, COL.CHECKED_AT),
      flag: cell(raw, COL.FLAG),
      notified: cell(raw, COL.NOTIFIED),
      deliveredAt: cell(raw, COL.DELIVERED_AT),
      returnedAt: cell(raw, COL.RETURNED_AT),
      note: cell(raw, COL.NOTE),
    });
  }
  return rows;
}

/**
 * まとめて書き戻す（API 呼び出しは1回）。
 * D列は writeShipDate が true の行だけ書く（人の入力を上書きしないため）。
 */
async function writeRows(updates) {
  if (!updates || updates.length === 0) return 0;
  const sheets = await getSheetsClient();

  const data = [];
  for (const u of updates) {
    if (u.writeShipDate && u.shipDate) {
      data.push({
        range: `${config.SHEET_NAME}!D${u.rowIndex}`,
        values: [[u.shipDate]],
      });
    }
    data.push({
      range: `${config.SHEET_NAME}!H${u.rowIndex}:N${u.rowIndex}`,
      values: [[
        u.status,
        u.checkedAt,
        u.flag,
        u.notified,
        u.deliveredAt,
        u.returnedAt,
        u.note,
      ]],
    });
  }

  await withRetry('シート書き込み', () =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    })
  );

  logger.info(`シートの ${updates.length} 行を更新しました（1回のAPI呼び出し）`);
  return updates.length;
}

/** 見出し行が新しい列構成になっているか確認する（事故防止） */
async function checkHeader() {
  const sheets = await getSheetsClient();
  const res = await withRetry('見出し行の確認', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${config.SHEET_NAME}!A1:N1`,
    })
  );
  const header = (res.data.values && res.data.values[0]) || [];
  const expect = [
    { index: 1, word: '配送会社' },
    { index: 2, word: '伝票番号' },
    { index: 7, word: 'ステータス' },
    { index: 11, word: '配達完了' },
  ];
  const wrong = expect.filter((e) => !String(header[e.index] || '').includes(e.word));
  if (wrong.length > 0) {
    logger.warn('見出し行が想定と違います。列の構成を確認してください', {
      header,
      期待: 'A注文番号 B配送会社 C伝票番号 D発送日時 E氏名 F住所 G電話番号 H最終ステータス I最終確認日時 J判定 K通知済 L配達完了日時 M返品・持戻り日時 N備考',
    });
  }
  return { ok: wrong.length === 0, header };
}

module.exports = { fetchRows, writeRows, checkHeader, cleanTrackingNo, COL };
