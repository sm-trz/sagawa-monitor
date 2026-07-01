import { chromium } from 'playwright';
import { sheets as sheetsApi } from '@googleapis/sheets';
import { GoogleAuth } from 'google-auth-library';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || '返品管理';
const MAX_ROWS = Number(process.env.MAX_ROWS || 200);
const DAYS_TO_MONITOR = Number(process.env.DAYS_TO_MONITOR || 21);
const WAIT_MIN_MS = Number(process.env.WAIT_MIN_MS || 2500);
const WAIT_MAX_MS = Number(process.env.WAIT_MAX_MS || 6000);

const RETURN_KEYWORDS = [
  '返品',
  '返送',
  '差出人へ返送',
  '受取辞退',
  '受取拒否',
  '長期不在',
  '保管中',
  '持戻り',
  '持戻',
  'ご不在'
];

const STATUS_CANDIDATES = [
  '差出人へ返送',
  '受取辞退',
  '受取拒否',
  '長期不在',
  '持戻り',
  '持戻',
  '保管中',
  '返品',
  '返送',
  '配達完了',
  '配達中',
  '営業所へ輸送中',
  '営業所でお預かり',
  '輸送中',
  '集荷'
];

function requireEnv() {
  if (!SPREADSHEET_ID) {
    throw new Error('環境変数 SPREADSHEET_ID が未設定です');
  }
}

function normalizeTrackingNo(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomWait() {
  return WAIT_MIN_MS + Math.floor(Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS + 1));
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value).trim();
  const match = text.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function shouldMonitor(row) {
  const lastStatus = String(row[3] || '').trim();
  if (lastStatus === '配達完了') return false;

  const shippedAt = parseDate(row[2]);
  if (!shippedAt) return true;

  const diffDays = (Date.now() - shippedAt.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= DAYS_TO_MONITOR;
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function judgeStatus(rawText) {
  const text = normalizeText(rawText);

  // 「最新荷物状況」の近くを最優先で見る。ページ内の注意文に紛れるのを避けるため。
  const latestIndex = text.indexOf('最新荷物状況');
  if (latestIndex >= 0) {
    const area = text.slice(latestIndex, latestIndex + 250);
    for (const status of STATUS_CANDIDATES) {
      if (area.includes(status)) return status === '持戻' ? '持戻り' : status;
    }
  }

  // 履歴行の「⇒配達完了」なども拾う。
  for (const status of STATUS_CANDIDATES) {
    if (text.includes(status)) return status === '持戻' ? '持戻り' : status;
  }

  if (text.includes('お問い合せ送り状No.入力画面')) return '確認要';
  return '確認要';
}

function isReturnCandidate(status) {
  return RETURN_KEYWORDS.some(keyword => String(status).includes(keyword));
}

async function getSheetsClient() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return sheetsApi({ version: 'v4', auth });
}

async function readRows(sheets) {
  const range = `${SHEET_NAME}!A1:H${MAX_ROWS + 1}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  return res.data.values || [];
}

async function updateRow(sheets, rowNumber, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!D${rowNumber}:H${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });
}

async function fetchSagawaStatus(page, trackingNo) {
  const url = `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(trackingNo)}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1500);

  // 折りたたみ表示でも本文文字列には含まれることが多いが、念のため詳細を開く。
  const detailLinks = await page.locator('text=詳細').all().catch(() => []);
  for (const link of detailLinks.slice(0, 3)) {
    try { await link.click({ timeout: 1000 }); } catch (_) {}
  }

  const bodyText = await page.locator('body').innerText({ timeout: 10000 });
  const status = judgeStatus(bodyText);
  return {
    status,
    debug: normalizeText(bodyText).slice(0, 400)
  };
}

export async function runMonitor() {
  requireEnv();

  const sheets = await getSheetsClient();
  const rows = await readRows(sheets);

  if (rows.length <= 1) {
    return { checked: 0, updated: 0, message: 'データ行がありません' };
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let checked = 0;
  let updated = 0;
  const errors = [];

  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'ja-JP'
    });

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 1;
      const orderNo = row[0] || '';
      const trackingNo = normalizeTrackingNo(row[1]);

      if (!trackingNo) continue;
      if (!shouldMonitor(row)) continue;

      checked++;
      try {
        const result = await fetchSagawaStatus(page, trackingNo);
        const status = result.status || '確認要';
        const returnFlag = isReturnCandidate(status) ? 'TRUE' : '';
        const notified = row[6] || '';
        const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const debug = `${trackingNo} / ${result.debug}`;

        // D:最終ステータス E:最終確認日時 F:返品候補 G:通知済 H:デバッグ
        // 通知処理はまずスプレッドシート上のフラグのみ。必要ならSlack通知を追加可能。
        await updateRow(sheets, rowNumber, [status, now, returnFlag, notified, debug]);
        updated++;
      } catch (error) {
        const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        await updateRow(sheets, rowNumber, ['取得エラー', now, '', row[6] || '', String(error.message).slice(0, 400)]);
        errors.push({ row: rowNumber, orderNo, trackingNo, error: error.message });
      }

      await sleep(randomWait());
    }
  } finally {
    await browser.close();
  }

  return { checked, updated, errors };
}
