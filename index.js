/**
 * index.js
 * Cloud Run のエントリーポイント。
 *
 *   GET  /        → 何もしない。設定内容を表示するだけ（安全のため）
 *   GET  /run     → 監視を実行（ブラウザからのテスト用）
 *   POST /run     → 監視を実行（Cloud Scheduler 用）
 *   GET  /health  → 生存確認
 *
 * 監視処理はレスポンスを返す前に await して完了させます。
 * Cloud Run はレスポンス送信後に CPU を止めるため、
 * バックグラウンド実行にすると処理が途中で凍結するからです。
 */

require('dotenv').config();

const http = require('http');
const { runMonitor } = require('./monitor');
const notifiers = require('./notifiers');
const logger = require('./logger');
const config = require('./config');

const PORT = process.env.PORT || 8080;

// 同時に2つ走らないようにする（配送会社サイトへの二重アクセス防止）
let running = false;

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer(async (req, res) => {
  let path = '/';
  let token = null;
  let mode = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    path = url.pathname;
    token = url.searchParams.get('token');
    mode = url.searchParams.get('mode');
  } catch (_) {
    return sendJson(res, 400, { status: 'error', message: 'リクエストを解釈できません' });
  }

  if (path === '/health') {
    return sendJson(res, 200, { status: 'ok', time: new Date().toISOString() });
  }

  // トップページでは実行しない。Bot や favicon のアクセスで
  // 勝手に監視が走るのを防ぐためです。
  if (path === '/') {
    return sendJson(res, 200, {
      service: 'sagawa-monitor',
      message: 'このURLでは監視は実行されません。実行するには末尾に /run を付けてください。',
      endpoints: {
        run: 'GET /run （ブラウザ用） / POST /run （Cloud Scheduler 用）→ 本番ルームへ通知',
        runTest: 'GET /run?mode=test → テストルームへ通知',
        testNotify: 'GET /test-notify → シートを触らずテスト通知だけ送る',
        health: 'GET /health',
      },
      settings: {
        'シート名': config.SHEET_NAME,
        '監視を打ち切る日数': config.MAX_MONITOR_DAYS,
        '1回の最大照会件数': config.MAX_PER_RUN,
        '照会間隔ミリ秒': config.REQUEST_INTERVAL_MS,
        'ヤマトの文言判定': config.YAMATO_STATUS_JUDGE ? 'on' : 'off',
        '保管日数（佐川/ヤマト）': `${config.SAGAWA_HOLD_DAYS} / ${config.YAMATO_HOLD_DAYS}`,
        '通知': config.NOTIFY ? 'on' : 'off',
        '本番ルーム設定済み': Boolean(config.CHATWORK_ROOM_ID),
        'テストルーム設定済み': Boolean(config.CHATWORK_ROOM_ID_TEST),
        'ページ本文のログ出力': config.DUMP_PAGE_TEXT ? 'on' : 'off',
      },
      running,
    });
  }

  // 設定確認用。シートには一切触らず、テストルームへ1通だけ送る。
  if (path === '/test-notify') {
    try {
      const r = await notifiers.sendTestMessage();
      return sendJson(res, r.ok ? 200 : 500, {
        status: r.ok ? 'ok' : 'error',
        message: r.ok
          ? 'テストルームへ通知を送信しました。Chatworkを確認してください。'
          : 'send に失敗しました。ログで [Chatwork] を検索してください。',
        detail: r,
      });
    } catch (err) {
      logger.error('テスト通知に失敗しました', { error: err.message });
      return sendJson(res, 500, { status: 'error', message: err.message });
    }
  }

  if (path === '/run') {
    if (config.RUN_TOKEN && token !== config.RUN_TOKEN) {
      return sendJson(res, 403, { status: 'forbidden', message: 'token が正しくありません' });
    }
    if (running) {
      return sendJson(res, 409, {
        status: 'busy',
        message: '前回の監視処理がまだ実行中です。終わるまでお待ちください。',
      });
    }

    running = true;
    const isTest = mode === 'test';
    try {
      const result = await runMonitor({ isTest });
      return sendJson(res, 200, { status: 'ok', result });
    } catch (err) {
      logger.error('監視処理でエラーが発生しました', {
        error: err.message,
        stack: err.stack,
      });
      return sendJson(res, 500, { status: 'error', message: err.message });
    } finally {
      running = false;
    }
  }

  return sendJson(res, 404, { status: 'error', message: 'ページが見つかりません' });
});

server.listen(PORT, () => {
  logger.info(`サーバーを起動しました: port=${PORT}`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM を受信しました。サーバーを停止します');
  server.close(() => process.exit(0));
});
