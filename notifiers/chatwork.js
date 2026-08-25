/**
 * notifiers/chatwork.js
 * Chatwork の指定ルームへメッセージを送る。
 *
 * 公式API:
 *   POST https://api.chatwork.com/v2/rooms/{room_id}/messages
 *   ヘッダー   X-ChatWorkToken: （APIトークン）
 *   Content-Type: application/x-www-form-urlencoded
 *   本文       body（1〜65535文字）
 *   制限       回数制限あり。超えると 429 が返る
 *
 * APIトークンの取得:
 *   Chatwork右上のプロフィール画像 → 「API設定」 → パスワード認証 → 表示される
 *
 * 参考: https://developer.chatwork.com/reference/post-rooms-room_id-messages
 */

const logger = require('../logger');
const config = require('../config');

const NAME = 'Chatwork';
const API_BASE = 'https://api.chatwork.com/v2';

/** Chatwork の本文上限。余裕をみて少し手前で切る */
const MAX_BODY = 60000;

/** テストか本番かで送信先ルームを選ぶ */
function roomId({ isTest = false } = {}) {
  if (isTest) {
    // テスト用が未設定なら本番へは送らない（誤爆防止）
    return config.CHATWORK_ROOM_ID_TEST || '';
  }
  return config.CHATWORK_ROOM_ID || '';
}

function isConfigured({ isTest = false } = {}) {
  return Boolean(config.CHATWORK_API_TOKEN && roomId({ isTest }));
}

/**
 * メッセージを送信する。429（回数制限）のときだけ待って再試行する。
 */
async function send(body, { isTest = false } = {}) {
  const room = roomId({ isTest });
  if (!config.CHATWORK_API_TOKEN || !room) {
    logger.warn('[Chatwork] トークンまたはルームIDが未設定のため送信しません', {
      isTest,
      hasToken: Boolean(config.CHATWORK_API_TOKEN),
      hasRoom: Boolean(room),
    });
    return { ok: false, skipped: true };
  }

  const url = `${API_BASE}/rooms/${encodeURIComponent(room)}/messages`;
  const text = String(body || '').substring(0, MAX_BODY);

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-ChatWorkToken': config.CHATWORK_API_TOKEN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ body: text, self_unread: '1' }).toString(),
      });

      if (res.ok) {
        logger.info('[Chatwork] 通知を送信しました', { roomId: room, 送信先: isTest ? 'テスト' : '本番' });
        return { ok: true };
      }

      const detail = await res.text().catch(() => '');

      // 429 = 回数制限。少し待てば通ることが多い
      if (res.status === 429 && attempt < maxAttempts) {
        const waitMs = 5000 * attempt;
        logger.warn(`[Chatwork] 回数制限（429）。${waitMs}ms 待って再試行します`, { attempt });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // 401 = トークンが違う / 404 = ルームIDが違う（再試行しても無駄）
      lastError = new Error(`HTTP ${res.status}: ${detail.substring(0, 300)}`);
      if (res.status === 401) {
        logger.error('[Chatwork] APIトークンが正しくありません（401）');
      } else if (res.status === 404) {
        logger.error('[Chatwork] ルームIDが正しくないか、参加していません（404）');
      } else {
        logger.error('[Chatwork] 送信に失敗しました', { status: res.status, detail: detail.substring(0, 300) });
      }
      break;
    } catch (err) {
      lastError = err;
      logger.warn(`[Chatwork] 送信エラー（${attempt}/${maxAttempts}）: ${err.message}`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  return { ok: false, error: lastError ? lastError.message : '不明なエラー' };
}

module.exports = { NAME, isConfigured, send, roomId };
