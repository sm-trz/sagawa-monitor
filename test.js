/**
 * test.js
 * 通信をせずに判定ロジックだけを確認するテスト。
 *
 *   node test.js
 *
 * ここで使っているページ本文は、2026-08 に Cloud Run のログから
 * 実際に取得した本物のデータです。
 */

const sagawa = require('./carriers/sagawa');
const yamato = require('./carriers/yamato');
const { judge, shouldNotify, returnDeadline } = require('./judge');
const { toDateTime } = require('./datetime');
const { buildItem, cartUrl, buildMessage } = require('./notifiers');

let passed = 0;
let failed = 0;

function check(title, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  OK ' : '  NG '} ${title}: ${actual}${ok ? '' : `（期待値: ${expected}）`}`);
  ok ? passed++ : failed++;
}

function section(title) {
  console.log(`\n=== ${title} ===\n`);
}

// ══ 実データ（佐川）════════════════════════════════════════
const SAGAWA_TRANSIT = [
  '佐川急便', '', 'お荷物問い合わせサービス', '',
  '詳細\tお問い合せ送り状No.\t最新荷物状況', '詳細1', '\t444803015366\t',
  '輸送中', '', 'ただいま配達営業所へ輸送中です。', '',
  '配達予定日　　：', '08月21日　18～21時',
  'お問い合せ送り状No.\t444803015366', '出荷日\t2026年08月20日',
  '集荷に関するお問い合せ\t西埼玉営業所  TEL:0570-55-0421 FAX:04-2953-9470',
  '配達に関するお問い合せ\t城北営業所  TEL:0570-01-0362 FAX:03-5945-5650',
  'お荷物個数\t1個',
  '荷物状況\t日時\t担当営業所',
  '↓集荷\t08/20 17:13\t西埼玉営業所',
  '⇒輸送中\t08/20 23:09\t関東中継センター',
].join('\n');

// 途中で「保管中」を経由したが最終は配達完了（配達中の記録あり）
const SAGAWA_DELIVERED = [
  '佐川急便', '', 'お荷物問い合わせサービス', '',
  '詳細\tお問い合せ送り状No.\t最新荷物状況', '詳細1', '\t444803009836\t',
  '配達完了', '', 'お荷物のお届けが完了いたしました。', '',
  '配達完了日　　：', '08月19日　18時23分',
  'お問い合せ送り状No.\t444803009836', '出荷日\t2026年08月17日',
  '集荷に関するお問い合せ\t西埼玉営業所  TEL:0570-55-0421 FAX:04-2953-9470',
  '配達に関するお問い合せ\t松江営業所  TEL:0570-01-0264 FAX:0852-28-2676',
  'お荷物個数\t1個',
  '荷物状況\t日時\t担当営業所',
  '↓集荷\t08/17 17:22\t西埼玉営業所',
  '↓輸送中\t08/17 18:10\t北関東中継センター',
  '↓輸送中\t08/18 05:50\t関西中継センター',
  '↓保管中\t08/18 14:14\t松江営業所',
  '↓配達中\t08/19 13:19\t松江営業所',
  '⇒配達完了\t08/19 18:23\t松江営業所',
].join('\n');

// 返品確定の荷物（履歴テーブルが消えている）
const SAGAWA_RETURNED = [
  '佐川急便', '', 'お荷物問い合わせサービス', '',
  '詳細\tお問い合せ送り状No.\t最新荷物状況', '詳細1', '\t444803002033\t',
  '調査中', '', '恐れ入りますが、営業所へお問い合わせください。', '',
  'お問い合せ送り状No.\t444803002033', '出荷日\t2026年08月07日',
  '集荷に関するお問い合せ\t西埼玉営業所  TEL:0570-55-0421 FAX:04-2953-9470',
  '配達に関するお問い合せ\t荒川営業所  TEL:0570-01-0659 FAX:03-3616-8851',
  'お荷物個数\t1個',
  '詳細表示\t恐れ入りますが、営業所へお問い合わせください。',
].join('\n');

// 不在で持ち帰り（配達中 → 保管中）。実データを元にした想定パターン
const SAGAWA_HELD = [
  '佐川急便', '', 'お荷物問い合わせサービス', '',
  '詳細\tお問い合せ送り状No.\t最新荷物状況', '詳細1', '\t444803099999\t',
  '保管中', '', 'ご不在のため持ち帰りました。', '',
  'お問い合せ送り状No.\t444803099999', '出荷日\t2026年08月18日',
  '配達に関するお問い合せ\t荒川営業所  TEL:0570-01-0659 FAX:03-3616-8851',
  '荷物状況\t日時\t担当営業所',
  '↓集荷\t08/18 17:22\t西埼玉営業所',
  '↓輸送中\t08/19 05:50\t関東中継センター',
  '↓配達中\t08/20 10:15\t荒川営業所',
  '⇒保管中\t08/20 12:30\t荒川営業所',
].join('\n');

// ══ 実データ（ヤマト）══════════════════════════════════════
const YAMATO_RETURNED = [
  '個人のお客さま', '荷物お問い合わせシステム', '送り状番号検索',
  '日付', '配送状況', '08/21', '陸・海上切替え',
  '一覧印刷', 'T2', '画面を閉じる', '1件目：7661-7188-8193', '陸・海上切替え',
  '作業店にて輸送方法（陸路及び海上輸送）の変更をいたしました。',
  '詳細確認／日時・場所変更',
  'お届け完了通知を依頼',        // ← 誤ヒットの元になったボタン
  '商品名：', 'ネコポス', 'お届け予定日時：', '-',
  '荷物受付', '08月10日 16:13', '埼玉日高営業所（日高中央）',
  '発送済み', '08月10日 16:13', '埼玉日高営業所（日高中央）',
  '調査中', '08月19日 07:50', '宜野湾営業所（普天間）',
  '調査中', '08月20日 07:56', '宜野湾営業所（普天間）',
  '陸・海上切替え', '08月20日 14:52', '宜野湾営業所（大山）',
  '返品', '08月20日 14:52', '宜野湾営業所（大山）',
  '陸・海上切替え', '08月21日 01:58', '沖縄ベース',
  '詳細印刷',
].join('\n');

const YAMATO_DELIVERED = [
  '個人のお客さま', '荷物お問い合わせシステム',
  '日付', '配送状況', '08/08', '配達完了',
  '一覧印刷', 'T1', '画面を閉じる', '1件目：7661-5480-9302', '配達完了',
  'このお品物はお届けが済んでおります。',
  '詳細確認／日時・場所変更', 'お届け完了通知を依頼',
  '商品名：', 'ネコポス', 'お届け予定日時：', '-',
  '荷物受付', '08月06日 16:44', '埼玉日高営業所（日高中央）',
  '発送済み', '08月06日 16:44', '埼玉日高営業所（日高中央）',
  '配達完了', '08月08日 09:08', '別府亀川営業所（別府亀川）',
  '詳細印刷',
].join('\n');

const NOW = new Date(2026, 7, 23); // 2026-08-23

// ══ テスト ═════════════════════════════════════════════════
section('佐川ページの解析（実データ）');

const s1 = sagawa.parsePageText(SAGAWA_TRANSIT, '444803015366');
check('444803015366 のステータス', s1.status, '輸送中');
check('444803015366 の集荷日', s1.shipDate, '2026/08/20');

const s2 = sagawa.parsePageText(SAGAWA_DELIVERED, '444803009836');
check('444803009836 のステータス（履歴に保管中あり）', s2.status, '配達完了');
check('444803009836 の配達完了日時', s2.deliveredAt, '2026/08/19 18:23');
check('444803009836 の集荷日', s2.shipDate, '2026/08/17');

const s3 = sagawa.parsePageText(SAGAWA_RETURNED, '444803002033');
check('444803002033 のステータス（返品確定・履歴なし）', s3.status, '調査中');
check('444803002033 の集荷日', s3.shipDate, '2026/08/07');
check('444803002033 の営業所', s3.office, '荒川営業所');
check('444803002033 の営業所TEL', s3.officeTel, '0570-01-0659');

const s4 = sagawa.parsePageText(SAGAWA_HELD, '444803099999');
check('持ち帰りケースのステータス', s4.status, '保管中');
check('持ち帰りケースは配達を試みている', String(s4.attemptedDelivery), 'true');
check('持ち帰り日時', s4.heldAt, '2026/08/20 12:30');
check('配達前保管は配達を試みていない', String(sagawa.parsePageText(SAGAWA_TRANSIT, '444803015366').attemptedDelivery), 'false');

section('ヤマトページの解析（実データ）');

const y1 = yamato.parsePageText(YAMATO_RETURNED, NOW);
check('766171888193 の最新記録', y1.status, '輸送中');
check('766171888193 の履歴に返品あり', String(y1.history.includes('返品')), 'true');
check('766171888193 の返品日時', y1.returnedAt, '2026/08/20 14:52');
check('766171888193 の集荷日', y1.shipDate, '2026/08/10');

const y2 = yamato.parsePageText(YAMATO_DELIVERED, NOW);
check('766154809302 のステータス', y2.status, '配達完了');
check('766154809302 の配達完了日時', y2.deliveredAt, '2026/08/08 09:08');

const blocks = yamato.splitByItem(
  YAMATO_RETURNED + '\n2件目：7661-5480-9302\n' + YAMATO_DELIVERED.split('1件目：7661-5480-9302\n')[1]
);
check('まとめ照会: 2件に分割', String(blocks.length), '2');
check('まとめ照会: 1件目の番号', blocks[0].trackingNo, '766171888193');
check('まとめ照会: 2件目の番号', blocks[1].trackingNo, '766154809302');
check('まとめ照会: 混線しない', String(yamato.parsePageText(blocks[1].text, NOW).history.includes('返品')), 'false');

section('判定ルール');

const jDelivered = judge({ status: '配達完了', history: ['集荷', '保管中', '配達中', '配達完了'], carrierName: '佐川', now: NOW });
check('配達完了 → 監視終了', String(jDelivered.finished), 'true');
check('配達完了 → 判定なし（履歴に保管中があっても）', jDelivered.flag || '(なし)', '(なし)');

const jTransit = judge({ status: '輸送中', shipDate: '2026/08/20', carrierName: '佐川', now: NOW });
check('輸送中 → 何もしない', jTransit.flag || '(なし)', '(なし)');

const jTransitOld = judge({ status: '輸送中', shipDate: '2026/08/01', carrierName: '佐川', now: NOW });
check('輸送中で22日経過 → 通知しないが記録は残す', jTransitOld.flag || '(なし)', '(なし)');

const jHeld = judge({ status: '保管中', attemptedDelivery: true, heldAt: '2026/08/20 12:30', carrierName: '佐川', now: NOW });
check('配達後の保管中 → 要調査', jHeld.flag, '要調査');
check('返送予定日（佐川8日）', jHeld.deadline.date, '2026/08/28');
check('返送まで残り日数', String(jHeld.deadline.daysLeft), '5');

const jStored = judge({ status: '保管中', attemptedDelivery: false, carrierName: '佐川', now: NOW });
check('配達前の保管中 → 経過観察（通知しない）', jStored.flag, '経過観察');

const jMochimodori = judge({ status: '持戻り', heldAt: '2026/08/22 10:00', carrierName: 'ヤマト', now: NOW });
check('持戻り → 要調査', jMochimodori.flag, '要調査');
check('返送予定日（ヤマト7日）', jMochimodori.deadline.date, '2026/08/29');

const jInvestigating = judge({ status: '調査中', shipDate: '2026/08/07', carrierName: '佐川', now: NOW });
check('佐川の調査中 → 要調査', jInvestigating.flag, '要調査');

const jReturned = judge({ status: '輸送中', history: ['荷物受付', '調査中', '返品', '輸送中'], carrierName: 'ヤマト', now: NOW });
check('履歴に返品 → 返品確定', jReturned.flag, '返品確定');
check('履歴に返品 → H列に「返品」と記録', jReturned.effectiveStatus, '返品');

const jFail = judge({ status: '取得失敗', carrierName: '佐川', now: NOW });
check('取得失敗 → 要調査', jFail.flag, '要調査');

const jOff = judge({ status: '持戻り', heldAt: '2026/08/22 10:00', carrierName: 'ヤマト', trustStatus: false, now: NOW });
check('ヤマト判定オフ → 通知しない', jOff.flag || '(なし)', '(なし)');

section('通知レベル');

check('未通知 → 要調査 は通知', String(shouldNotify('要調査', '')), 'true');
check('要調査 → 要調査 は通知しない', String(shouldNotify('要調査', '要調査')), 'false');
check('要調査 → 返品確定 は再通知', String(shouldNotify('返品確定', '要調査')), 'true');
check('返品確定 → 要調査 は通知しない', String(shouldNotify('要調査', '返品確定')), 'false');
check('経過観察 は通知しない', String(shouldNotify('経過観察', '')), 'false');
check('長期未完了 は通知しない', String(shouldNotify('長期未完了', '')), 'false');
check('旧仕様TRUE → 返品確定 は通知', String(shouldNotify('返品確定', 'TRUE')), 'true');

section('年をまたぐ日時の補完');

check('集荷12/28・記録01/05 → 翌年', toDateTime('01/05 10:00', '2026/12/28'), '2027/01/05 10:00');
check('集荷08/17・記録08/19 → 同年', toDateTime('08/19 18:23', '2026/08/17'), '2026/08/19 18:23');
check('ヤマト形式', toDateTime('08月20日 14:52', '2026/08/10'), '2026/08/20 14:52');

section('カートURL');

check('数字のみ → URLを作る', cartUrl('52406'), 'https://beautymakelabo.jp/admin/order/edit.php?mode=pre_edit&order_id=52406');
check('ハイフン入り → URLなし', cartUrl('397251-20260805') || '(なし)', '(なし)');
check('英字混じり → URLなし', cartUrl('s-49') || '(なし)', '(なし)');
check('空欄 → URLなし', cartUrl('') || '(なし)', '(なし)');

section('通知メッセージ');

const item = {
  rowIndex: 2, orderNo: '52406', name: '山田 太郎',
  address: '東京都千代田区1-1-1', tel: '090-1234-5678',
  carrier: 'ヤマト', trackingNo: '766171888193',
  shipDate: '2026/08/10 16:13', heldAt: '2026/08/20 14:52',
  status: '持戻り', flag: '要調査',
  office: '宜野湾営業所', officeTel: '',
  deadline: { date: '2026/08/27', daysLeft: 4 },
};
const body = buildItem(item);
check('氏名が入る', String(body.includes('山田 太郎 様')), 'true');
check('電話番号が入る', String(body.includes('090-1234-5678')), 'true');
check('返送予定が入る', String(body.includes('あと4日')), 'true');
check('カートURLが入る', String(body.includes('order_id=52406')), 'true');

const msg = buildMessage([item], { isTest: true });
check('テスト時は【テスト】が付く', String(msg.includes('【テスト】')), 'true');
check('infoタグで囲む', String(msg.startsWith('[info]') && msg.endsWith('[/info]')), 'true');

const msgReturned = buildMessage([{ ...item, flag: '返品確定', status: '返品' }]);
check('返品確定は返品処理を依頼', String(msgReturned.includes('返品理由を確認')), 'true');

console.log('\n----------------------------------------');
console.log(`  合格 ${passed} 件 / 不合格 ${failed} 件`);
console.log('----------------------------------------\n');

process.exit(failed === 0 ? 0 : 1);
