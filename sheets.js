/**
 * sagawa-monitor / src/sheets.js
 * Google Sheets API クライアント
 *
 * 認証方式:
 *   - Cloud Run 上では Workload Identity (Application Default Credentials) を使用
 *   - ローカル開発では GOOGLE_APPLICATION_CREDENTIALS 環境変数でサービスアカウントキーを指定
 */

const { google } = require('googleapis');
const logger = require('./logger');

const SHEET_NAME = process.env.SHEET_NAME || '返品管理';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 列インデックス定義（0始まり）
const COL = {
  ORDER_NO: 0,       // A: 注文番号
  TRACKING_NO: 1,    // B: 伝票番号
  SHIP_DATE: 2,      // C: 発送日
  LAST_STATUS: 3,    // D: 最終ステータス
  LAST_CHECKED: 4,   // E: 最終確認日時
  RETURN_FLAG: 5,    // F: 返品候補
  NOTIFIED: 6,       // G: 通知済
};

/**
 * Google Sheets API の認証済みクライアントを返す
 */
async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

/**
 * スプレッドシートから伝票番号が入力されている行を全件取得する
 * @returns {Array<{ rowIndex: number, orderNo: string, trackingNo: string, shipDate: string, notified: string }>}
 */
async function fetchTrackingRows() {
  if (!SPREADSHEET_ID) {
    throw new Error('環境変数 SPREADSHEET_ID が設定されていません');
  }

  const authClient = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:G`,
  });

  const rows = response.data.values || [];
  logger.info(`スプレッドシートから ${rows.length} 行取得しました`);

  const result = [];
  // 1行目はヘッダーなのでスキップ（index=0）
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const trackingNo = (row[COL.TRACKING_NO] || '').trim();

    // 伝票番号が空の行はスキップ
    if (!trackingNo) continue;

    result.push({
      rowIndex: i + 1, // スプレッドシートの行番号（1始まり）
      orderNo: (row[COL.ORDER_NO] || '').trim(),
      trackingNo,
      shipDate: (row[COL.SHIP_DATE] || '').trim(),
      lastStatus: (row[COL.LAST_STATUS] || '').trim(),
      lastChecked: (row[COL.LAST_CHECKED] || '').trim(),
      returnFlag: (row[COL.RETURN_FLAG] || '').trim(),
      notified: (row[COL.NOTIFIED] || '').trim(),
    });
  }

  logger.info(`処理対象行数: ${result.length}`);
  return result;
}

/**
 * 1行分の結果をスプレッドシートへ書き戻す
 * @param {number} rowIndex - スプレッドシートの行番号（1始まり）
 * @param {object} data - 書き込みデータ
 * @param {string} data.status - 配送ステータス
 * @param {string} data.checkedAt - 確認日時
 * @param {boolean} data.isReturn - 返品フラグ
 */
async function updateRow(rowIndex, { status, checkedAt, isReturn }) {
  if (!SPREADSHEET_ID) {
    throw new Error('環境変数 SPREADSHEET_ID が設定されていません');
  }

  const authClient = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // D列（最終ステータス）〜 F列（返品候補）を更新
  // G列（通知済）は通知処理が行うため、ここでは触らない
  const range = `${SHEET_NAME}!D${rowIndex}:F${rowIndex}`;
  const values = [[status, checkedAt, isReturn ? 'TRUE' : '']];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  logger.info(`行 ${rowIndex} を更新しました`, { status, checkedAt, isReturn });
}

/**
 * G列（通知済）を TRUE に更新する
 * @param {number} rowIndex
 */
async function markAsNotified(rowIndex) {
  if (!SPREADSHEET_ID) {
    throw new Error('環境変数 SPREADSHEET_ID が設定されていません');
  }

  const authClient = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!G${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['TRUE']] },
  });

  logger.info(`行 ${rowIndex} を通知済みにしました`);
}

module.exports = { fetchTrackingRows, updateRow, markAsNotified };
