/**
 * sagawa-monitor / src/sagawa.js
 * Playwright で佐川急便の荷物問い合わせページをスクレイピングする
 *
 * 対象URL: https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do
 */

const { chromium } = require('playwright');
const logger = require('./logger');

// 判定するステータス一覧（優先度順）
const STATUS_KEYWORDS = [
  { label: '受取拒否', keywords: ['受取拒否'] },
  { label: '受取辞退', keywords: ['受取辞退'] },
  { label: '返送',     keywords: ['返送'] },
  { label: '返品',     keywords: ['返品'] },
  { label: '長期不在', keywords: ['長期不在', '長期間不在'] },
  { label: '持戻り',   keywords: ['持戻り', '持ち戻り', '不在持戻'] },
  { label: '保管中',   keywords: ['保管中', '営業所保管'] },
  { label: '配達完了', keywords: ['配達完了', 'お届け済み', '配達済'] },
  { label: '配達中',   keywords: ['配達中', 'お届け中'] },
  { label: '輸送中',   keywords: ['輸送中', '幹線輸送中', '配達店到着'] },
  { label: '集荷',     keywords: ['集荷'] },
];

// 返品系ステータス
const RETURN_STATUSES = new Set(['受取拒否', '受取辞退', '返送', '返品', '長期不在', '持戻り']);

/**
 * ステータス文字列からラベルを判定する
 * @param {string} rawText - ページから取得した生テキスト
 * @returns {string} - 判定済みステータスラベル
 */
function classifyStatus(rawText) {
  if (!rawText) return '不明';

  for (const { label, keywords } of STATUS_KEYWORDS) {
    for (const kw of keywords) {
      if (rawText.includes(kw)) {
        return label;
      }
    }
  }
  return '不明';
}

/**
 * ステータスが返品系かどうか判定する
 * @param {string} status
 * @returns {boolean}
 */
function isReturnStatus(status) {
  return RETURN_STATUSES.has(status);
}

/**
 * 佐川急便の荷物問い合わせページから配送状況を取得する
 * @param {string} trackingNo - 伝票番号（10桁または12桁）
 * @param {import('playwright').Browser} browser - 再利用するブラウザインスタンス
 * @returns {{ rawText: string, status: string, isReturn: boolean }}
 */
async function fetchDeliveryStatus(trackingNo, browser) {
  const url = `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(trackingNo)}`;

  logger.info(`配送状況を取得中: ${trackingNo}`);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });

  const page = await context.newPage();

  try {
    // ページ遷移（JavaScript 実行後のコンテンツを待つため waitUntil: networkidle）
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // ページが完全にレンダリングされるまで待機
    await page.waitForTimeout(2000);

    // ----- ステータステキストの抽出 -----
    // 佐川のページ構造に応じて複数のセレクタを試みる
    let rawText = '';

    // 方法1: 輸送状況テーブル全体のテキストを取得
    const tableSelectors = [
      '.tbl-okurijyoSearch',          // 一般的なステータステーブル
      '.wr-okurijyo',                  // 荷物詳細エリア
      '#result',                       // 結果エリア
      '.resultArea',                   // 結果エリア（別パターン）
      'table',                         // フォールバック: 最初のテーブル
    ];

    for (const selector of tableSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          rawText = await el.innerText();
          if (rawText && rawText.trim().length > 0) {
            logger.debug(`セレクタ "${selector}" でテキストを取得`, { preview: rawText.slice(0, 200) });
            break;
          }
        }
      } catch (_) {
        // セレクタが見つからない場合は次を試す
      }
    }

    // フォールバック: ページ全体のテキストを取得
    if (!rawText || rawText.trim().length === 0) {
      rawText = await page.evaluate(() => document.body.innerText);
      logger.debug('フォールバック: ページ全体テキストを使用');
    }

    // 「お問い合わせ番号が見つかりません」などのエラーページ判定
    if (
      rawText.includes('お問い合わせ番号が見つかりません') ||
      rawText.includes('該当する荷物が見つかりません') ||
      rawText.includes('No data')
    ) {
      logger.warn(`伝票番号 ${trackingNo} が見つかりませんでした`);
      return { rawText: '', status: '伝票不明', isReturn: false };
    }

    const status = classifyStatus(rawText);
    const isReturn = isReturnStatus(status);

    logger.info(`ステータス判定完了: ${trackingNo} → ${status}`, { isReturn });

    return { rawText, status, isReturn };
  } catch (err) {
    logger.error(`ページ取得エラー: ${trackingNo}`, { error: err.message });
    return { rawText: '', status: 'エラー', isReturn: false };
  } finally {
    await page.close();
    await context.close();
  }
}

/**
 * 複数の伝票番号の配送状況を一括取得する
 * @param {Array<{ trackingNo: string }>} rows
 * @returns {Array<{ trackingNo: string, status: string, isReturn: boolean }>}
 */
async function fetchAllStatuses(rows) {
  // ブラウザを1インスタンスだけ起動して使い回す
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Cloud Run のメモリ制限対策
      '--disable-extensions',
    ],
  });

  logger.info(`ブラウザを起動しました。対象件数: ${rows.length}`);

  const results = [];

  try {
    for (const row of rows) {
      try {
        const result = await fetchDeliveryStatus(row.trackingNo, browser);
        results.push({ trackingNo: row.trackingNo, ...result });
      } catch (err) {
        logger.error(`伝票 ${row.trackingNo} の処理中にエラー`, { error: err.message });
        results.push({ trackingNo: row.trackingNo, rawText: '', status: 'エラー', isReturn: false });
      }

      // 連続アクセスによるブロック回避のため少し待機
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    await browser.close();
    logger.info('ブラウザを閉じました');
  }

  return results;
}

module.exports = { fetchAllStatuses, classifyStatus, isReturnStatus };
