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
  // 送信に失敗したら K列 を更新しないので、次回の実行で再通知される。
  let notifyResult = { ok: true, sent: [], failed: [] };
  if (flagged.length > 0) {
    notifyResult = await notifiers.notify(flagged, { isTest });
    if (notifyResult.ok) {
      const levels = new Map(flagged.map((f) => [f.rowIndex, f.flag]));
      for (const u of updates) {
        if (levels.has(u.rowIndex)) u.notified = levels.get(u.rowIndex);
      }
    } else {
      logger.warn('通知を送れませんでした。次回の実行で再通知します', {
        failed: notifyResult.failed,
        count: flagged.length,
      });
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
      : notifyResult.ok
        ? `送信しました（${notifyResult.sent.join(', ')}）`
        : '送信できませんでした（次回再通知）',
    所要秒数: Number(elapsedSec),
  };
  logger.info('====== 監視処理完了 ======', summary);

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

module.exports = { runMonitor, selectTargets };
