/**
 * notifiers/index.js
 * 検知した内容を通知する。
 *
 * 将来 Slack やメールに変えるときは、このフォルダに1ファイル追加して
 * NOTIFIERS の配列に足すだけで済みます。判定ロジックには触りません。
 */

const chatwork = require('./chatwork');
const logger = require('../logger');
const config = require('../config');

const NOTIFIERS = [chatwork];

function sheetUrl() {
  return config.SPREADSHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${config.SPREADSHEET_ID}/edit`
    : '';
}

/**
 * カート管理画面へのリンク。
 * 注文番号が数字だけのときにだけ作る（それ以外はリンクを出さない）。
 */
function cartUrl(orderNo) {
  const no = String(orderNo || '').trim();
  if (!/^\d+$/.test(no)) return '';
  return config.CART_URL_PREFIX + no;
}

/** 「あと3日」「期限を過ぎています」などの一言 */
function deadlineLine(item) {
  if (!item.deadline) return '';
  const { date, daysLeft } = item.deadline;
  if (daysLeft < 0) return `⚠ 返送予定日 ${date} を過ぎています`;
  if (daysLeft === 0) return `⚠ 返送予定: ${date}（本日）`;
  return `⚠ 返送予定: ${date}（あと${daysLeft}日）`;
}

/** 1件分の本文 */
function buildItem(item) {
  const lines = [];
  lines.push(`注文番号: ${item.orderNo || '(未入力)'}`);
  if (item.name) lines.push(`お名前　: ${item.name} 様`);
  if (item.address) lines.push(`ご住所　: ${item.address}`);
  if (item.tel) lines.push(`お電話　: ${item.tel}`);
  lines.push(`配送　　: ${item.carrier} / ${item.trackingNo}`);
  if (item.shipDate) lines.push(`発送日時: ${item.shipDate}`);
  if (item.heldAt) lines.push(`持戻り　: ${item.heldAt}`);
  if (item.returnedAt) lines.push(`返品日時: ${item.returnedAt}`);
  lines.push(`状況　　: ${item.status}`);

  const dl = deadlineLine(item);
  if (dl) lines.push(dl);

  lines.push('');
  if (item.flag === '返品確定') {
    lines.push('▼お願いすること');
    lines.push('お客様へご連絡のうえ、返品理由を確認して返品処理へ進めてください。');
  } else {
    lines.push('▼お願いすること');
    lines.push('お客様へご連絡し、受け取り状況と再配達のご希望を確認してください。');
    if (item.office || item.officeTel) {
      const office = [item.office, item.officeTel && `TEL:${item.officeTel}`]
        .filter(Boolean)
        .join('  ');
      lines.push(`再配達の案内先: ${office}`);
    }
  }

  const cart = cartUrl(item.orderNo);
  if (cart) lines.push(`カート: ${cart}`);
  lines.push(`シート ${item.rowIndex} 行目`);

  return lines.join('\n');
}

/**
 * 通知メッセージを組み立てる。
 * 「返品確定」を先に、「要調査」を後に並べる。
 */
function buildMessage(items, { isTest = false } = {}) {
  const returned = items.filter((i) => i.flag === '返品確定');
  const investigate = items.filter((i) => i.flag !== '返品確定');

  const title =
    returned.length > 0 && investigate.length > 0
      ? `返品確定 ${returned.length}件 / 要確認 ${investigate.length}件`
      : returned.length > 0
        ? `【返品確定】返品処理をお願いします（${returned.length}件）`
        : `【要確認】お客様へのご連絡をお願いします（${investigate.length}件）`;

  const lines = [];
  lines.push('[info]');
  lines.push(`[title]${isTest ? '【テスト】' : ''}${title}[/title]`);

  const section = (heading, list) => {
    if (list.length === 0) return;
    if (returned.length > 0 && investigate.length > 0) {
      lines.push(`■ ${heading}（${list.length}件）`);
    }
    for (const item of list) {
      lines.push(buildItem(item));
      lines.push('[hr]');
    }
  };

  section('返品確定', returned);
  section('要確認', investigate);

  const url = sheetUrl();
  if (url) lines.push(url);
  lines.push('[/info]');

  return lines.join('\n');
}

/**
 * 検知結果を通知する。
 * @param {Array} items
 * @param {{isTest?:boolean}} options
 */
async function notify(items, { isTest = false } = {}) {
  const result = { ok: false, sent: [], failed: [], isTest };

  if (!items || items.length === 0) return { ...result, ok: true };

  if (!config.NOTIFY) {
    logger.info('通知は設定で無効になっています（NOTIFY=off）');
    return result;
  }

  const active = NOTIFIERS.filter((n) => n.isConfigured({ isTest }));
  if (active.length === 0) {
    logger.warn('通知先が設定されていません。シートへの記録のみ行います', { isTest });
    return result;
  }

  const message = buildMessage(items, { isTest });

  for (const notifier of active) {
    try {
      const r = await notifier.send(message, { isTest });
      if (r.ok) result.sent.push(notifier.NAME);
      else result.failed.push(notifier.NAME);
    } catch (err) {
      logger.error(`[${notifier.NAME}] 通知中に予期しないエラー`, { error: err.message });
      result.failed.push(notifier.NAME);
    }
  }

  result.ok = result.sent.length > 0;
  return result;
}

/** 設定確認用。シートには一切触らず、テストルームへ1通だけ送る */
async function sendTestMessage() {
  const sample = [{
    rowIndex: 0,
    orderNo: '99999',
    name: 'テスト 太郎',
    address: '東京都千代田区1-1-1',
    tel: '03-0000-0000',
    carrier: '佐川',
    trackingNo: '000000000000',
    shipDate: '2026/08/20',
    heldAt: '2026/08/22 10:00',
    status: '持戻り',
    flag: '要調査',
    office: '○○営業所',
    officeTel: '0570-00-0000',
    deadline: { date: '2026/08/30', daysLeft: 5 },
  }];

  const message =
    '[info][title]【テスト】通知設定の確認[/title]\n' +
    'この通知が届いていれば、Chatworkの設定は正しく動いています。\n' +
    'スプレッドシートには一切書き込んでいません。\n[hr]' +
    buildItem(sample[0]) +
    '\n[/info]';

  return chatwork.send(message, { isTest: true });
}

module.exports = { notify, buildMessage, buildItem, cartUrl, sheetUrl, sendTestMessage };
