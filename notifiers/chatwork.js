/**
 * notifiers/chatwork.js
 * Chatwork へタスク（または通常メッセージ）を送る。
 *
 * ── 使うAPI ─────────────────────────────────────────────────
 * タスク追加   POST /rooms/{room_id}/tasks
 *   body       タスクの内容（65,535文字以下）※必須
 *   to_ids     担当者のアカウントIDをカンマ区切り ※必須
 *              （そのチャットに参加している人しか指定できない）
 *   limit      期限。Unix時間（秒）
 *   limit_type none / date / time（既定は time）
 *
 * メンバー一覧 GET /rooms/{room_id}/members
 *   → account_id / role（admin / member / readonly）/ name が返る
 *
 * メッセージ投稿 POST /rooms/{room_id}/messages
 *
 * 共通ヘッダー  X-ChatWorkToken: （APIトークン）
 * 共通          Content-Type: application/x-www-form-urlencoded
 *
 * 参考: https://developer.chatwork.com/reference/post-rooms-room_id-tasks
 */

const logger = require('../logger');
const config = require('../config');

const NAME = 'Chatwork';
const API_BASE = 'https://api.chatwork.com/v2';
const MAX_BODY = 60000;

/** テストか本番かで送信先ルームを選ぶ */
function roomId({ isTest = false } = {}) {
  if (isTest) {
    // テスト用が未設定なら本番へは送らない（誤爆防止）
    return config.CHATWORK_ROOM_ID_TEST || '';
  }
  return config.CHATWORK_ROOM_ID || '';
}

/**
 * システムエラーと日次サマリの送信先。
 * 業務委託者グループには絶対に流さない。
 * 運用ルームが未設定ならテストルームへ、それも無ければ送らない。
 */
function alertRoomId() {
  return config.CHATWORK_ROOM_ID_ALERT || config.CHATWORK_ROOM_ID_TEST || '';
}

function isConfigured({ isTest = false } = {}) {
  return Boolean(config.CHATWORK_API_TOKEN && roomId({ isTest }));
}

function headers() {
  return {
    'X-ChatWorkToken': config.CHATWORK_API_TOKEN,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/**
 * Chatwork API を叩く。429（回数制限）のときだけ待って再試行する。
 */
async function callApi(method, path, params) {
  const url = `${API_BASE}${path}`;
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const options = { method, headers: headers() };
      if (params) options.body = new URLSearchParams(params).toString();

      const res = await fetch(url, options);

      if (res.ok) {
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* JSONでなくてもよい */ }
        return { ok: true, data };
      }

      const detail = await res.text().catch(() => '');

      if (res.status === 429 && attempt < maxAttempts) {
        const waitMs = 5000 * attempt;
        logger.warn(`[Chatwork] 回数制限（429）。${waitMs}ms 待って再試行します`, { path, attempt });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const reason =
        res.status === 401 ? 'APIトークンが正しくありません'
        : res.status === 403 ? 'この操作の権限がありません（タスク追加が許可されていない可能性）'
        : res.status === 404 ? 'ルームIDが正しくないか、参加していません'
        : res.status === 400 ? 'パラメータが不正です（担当者IDがそのチャットに居ない可能性）'
        : `HTTP ${res.status}`;

      logger.error(`[Chatwork] ${reason}`, { path, status: res.status, detail: detail.substring(0, 300) });
      return { ok: false, status: res.status, error: reason, detail: detail.substring(0, 300) };
    } catch (err) {
      lastError = err;
      logger.warn(`[Chatwork] 通信エラー（${attempt}/${maxAttempts}）: ${err.message}`, { path });
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  return { ok: false, error: lastError ? lastError.message : '不明なエラー' };
}

// ── 担当者IDの解決 ──────────────────────────────────────────
// 実行ごとにキャッシュする（同じ実行内で何度もメンバー一覧を取りに行かない）
const _memberCache = new Map();

/**
 * タスクの担当者にするアカウントIDを決める。
 *   1. 環境変数 CHATWORK_TASK_TO_IDS が設定されていればそれを使う
 *   2. 無ければルームのメンバー一覧を取得し、閲覧のみ以外の全員にする
 */
async function resolveAssignees(room) {
  const fixed = String(config.CHATWORK_TASK_TO_IDS || '').trim();
  if (fixed) {
    const ids = fixed.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) return { ok: true, ids, source: '環境変数' };
  }

  if (_memberCache.has(room)) return _memberCache.get(room);

  const res = await callApi('GET', `/rooms/${encodeURIComponent(room)}/members`);
  if (!res.ok || !Array.isArray(res.data)) {
    const failed = { ok: false, ids: [], error: res.error || 'メンバー一覧を取得できませんでした' };
    _memberCache.set(room, failed);
    return failed;
  }

  // 閲覧のみの人はタスクを完了できないので除外する
  const ids = res.data
    .filter((m) => m && m.role !== 'readonly' && m.account_id)
    .map((m) => String(m.account_id));

  const result = ids.length > 0
    ? { ok: true, ids, source: 'ルームのメンバー' }
    : { ok: false, ids: [], error: 'タスクを割り当てられるメンバーが居ません' };

  _memberCache.set(room, result);
  if (result.ok) {
    logger.info('[Chatwork] タスクの担当者を決定しました', {
      room, 人数: ids.length, 取得元: result.source,
    });
  }
  return result;
}

/** 実行のたびにキャッシュを空にする */
function resetCache() {
  _memberCache.clear();
}

// ── 期限 ────────────────────────────────────────────────────
/**
 * "2026/08/30" を Unix時間（秒）にする。
 * 日本時間の正午を指すようにして、時差で前日に見えるのを防ぐ。
 */
function toLimitUnix(dateText) {
  const m = String(dateText || '').match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return null;
  // JST正午 = UTC 03:00
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 3, 0, 0);
  return Math.floor(ms / 1000);
}

// ── 送信 ────────────────────────────────────────────────────

/**
 * タスクを1件作る。
 * @param {string} body       タスク本文
 * @param {object} options    { isTest, limitDate }
 */
async function createTask(body, { isTest = false, limitDate = '' } = {}) {
  const room = roomId({ isTest });
  if (!config.CHATWORK_API_TOKEN || !room) {
    logger.warn('[Chatwork] トークンまたはルームIDが未設定のため送信しません', {
      isTest, hasToken: Boolean(config.CHATWORK_API_TOKEN), hasRoom: Boolean(room),
    });
    return { ok: false, skipped: true };
  }

  const assignees = await resolveAssignees(room);
  if (!assignees.ok) {
    logger.error('[Chatwork] タスクの担当者を決められませんでした', {
      room,
      error: assignees.error,
      対処: '環境変数 CHATWORK_TASK_TO_IDS にアカウントIDを設定してください',
    });
    return { ok: false, error: assignees.error };
  }

  const params = {
    body: String(body || '').substring(0, MAX_BODY),
    to_ids: assignees.ids.join(','),
  };

  const limit = toLimitUnix(limitDate);
  if (limit) {
    params.limit = String(limit);
    params.limit_type = 'date';
  } else {
    params.limit_type = 'none';
  }

  const res = await callApi('POST', `/rooms/${encodeURIComponent(room)}/tasks`, params);
  if (res.ok) {
    logger.info('[Chatwork] タスクを作成しました', {
      room, 送信先: isTest ? 'テスト' : '本番', 期限: limitDate || 'なし',
    });
  }
  return res;
}

/**
 * 通常のメッセージを1件送る。
 * room を明示すると、その部屋へ送る（運用ルーム向け）。
 */
async function send(body, { isTest = false, room: roomOverride = '' } = {}) {
  const room = roomOverride || roomId({ isTest });
  if (!config.CHATWORK_API_TOKEN || !room) {
    logger.warn('[Chatwork] トークンまたはルームIDが未設定のため送信しません', {
      isTest, hasToken: Boolean(config.CHATWORK_API_TOKEN), hasRoom: Boolean(room),
    });
    return { ok: false, skipped: true };
  }

  const res = await callApi('POST', `/rooms/${encodeURIComponent(room)}/messages`, {
    body: String(body || '').substring(0, MAX_BODY),
    self_unread: '1',
  });
  if (res.ok) {
    logger.info('[Chatwork] メッセージを送信しました', { room, 送信先: isTest ? 'テスト' : '本番' });
  }
  return res;
}

module.exports = {
  NAME,
  isConfigured,
  roomId,
  alertRoomId,
  createTask,
  send,
  resolveAssignees,
  resetCache,
  toLimitUnix,
};
