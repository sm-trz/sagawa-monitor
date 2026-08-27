/**
 * notifiers/index.js
 * 検知した内容を通知する。
 *
 * ── 通知の形 ─────────────────────────────────────────────────
 * 1件につき1つの Chatwork タスクを作ります。件数が多くても
 * まとめません。担当者が1件ずつ処理して完了できるようにするためです。
 *
 * 持ち帰りの場合は、返送予定日をタスクの期限に設定します。
 *
 * 将来 Slack やメールに変えるときは、このフォルダに1ファイル追加して
 * NOTIFIERS の配列に足すだけで済みます。判定ロジックには触りません。
 */

const chatwork = require('./chatwork');
const logger = require('../logger');
const config = require('../config');

const NOTIFIERS = [chatwork];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * 配送会社のページへのリンク。
 *   佐川   … URLを直接開けば配送状況が表示される（実データで確認済み）
 *   ヤマト … 追跡ページは直接開いても結果が出ないため、
 *            「受け取り日時・場所の変更」ページを案内する
 */
function trackingLink(carrier, trackingNo) {
  const no = String(trackingNo || '').replace(/[^0-9]/g, '');
  if (!no) return null;
  if (carrier === 'ヤマト') {
    return { label: '日時変更', url: config.YAMATO_TRACK_URL_PREFIX + no };
  }
  if (carrier === '佐川') {
    return { label: '配送状況', url: config.SAGAWA_TRACK_URL_PREFIX + no };
  }
  return null;
}

/** 「あと3日」「期限を過ぎています」などの一言 */
function deadlineLine(item) {
  if (!item.deadline) return '';
  const { date, daysLeft } = item.deadline;
  if (daysLeft < 0) return `⚠ 返送予定日 ${date} を過ぎています`;
  if (daysLeft === 0) return `⚠ 返送予定: ${date}（本日）`;
  return `⚠ 返送予定: ${date}（あと${daysLeft}日）`;
}

/** タスク／メッセージの1行目 */
function titleOf(item, { isTest = false } = {}) {
  const head = item.flag === '返品確定'
    ? '【返品確定】返品処理をお願いします'
    : '【要確認】お客様へのご連絡をお願いします';
  return `${isTest ? '【テスト】' : ''}${head}`;
}

/** 1件分の本文 */
function buildItem(item, { isTest = false, withTitle = false } = {}) {
  const lines = [];
  if (withTitle) lines.push(titleOf(item, { isTest }));

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
  lines.push('▼お願いすること');
  if (item.flag === '返品確定') {
    lines.push('お客様へご連絡のうえ、返品理由を確認して返品処理へ進めてください。');
  } else {
    lines.push('お客様へご連絡し、受け取り状況と再配達のご希望を確認してください。');
    if (item.office || item.officeTel) {
      const office = [item.office, item.officeTel && `TEL:${item.officeTel}`]
        .filter(Boolean)
        .join('  ');
      lines.push(`再配達の案内先: ${office}`);
    }
  }

  const cart = cartUrl(item.orderNo);
  if (cart) lines.push(`カート　: ${cart}`);
  const track = trackingLink(item.carrier, item.trackingNo);
  if (track) lines.push(`${track.label}: ${track.url}`);
  lines.push(`シート ${item.rowIndex} 行目`);

  const url = sheetUrl();
  if (url) lines.push(url);

  return lines.join('\n');
}

/**
 * 検知結果を1件ずつ通知する。
 *
 * @param {Array} items
 * @param {{isTest?:boolean}} options
 * @returns {Promise<{ok:boolean, succeeded:Set<number>, failed:number[], sentCount:number}>}
 *          succeeded には通知できた行番号が入る。
 *          失敗した行は「通知済」を更新しないので、次回の実行で再通知される。
 */
async function notify(items, { isTest = false } = {}) {
  const result = { ok: false, succeeded: new Set(), failed: [], sentCount: 0, mode: config.CHATWORK_NOTIFY_MODE };

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

  chatwork.resetCache();
  const asTask = config.CHATWORK_NOTIFY_MODE !== 'message';

  logger.info(`通知を開始します（1件ずつ${asTask ? 'タスク' : 'メッセージ'}を作成）`, {
    件数: items.length,
    送信先: isTest ? 'テスト' : '本番',
  });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const body = buildItem(item, { isTest, withTitle: true });
    // 持ち帰りの返送予定日をタスクの期限にする
    const limitDate = item.deadline ? item.deadline.date : '';

    let sentAny = false;
    for (const notifier of active) {
      try {
        const r = asTask
          ? await notifier.createTask(body, { isTest, limitDate })
          : await notifier.send(body, { isTest });
        if (r.ok) sentAny = true;
      } catch (err) {
        logger.error(`[${notifier.NAME}] 通知中に予期しないエラー`, {
          error: err.message,
          rowIndex: item.rowIndex,
        });
      }
    }

    if (sentAny) {
      result.succeeded.add(item.rowIndex);
      result.sentCount++;
    } else {
      result.failed.push(item.rowIndex);
    }

    // 連続で叩かないよう少し間を空ける（Chatworkの回数制限対策）
    if (i < items.length - 1) await sleep(config.CHATWORK_INTERVAL_MS);
  }

  result.ok = result.sentCount > 0;

  if (result.failed.length > 0) {
    logger.warn('一部の通知に失敗しました。失敗した行は次回の実行で再通知します', {
      成功: result.sentCount,
      失敗: result.failed.length,
      失敗した行: result.failed,
    });
  } else {
    logger.info('通知が完了しました', { 件数: result.sentCount });
  }

  return result;
}

/** 設定確認用。シートには一切触らず、テストルームへ1件だけ送る */
async function sendTestMessage() {
  const sample = {
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
  };

  const body =
    '【テスト】通知設定の確認\n' +
    'このタスクが作られていれば、Chatworkの設定は正しく動いています。\n' +
    'スプレッドシートには一切書き込んでいません。\n\n' +
    buildItem(sample, { isTest: false, withTitle: false });

  chatwork.resetCache();
  if (config.CHATWORK_NOTIFY_MODE === 'message') {
    return chatwork.send(body, { isTest: true });
  }
  return chatwork.createTask(body, { isTest: true, limitDate: sample.deadline.date });
}

// ── 運用ルームへの通知（システムエラー・日次サマリ） ─────────
// 業務委託者グループには流さない。タスクではなく通常メッセージで送る。

function nowJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

async function sendToAlertRoom(body) {
  const room = chatwork.alertRoomId();
  if (!config.CHATWORK_API_TOKEN || !room) {
    logger.warn('運用ルームが未設定のため、システム通知を送れません', {
      対処: '環境変数 CHATWORK_ROOM_ID_ALERT にルームIDを設定してください',
    });
    return { ok: false, skipped: true };
  }
  return chatwork.send(body, { room });
}

/**
 * システム異常を運用ルームへ即時通知する。
 * @param {{title:string, detail:string, hint?:string, isTest?:boolean}} info
 */
async function notifyError({ title, detail, hint = '', isTest = false }) {
  const lines = [];
  lines.push('[info]');
  lines.push(`[title]${isTest ? '【テスト】' : ''}【システム異常】配送監視[/title]`);
  lines.push(`発生: ${nowJST()}`);
  lines.push(`内容: ${title}`);
  if (detail) lines.push(`詳細: ${String(detail).substring(0, 800)}`);
  if (hint) lines.push(`対処: ${hint}`);
  lines.push('');
  lines.push('ログ: Cloud Run → オブザーバビリティ → ログ');
  lines.push('[/info]');

  const res = await sendToAlertRoom(lines.join('\n'));
  if (res.ok) logger.info('運用ルームへシステム異常を通知しました', { title });
  return res;
}

/**
 * 日次サマリを運用ルームへ送る。異常が1つも無い日は送らない。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string}>}
 */
async function notifyDailySummary(summary) {
  const problems = [];
  if (summary.取得失敗 > 0) problems.push(`取得失敗 ${summary.取得失敗}件`);
  if (summary.通知失敗 > 0) problems.push(`通知失敗 ${summary.通知失敗}件`);
  if (summary.次回にまわした件数 > 0) problems.push(`未処理 ${summary.次回にまわした件数}件`);
  if (summary.未知のステータス.length > 0) {
    problems.push(`未知のステータス ${summary.未知のステータス.length}種`);
  }

  if (problems.length === 0) {
    logger.info('日次サマリ: 異常がないため送信しません');
    return { ok: true, skipped: true, reason: '異常なし' };
  }

  const lines = [];
  lines.push('[info]');
  lines.push(`[title]${summary.isTest ? '【テスト】' : ''}【日次サマリ】${summary.日付}[/title]`);
  lines.push(`確認した伝票: ${summary.照会した件数}件`);
  lines.push(`検知: 返品確定 ${summary.返品確定}件 / 要調査 ${summary.要調査}件`);
  lines.push('');
  lines.push('▼気になる点');
  for (const p of problems) lines.push(`・${p}`);
  if (summary.未知のステータス.length > 0) {
    lines.push(`　→ ${summary.未知のステータス.join(' / ')}`);
  }
  lines.push('');
  lines.push(sheetUrl());
  lines.push('[/info]');

  const res = await sendToAlertRoom(lines.join('\n'));
  if (res.ok) logger.info('日次サマリを送信しました', { problems });
  return res;
}

module.exports = {
  notify,
  notifyError,
  notifyDailySummary,
  buildItem,
  titleOf,
  cartUrl,
  trackingLink,
  sheetUrl,
  sendTestMessage,
};
