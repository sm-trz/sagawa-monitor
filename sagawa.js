/**
 * sagawa-monitor / sagawa.js
 * Playwright で佐川急便の荷物問い合わせページをスクレイピングする
 */

const { chromium } = require('playwright');
const logger = require('./logger');

const STATUS_KEYWORDS = [
  { label: '受取拒否', keywords: ['受取拒否'] },
  { label: '受取辞退', keywords: ['受取辞退'] },
  { label: '返送', keywords: ['返送'] },
  { label: '返品', keywords: ['返品'] },
  { label: '長期不在', keywords: ['長期不在', '長期間不在'] },
  { label: '持戻り', keywords: ['持戻り', '持ち戻り', '不在持戻'] },
  { label: '保管中', keywords: ['保管中', '営業所保管'] },
  { label: '配達完了', keywords: ['配達完了', 'お届け済み', '配達済'] },
  { label: '配達中', keywords: ['配達中', 'お届け中'] },
  { label: '輸送中', keywords: ['輸送中', '幹線輸送中', '配達店到着'] },
  { label: '集荷', keywords: ['集荷'] },
];

const RETURN_STATUSES = new Set([
  '受取拒否',
  '受取辞退',
  '返送',
  '返品',
  '長期不在',
  '持戻り',
]);

function classifyStatus(rawText) {
  if (!rawText) return '不明';

  for (const { label, keywords } of STATUS_KEYWORDS) {
    for (const kw of keywords) {
      if (rawText.includes(kw)) return label;
    }
  }

  return '不明';
}

function isReturnStatus(status) {
  return RETURN_STATUSES.has(status);
}

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',
  '--no-first-run',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--mute-audio',
];

async function launchBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS,
  });

  logger.info('Chromium を起動しました');
  return browser;
}

function isBrowserAlive(browser) {
  try {
    return browser && browser.isConnected();
  } catch (_) {
    return false;
  }
}

async function fetchDeliveryStatus(trackingNo, browser) {
  const url = `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(trackingNo)}`;
  logger.info(`配送状況を取得中: ${trackingNo}`);

  let context = null;
  let page = null;

  try {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });

    page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(5000);

    const rawText = await page.evaluate(() => {
      return document.body ? document.body.innerText : '';
    });

    logger.info(`取得ページ本文 ${trackingNo}: ${rawText.substring(0, 3000)}`);

    if (
      rawText.includes('お問い合わせ番号が見つかりません') ||
      rawText.includes('該当する荷物が見つかりません') ||
      rawText.includes('No data')
    ) {
      logger.warn(`伝票番号 ${trackingNo} が見つかりませんでした`);
      return { status: '伝票不明', isReturn: false };
    }

    const status = classifyStatus(rawText);
    const isReturn = isReturnStatus(status);

    logger.info(`ステータス判定完了: ${trackingNo} → ${status}`, { isReturn });

    return { status, isReturn };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        logger.debug(`page.close() エラー（無視）: ${e.message}`);
      }
    }

    if (context) {
      try {
        await context.close();
      } catch (e) {
        logger.debug(`context.close() エラー（無視）: ${e.message}`);
      }
    }
  }
}

async function fetchAllStatuses(rows) {
  if (!rows || rows.length === 0) return [];

  let browser = await launchBrowser();
  const results = [];

  try {
    for (const row of rows) {
      if (!isBrowserAlive(browser)) {
        logger.warn('ブラウザがクラッシュしています。再起動します');
        try {
          await browser.close();
        } catch (_) {}
        browser = await launchBrowser();
      }

      try {
        const result = await fetchDeliveryStatus(row.trackingNo, browser);
        results.push({
          trackingNo: row.trackingNo,
          ...result,
        });
      } catch (err) {
        logger.error(`伝票 ${row.trackingNo} の処理中にエラー（スキップ）`, {
          error: err.message,
        });

        results.push({
          trackingNo: row.trackingNo,
          status: 'エラー',
          isReturn: false,
        });
      }

      if (row !== rows[rows.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  } finally {
    try {
      await browser.close();
      logger.info('ブラウザを閉じました');
    } catch (e) {
      logger.warn(`browser.close() エラー（無視）: ${e.message}`);
    }
  }

  return results;
}

module.exports = {
  fetchAllStatuses,
  classifyStatus,
  isReturnStatus,
};
