/**
 * sagawa-monitor / src/test.js
 * ローカル動作確認スクリプト
 *
 * 使い方:
 *   SPREADSHEET_ID=xxx node src/test.js
 *   または
 *   node src/test.js --tracking 1234567890
 */

require('dotenv').config();
const { classifyStatus, isReturnStatus } = require('./sagawa');
const logger = require('./logger');

// ── ステータス判定ロジックの単体テスト ──────────────────────────────────────
function runStatusTests() {
  console.log('\n=== ステータス判定テスト ===\n');

  const testCases = [
    { input: 'お荷物は配達完了となりました', expected: '配達完了' },
    { input: 'ただいま配達中です', expected: '配達中' },
    { input: '幹線輸送中', expected: '輸送中' },
    { input: '配達店到着', expected: '輸送中' },
    { input: '集荷完了しました', expected: '集荷' },
    { input: '営業所保管中', expected: '保管中' },
    { input: '不在持戻しました', expected: '持戻り' },
    { input: '長期不在のため保管', expected: '長期不在' },
    { input: '受取拒否されました', expected: '受取拒否' },
    { input: '受取辞退', expected: '受取辞退' },
    { input: '返送処理中', expected: '返送' },
    { input: '返品完了', expected: '返品' },
    { input: 'その他の文字列', expected: '不明' },
    { input: '', expected: '不明' },
  ];

  let passed = 0;
  let failed = 0;

  for (const { input, expected } of testCases) {
    const result = classifyStatus(input);
    const ok = result === expected;
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} "${input}" → ${result} (期待値: ${expected})`);
    if (ok) passed++; else failed++;
  }

  console.log(`\n結果: ${passed} 件合格 / ${failed} 件失敗\n`);
}

// ── 返品判定テスト ────────────────────────────────────────────────────────────
function runReturnFlagTests() {
  console.log('=== 返品フラグテスト ===\n');

  const cases = [
    { status: '受取拒否', expected: true },
    { status: '受取辞退', expected: true },
    { status: '返送',     expected: true },
    { status: '返品',     expected: true },
    { status: '長期不在', expected: true },
    { status: '持戻り',   expected: true },
    { status: '配達完了', expected: false },
    { status: '輸送中',   expected: false },
    { status: '不明',     expected: false },
  ];

  let passed = 0;
  let failed = 0;

  for (const { status, expected } of cases) {
    const result = isReturnStatus(status);
    const ok = result === expected;
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} "${status}" → isReturn=${result} (期待値: ${expected})`);
    if (ok) passed++; else failed++;
  }

  console.log(`\n結果: ${passed} 件合格 / ${failed} 件失敗\n`);
}

// ── 実際のスクレイピングテスト（引数に --tracking を渡した場合） ──────────────
async function runScrapingTest() {
  const args = process.argv.slice(2);
  const trackingIdx = args.indexOf('--tracking');
  if (trackingIdx === -1) return;

  const trackingNo = args[trackingIdx + 1];
  if (!trackingNo) {
    console.error('--tracking の後に伝票番号を指定してください');
    return;
  }

  console.log(`\n=== スクレイピングテスト: ${trackingNo} ===\n`);

  const { fetchAllStatuses } = require('./sagawa');
  try {
    const results = await fetchAllStatuses([{ trackingNo }]);
    console.log('取得結果:', JSON.stringify(results, null, 2));
  } catch (err) {
    console.error('エラー:', err.message);
  }
}

// ── 実行 ─────────────────────────────────────────────────────────────────────
(async () => {
  runStatusTests();
  runReturnFlagTests();
  await runScrapingTest();
})();
