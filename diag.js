/**
 * diag.js
 * 「配送会社のサイトに繋がらない」ときに、原因を切り分けるための診断。
 *
 * 2026年10〜11月に、ヤマトのサイトへ Cloud Run から
 * まったく到達できなくなる事象が起きた（page.goto が30秒無応答）。
 * ブラウザからも Cloud Shell からも普通に見えたため原因の特定に時間がかかった。
 * 同じことが起きたときに、すぐ切り分けられるようにするのがこのファイル。
 *
 * 調べること:
 *   1. このサーバーから見える「送信元IPアドレス」
 *   2. ブラウザを使わない素の通信で、配送会社のサイトに繋がるか
 *   3. Playwright（Chromium）で、配送会社のサイトに繋がるか
 *
 * 読み方:
 *   2も3も駄目  → ネットワークの問題。送信元IPが相手に弾かれている可能性が高い
 *   2は通る/3が駄目 → ブラウザが弾かれている、またはページの作りが変わった
 *   2も3も通る  → サイト側は正常。別の原因を探す
 *
 * 使い方: サービスのURLの末尾に /diag を付けて開く
 */

const { launchBrowser, withPage, closeBrowser } = require('./browser');
const logger = require('./logger');
const config = require('./config');

/** 診断でアクセスする先。carriers の各ファイルと同じURLを使うこと */
const TARGETS = [
  { name: 'ヤマト', url: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko' },
  { name: '佐川', url: 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=' },
];

/** 送信元IPを教えてくれるサービス（複数用意して、どれか1つ通ればよい） */
const IP_LOOKUP_URLS = [
  'https://checkip.amazonaws.com',
  'https://api.ipify.org',
];

const FETCH_TIMEOUT_MS = 20000;

function ms(startedAt) {
  return `${Date.now() - startedAt}ミリ秒`;
}

/** 指定ミリ秒で諦める fetch */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // 実際の監視と同じ名乗りにそろえる
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 1. このサーバーから見た送信元IPアドレス */
async function lookupOutboundIp() {
  for (const url of IP_LOOKUP_URLS) {
    try {
      const res = await fetchWithTimeout(url, 10000);
      const text = (await res.text()).trim();
      if (text) return { ok: true, ip: text, 調べた先: url };
    } catch (e) {
      logger.warn(`[診断] 送信元IPを取得できませんでした (${url}): ${e.message}`);
    }
  }
  return { ok: false, ip: null, メモ: '送信元IPを取得できませんでした' };
}

/** 2. ブラウザを使わない素の通信 */
async function checkPlainFetch(target) {
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout(target.url, FETCH_TIMEOUT_MS);
    // 本文は使わないが、最後まで読めるかを確かめる
    const body = await res.text();
    return {
      ok: res.ok,
      HTTPステータス: res.status,
      所要時間: ms(startedAt),
      本文の長さ: body.length,
    };
  } catch (e) {
    return {
      ok: false,
      所要時間: ms(startedAt),
      エラー: e.name === 'AbortError' ? `${FETCH_TIMEOUT_MS}ミリ秒で応答がありませんでした` : e.message,
    };
  }
}

/** 3. Playwright（Chromium）で開く */
async function checkBrowser(browser, target) {
  const startedAt = Date.now();
  try {
    return await withPage(browser, async (page) => {
      const res = await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: FETCH_TIMEOUT_MS,
      });
      const title = await page.title();
      return {
        ok: true,
        HTTPステータス: res ? res.status() : null,
        所要時間: ms(startedAt),
        ページ名: title,
      };
    });
  } catch (e) {
    return { ok: false, 所要時間: ms(startedAt), エラー: e.message };
  }
}

/**
 * 診断をまとめて実行する。
 * シートには一切触らないし、通知も送らない。安全に何度でも叩ける。
 */
async function runDiagnostics() {
  const startedAt = Date.now();
  const 送信元IP = await lookupOutboundIp();

  let browser = null;
  const 配送会社 = {};

  try {
    browser = await launchBrowser();
    for (const target of TARGETS) {
      配送会社[target.name] = {
        URL: target.url,
        ブラウザなしの通信: await checkPlainFetch(target),
        ブラウザでの通信: await checkBrowser(browser, target),
      };
    }
  } catch (e) {
    logger.error(`[診断] ブラウザを起動できませんでした: ${e.message}`);
    for (const target of TARGETS) {
      配送会社[target.name] = {
        URL: target.url,
        ブラウザなしの通信: await checkPlainFetch(target),
        ブラウザでの通信: { ok: false, エラー: `ブラウザを起動できません: ${e.message}` },
      };
    }
  } finally {
    if (browser) {
      try { await closeBrowser(browser); } catch (_) { /* 無視 */ }
    }
  }

  return {
    実行日時: new Date().toISOString(),
    所要時間: ms(startedAt),
    送信元IP,
    配送会社,
    照会を止めている会社: config.PAUSED_CARRIERS.length
      ? config.PAUSED_CARRIERS.join(' / ')
      : 'なし',
    読み方: [
      'ブラウザなし・ブラウザの両方が駄目 → 送信元IPが相手に弾かれている可能性が高い',
      'ブラウザなしは通る／ブラウザが駄目 → ブラウザが弾かれている、またはページの作りが変わった',
      '両方通る → 配送会社のサイトは正常。別の原因を探す',
    ],
  };
}

module.exports = { runDiagnostics, TARGETS };
