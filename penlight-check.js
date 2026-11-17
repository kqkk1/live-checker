'use strict';
/**
 * ペンライト設定URL（auto_cast）に入れる出演者を、ペンライト拡張機能のカラーデータ（colors.json ＝ スプシの内容）にいる名前だけに絞るための部品
 *   - 照合のしかたは、拡張機能の自動抽出（ui.js の extractFromText）と同じにしてある
 *     ・全角半角・大文字小文字・カタカナ/ひらがな・空白の違いは無視
 *     ・スプシの「アイドル」の行（属性がブランド・事務員・ユニットでないもの）の、A列の名前と別名（「双海亜美・双海真美」の分割、J列）で照合
 *   - colors.json を読めないときは null を返す（呼び出し側は、絞り込みをせずにこれまで通り進める）
 */
const COLORS_URL = process.env.COLORS_URL || 'https://cdn.jsdelivr.net/gh/kqkk1/penlight-assistant@main/penlight-assistant/data/colors.json';

// 拡張機能の Utils.normalizeText と同じ
const normalizeText = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  .replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));

// ペンライト設定URLの auto_cast（カンマ区切りの名前）を取り出す
const castOfUrl = url => { try { return (new URL(url).searchParams.get('auto_cast') || '').split(',').map(s => s.trim()).filter(Boolean); } catch (e) { return []; } };

let _keys = null;
async function loadKeys() {
  if (_keys) return _keys;
  const res = await fetch(COLORS_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = Object.values(data.items || {}).flat();
  if (!items.length) throw new Error('中身が空です');
  _keys = items.filter(it => it.role === 'idol')
    .flatMap(it => [it.n, ...(it.aliases || [])].map(normalizeText))
    .filter(k => k.length > 1);
  return _keys;
}

/** スプシ（カラーデータ）にいる名前かを判定する関数を返す。読めなければ null */
async function knownChecker() {
  try { const keys = await loadKeys(); return name => { const k = normalizeText(name); return keys.some(c => k.includes(c)); }; }
  catch (e) { console.log(` ├─ ℹ️ ペンライトのカラーデータを読めませんでした（${e.message}）`); return null; }
}

module.exports = { knownChecker, normalizeText, castOfUrl };
