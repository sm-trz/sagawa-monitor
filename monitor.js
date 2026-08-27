/**
 * monitor.js
 * 監視処理の全体の流れ。
 *
 *   シート読み取り
 *     → 照会が必要な行だけに絞り込み
 *     → 配送会社ごとにページを取得（ヤマトは10件まとめて）
 *     → 返品候補かどうかを判定
 *     → 通知（送信できたときだけ通知済にする）
 *     → シートへまとめて書き戻し
 */

const config = require('./config');
const logger = require('./logger');
const sheets = require('./sheets');
const judgeModule = require('./judge');
const notifiers = require('./notifiers');
const { launchBrowser, closeBrowser, isAlive } = require('./browser');
const { normalizeCarrierName, getCarrier, supportedNames } = require('./carriers');

const {
  judge,
  isTooOld,
  shouldNotify,
  FINISHED_STATUSES,
  FLAG_NONE,
  FLAG_RETURNED,
} = judgeModule;

function nowJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 照会が必要な行だけを選ぶ。
 * 「配達完了は監視終了」「返品確定は監視終了」「古すぎるものは打ち切り」の実装。
 */
function selectTargets(rows) {
  const targets = [];
  const skipped = { finished: 0, returned: 0, tooOld: 0, noCarrier: 0 };
  const carrierErrors = [];

  for (const row of rows) {
    if (FINISHED_STATUSES.has(row.status)) { skipped.finished++; continue; }
    if (row.flag === FLAG_RETURNED) { skipped.returned++; continue; }
    if (isTooOld(row.shipDate)) { skipped.tooOld++; continue; }

    const carrierName = normalizeCarrierName(row.carrierRaw);
    if (!carrierName) {
      skipped.noCarrier++;
      carrierErrors.push({
        rowIndex: row.rowIndex,
        writeShipDate: false,
        shipDate: row.shipDate,
        status: '配送会社が未指定',
        checkedAt: nowJST(),
        flag: FLAG_NONE,
        notified: row.notified,
        deliveredAt: row.deliveredAt,
        returnedAt: row.returnedAt,
        note: `B列に ${supportedNames().join(' または ')} と入力してください`,
      });
      continue;
    }
    targets.push({ ...row, carrierName });
  }

  return { targets, skipped, carrierErrors };
}

async function fetchAll(limited) {
  const resultsByRow = new Map();
  const counts = { success: 0, error: 0 };
  if (limited.length === 0) return { resultsByRow, counts };

  // 配送会社ごとにまとめる（ヤマトは1回の検索で最大10件を照会できる）
  const groups = new Map();
  for (const row of limited) {
    if (!groups.has(row.carrierName)) groups.set(row.carrierName, []);
    groups.get(row.carrierName).push(row);
  }

  let browser = await launchBrowser();
  try {
    for (const [carrierName, carrierRows] of groups) {
      const carrier = getCarrier(carrierName);
      const canBatch = carrier.BATCH_SIZE > 1 && typeof carrier.fetchStatusBatch === 'function';
      const chunkSize = canBatch ? carrier.BATCH_SIZE : 1;

      logger.info(`[${carrierName}] ${carrierRows.length} 件を照会します`, {
        まとめ照会: canBatch ? `${chunkSize}件ずつ` : 'なし（1件ずつ）',
      });

      for (let i = 0; i < carrierRows.length; i += chunkSize) {
        const chunk = carrierRows.slice(i, i + chunkSize);

        if (!isAlive(browser)) {
          logger.warn('Chromium が落ちていたため再起動します');
          try { await closeBrowser(browser); } catch (_) { /* 無視 */ }
          browser = await launchBrowser();
        }

        let map;
        try {
          if (canBatch) {
            map = await carrier.fetchStatusBatch(browser, chunk.map((r) => r.trackingNo));
          } else {
            const one = await carrier.fetchStatus(browser, chunk[0].trackingNo);
            map = new Map([[chunk[0].trackingNo, one]]);
          }
        } catch (err) {
          logger.error(`[${carrierName}] 照会に失敗しました`, {
            error: err.message,
            trackingNos: chunk.map((r) => r.trackingNo),
          });
          map = new Map();
        }

        for (const row of chunk) {
          const result = map.get(row.trackingNo);
          if (result && result.status !== '取得失敗') counts.success++;
          else counts.error++;
          resultsByRow.set(
            row.rowIndex,
            result || { status: '取得失敗', detail: '結果が返りませんでした', history: [] }
          );
        }

        if (i + chunkSize < carrierRows.length) await sleep(config.REQUEST_INTERVAL_MS);
      }
    }
  } finally {
    await closeBrowser(browser);
  }

  return { resultsByRow, counts };
}

/**
 * @param {{isTest?:boolean}} options isTest=true ならテストルームへ通知する
 */
async function runMonitor({ isTest = false } = {}) {
  const startedAt = Date.now();
  logger.info('====== 監視処理開始 ======', {
    モード: isTest ? 'テスト' : '本番',
    保管日数_佐川: config.SAGAWA_HOLD_DAYS,
    保管日数_ヤマト: config.YAMATO_HOLD_DAYS,
    監視打ち切り日数: config.MAX_MONITOR_DAYS,
    一回の上限件数: config.MAX_PER_RUN,
  });

  // ── 1. シートを読む ──────────────────────────────────────
  await sheets.checkHeader();
  const rows = await sheets.fetchRows();

  const { targets, skipped, carrierErrors } = selectTargets(rows);
  const limited = targets.slice(0, config.MAX_PER_RUN);
  if (targets.length > limited.length) {
    logger.warn(
      `照会対象が上限を超えたため ${targets.length - limited.length} 件を次回にまわします`,
      { maxPerRun: config.MAX_PER_RUN }
    );
  }

  logger.info('照会対象を絞り込みました', {
    シート内の伝票: rows.length,
    照会対象: limited.length,
    配達完了で除外: skipped.finished,
    返品確定で除外: skipped.returned,
    期限切れで除外: skipped.tooOld,
    配送会社未指定: skipped.noCarrier,
  });

  // ── 2. 配送会社サイトを照会 ──────────────────────────────
  const { resultsByRow, counts } = await fetchAll(limited);

  // ── 3. 判定 ──────────────────────────────────────────────
  const checkedAt = nowJST();
  const updates = [...carrierErrors];
  const flagged = [];
  const unknownStatuses = [];

  for (const row of limited) {
    const result =
      resultsByRow.get(row.rowIndex) ||
      { status: '取得失敗', detail: '照会されませんでした', history: [] };

    // 発送日時: 人の入力を優先。空なら配送会社から取れた集荷日を使う。
    const pickupDate = result.shipDate || '';
    const shipDate = row.shipDate || pickupDate;

    const trustStatus = row.carrierName !== 'ヤマト' || config.YAMATO_STATUS_JUDGE;

    const verdict = judge({
      status: result.status,
      history: result.history || [],
      attemptedDelivery: Boolean(result.attemptedDelivery),
      heldAt: result.heldAt || '',
      shipDate,
      carrierName: row.carrierName,
      trustStatus,
    });

    const noteParts = [];
    if (result.detail) noteParts.push(result.detail);
    if (verdict.notes.length) noteParts.push(...verdict.notes);
    if (result.status === '調査中' && !result.returnedAt) {
      noteParts.push('履歴が消えているため返品日時は取得できません');
    }

    const displayStatus = verdict.effectiveStatus || result.status;
    const note = noteParts.join(' / ').substring(0, 480);

    // 配送会社が新しい表記を使い始めたら、あとから気づけるよう集めておく
    for (const n of verdict.notes) {
      const m = n.match(/未知のステータス「(.+?)」/);
      if (m && !unknownStatuses.includes(m[1])) unknownStatuses.push(m[1]);
    }

    updates.push({
      rowIndex: row.rowIndex,
      writeShipDate: !row.shipDate && Boolean(pickupDate),
      shipDate,
      status: displayStatus,
      checkedAt,
      flag: verdict.flag,
      notified: row.notified, // 通知が成功したあとで書き換える
      deliveredAt: result.deliveredAt || row.deliveredAt || '',
      returnedAt: result.returnedAt || result.heldAt || row.returnedAt || '',
      note,
    });

    if (shouldNotify(verdict.flag, row.notified)) {
      flagged.push({
        rowIndex: row.rowIndex,
        orderNo: row.orderNo,
        name: row.name,
        address: row.address,
        tel: row.tel,
        carrier: row.carrierName,
        trackingNo: row.trackingNo,
        shipDate,
        heldAt: result.heldAt || '',
        returnedAt: result.returnedAt || '',
        status: displayStatus,
        flag: verdict.flag,
        deadline: verdict.deadline,
        office: result.office || '',
        officeTel: result.officeTel || '',
        note,
      });
    }
  }

  // ── 4. 通知（シートへ書く前に送る） ──────────────────────
  // 1件につき1つのタスクを作る。
  // 送信できた行だけ K列 を更新するので、失敗した行は次回に再通知される。
  let notifyResult = { ok: true, succeeded: new Set(), failed: [], sentCount: 0 };
  if (flagged.length > 0) {
    notifyResult = await notifiers.notify(flagged, { isTest });

    const levels = new Map(flagged.map((f) => [f.rowIndex, f.flag]));
    for (const u of updates) {
      if (notifyResult.succeeded.has(u.rowIndex)) {
        u.notified = levels.get(u.rowIndex);
      }
    }
  }

  // ── 5. シートへまとめて書き戻し ──────────────────────────
  await sheets.writeRows(updates);

  // ── 6. まとめ ────────────────────────────────────────────
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = {
    モード: isTest ? 'テスト' : '本番',
    シート内の伝票: rows.length,
    照会した件数: limited.length,
    成功: counts.success,
    失敗: counts.error,
    新たに検知: flagged.length,
    配達完了で除外: skipped.finished,
    返品確定で除外: skipped.returned,
    期限切れで除外: skipped.tooOld,
    配送会社未指定: skipped.noCarrier,
    通知: flagged.length === 0
      ? '対象なし'
      : `${notifyResult.sentCount}件成功 / ${notifyResult.failed.length}件失敗`,
    所要秒数: Number(elapsedSec),
  };
  logger.info('====== 監視処理完了 ======', summary);

  // ── 7. 異常の通知（運用ルームへ） ────────────────────────
  await reportProblems({
    isTest,
    照会した件数: limited.length,
    取得失敗: counts.error,
    通知失敗: notifyResult.failed.length,
    次回にまわした件数: Math.max(0, targets.length - limited.length),
    未知のステータス: unknownStatuses,
    返品確定: flagged.filter((f) => f.flag === FLAG_RETURNED).length,
    要調査: flagged.filter((f) => f.flag !== FLAG_RETURNED).length,
  });

  if (flagged.length > 0) {
    logger.warn('★検知しました★', {
      items: flagged.map((f) => ({
        rowIndex: f.rowIndex,
        orderNo: f.orderNo,
        carrier: f.carrier,
        trackingNo: f.trackingNo,
        status: f.status,
        flag: f.flag,
      })),
    });
  }

  return { ...summary, detected: flagged.map((f) => ({
    rowIndex: f.rowIndex,
    orderNo: f.orderNo,
    carrier: f.carrier,
    trackingNo: f.trackingNo,
    status: f.status,
    flag: f.flag,
    note: f.note,
  })) };
}

/**
 * 異常があれば運用ルームへ知らせる。
 *
 *   即時通知 … 取得失敗が多い / 通知に失敗した
 *   日次サマリ … 決まった時刻の実行のあと、気になる点があれば1通
 */
async function reportProblems(stats) {
  const { 照会した件数: checked, 取得失敗: failed, 通知失敗: notifyFailed } = stats;

  // ① 取得失敗が多い → 即時通知
  const ratio = checked > 0 ? failed / checked : 0;
  const tooManyFailures =
    failed >= config.ERROR_ALERT_MIN_COUNT || (checked > 0 && ratio >= config.ERROR_ALERT_MIN_RATIO);

  if (tooManyFailures) {
    await notifiers.notifyError({
      isTest: stats.isTest,
      title: `配送状況を取得できない伝票が ${failed} 件あります`,
      detail: `照会 ${checked} 件中 ${failed} 件が失敗（${Math.round(ratio * 100)}%）`,
      hint: 'ログで「ページ本文」を検索し、配送会社のページ構造が変わっていないか確認してください',
    }).catch((e) => logger.error('異常通知に失敗しました', { error: e.message }));
  }

  // ② 通知そのものが失敗した → 即時通知
  if (notifyFailed > 0) {
    await notifiers.notifyError({
      isTest: stats.isTest,
      title: `Chatworkへの通知が ${notifyFailed} 件失敗しました`,
      detail: '該当の行は「通知済」を更新していないため、次回の実行で再通知されます',
      hint: 'ログで [Chatwork] を検索してください（401=トークン / 404=ルームID / 403=権限）',
    }).catch((e) => logger.error('異常通知に失敗しました', { error: e.message }));
  }

  // ③ 日次サマリ（決まった時刻の実行のあとだけ）
  const hourJST = Number(
    new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false })
      .replace(/[^0-9]/g, '')
  );
  if (hourJST === config.DAILY_SUMMARY_HOUR) {
    const 日付 = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    await notifiers.notifyDailySummary({ ...stats, 日付 })
      .catch((e) => logger.error('日次サマリの送信に失敗しました', { error: e.message }));
  }
}

/**
 * 実行全体を見張る。途中で落ちたら運用ルームへ知らせてから投げ直す。
 */
async function runMonitorGuarded(options = {}) {
  try {
    return await runMonitor(options);
  } catch (err) {
    logger.error('監視処理が異常終了しました', { error: err.message, stack: err.stack });

    const hint = /permission|PERMISSION/i.test(err.message)
      ? 'サービスアカウントがスプレッドシートに編集者として共有されているか確認してください'
      : /Unable to parse range|範囲/i.test(err.message)
        ? 'シート名（返品管理）と列の構成を確認してください'
        : 'ログで「監視処理が異常終了」を検索し、前後の行を確認してください';

    await notifiers.notifyError({
      isTest: options.isTest,
      title: '監視処理が最後まで実行できませんでした',
      detail: err.message,
      hint,
    }).catch((e) => logger.error('異常通知に失敗しました', { error: e.message }));

    throw err;
  }
}

module.exports = { runMonitor: runMonitorGuarded, runMonitorInner: runMonitor, selectTargets };
