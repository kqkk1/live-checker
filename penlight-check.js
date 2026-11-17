'use strict';
/**
 * ペンライト設定URL（auto_cast）に入れる出演者名が、ペンライト拡張機能のカラーデータ（colors.json）で見つかるかを確認する
 *   - 照合のしかたは、拡張機能の自動抽出（ui.js の extractFromText）と同じにしてある
 *     ・全角半角・大文字小文字・カタカナ/ひらがな・空白の違いは無視
 *     ・スプシの「アイドル」の行（属性がブランド・事務員・ユニットでないもの）の、A列の名前とJ列「別名」で照合
 *   - 見つからない名前があれば「確認のお願い」として Discord に通知される（通知は、内容が前回と変わったときだけ）
 *   - colors.json を読めないときは、確認をせずに進める（events.json の生成は止めない）
 */
const COLORS_URL = process.env.COLORS_URL || 'https://cdn.jsdelivr.net/gh/kqkk1/penlight-assistant@main/penlight-assistant/data/colors.json';

// 拡張機能の Utils.normalizeText と同じ
const normalizeText = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));

// ペンライト設定URLの auto_cast（カンマ区切りの名前）を取り出す
const castOfUrl = url => { try { return (new URL(url).searchParams.get('auto_cast') || '').split(',').map(s => s.trim()).filter(Boolean); } catch (e) { return []; } };

async function loadKeys() {
  const res = await fetch(COLORS_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = Object.values(data.items || {}).flat();
  if (!items.length) throw new Error('中身が空です');
  return items.filter(it => it.role === 'idol')
    .flatMap(it => [it.n, ...(it.aliases || [])].map(normalizeText))
    .filter(k => k.length > 1);
}

/**
 * これから開催のライブについて、ペンライト対象の出演者で、色が見つからない名前を集める
 * @param events buildEvents の結果。各公演の penlightUrl から、拡張機能に渡る名前（auto_cast）を取り出して確認する
 * @returns { issues: string[], checked: boolean }
 */
async function check(events, today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })) {
  let keys;
  try { keys = await loadKeys(); }
  catch (e) { console.log(` ├─ ℹ️ ペンライトのカラーデータを読めなかったため、出演者名の照合は今回スキップします（${e.message}）`); return { issues: [], checked: false }; }
  const found = name => { const k = normalizeText(name); return keys.some(c => k.includes(c)); };
  const issues = [];
  for (const ev of events) {
    const end = ev.eventDateEnd || ev.eventDateStart || '';
    if (end && end < today) continue;   // 終わったライブは確認しない
    const missing = [...new Set((ev.schedules || []).flatMap(s => castOfUrl(s.penlightUrl)).filter(n => !found(n)))];
    if (missing.length) issues.push(`${ev.title}: ペンライトの色が見つからない出演者がいます: ${missing.join('、')}（スプシのA列の名前か、J列「別名」を確認してください。ペンライトの対象外なら、公演日程DBの「ペンライト対象外」に入れてください）`);
  }
  return { issues, checked: true };
}

module.exports = { check, normalizeText, castOfUrl };
