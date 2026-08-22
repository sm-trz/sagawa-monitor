/**
 * carriers/index.js
 * スプレッドシートの「配送会社」列の文字から、担当モジュールを選ぶ。
 *
 * 将来、佐川の「スマートAPI」やヤマトの公式APIが使えるようになったら、
 * このフォルダの中のファイルを差し替えるだけで移行できます。
 */

const sagawa = require('./sagawa');
const yamato = require('./yamato');

const CARRIERS = {
  佐川: sagawa,
  ヤマト: yamato,
};

/** 入力の表記ゆれを吸収する */
const ALIASES = {
  佐川: '佐川',
  佐川急便: '佐川',
  さがわ: '佐川',
  飛脚: '佐川',
  飛脚宅配便: '佐川',
  sagawa: '佐川',

  ヤマト: 'ヤマト',
  ヤマト運輸: 'ヤマト',
  やまと: 'ヤマト',
  クロネコ: 'ヤマト',
  クロネコヤマト: 'ヤマト',
  宅急便: 'ヤマト',
  yamato: 'ヤマト',
  kuronekoyamato: 'ヤマト',
};

function normalizeCarrierName(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return ALIASES[key] || ALIASES[key.toLowerCase()] || '';
}

function getCarrier(normalizedName) {
  return CARRIERS[normalizedName] || null;
}

function supportedNames() {
  return Object.keys(CARRIERS);
}

module.exports = { normalizeCarrierName, getCarrier, supportedNames };
