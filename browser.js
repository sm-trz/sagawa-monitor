/**
 * browser.js
 * Playwright（Chromium）の起動・終了をまとめた共通部品。
 * 配送会社ごとのファイルから使い回します。
 */

const { chromium } = require('playwright');
const logger = require('./logger');

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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function launchBrowser() {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  logger.info('Chromium を起動しました');
  return browser;
}

function isAlive(browser) {
  try {
    return Boolean(browser) && browser.isConnected();
  } catch (_) {
    return false;
  }
}

/**
 * 1ページ分の処理を、使い捨てのブラウザコンテキストで実行する。
 * 前のページの Cookie などを引きずらないようにするため毎回作り直します。
 */
async function withPage(browser, fn) {
  let context = null;
  let page = null;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();
    return await fn(page);
  } finally {
    if (page) {
      try { await page.close(); } catch (_) { /* 無視 */ }
    }
    if (context) {
      try { await context.close(); } catch (_) { /* 無視 */ }
    }
  }
}

async function closeBrowser(browser) {
  try {
    await browser.close();
    logger.info('Chromium を終了しました');
  } catch (e) {
    logger.warn(`Chromium の終了に失敗（無視します）: ${e.message}`);
  }
}

module.exports = { launchBrowser, closeBrowser, isAlive, withPage };
