'use strict';
/**
 * Notion の仕上げ作業（移行とスナイパーの動作確認が済んだあとに実行）
 *
 *   node finish.js            … ドライラン（読み取りのみ。何も変更しない）
 *   node finish.js --apply    … 実際に変更する
 *
 * やること
 *  A. 申込記録に「金額」（= 単価 × 枚数。当選・入手のときだけ）の数式列を追加
 *  B. ライブDBの空白行のうち、中身のない行を削除（ゴミ箱へ）。
 *     旧方式の「処理済みURL」が入っている行は、全URLが取得ログにあると確認できたときだけ削除
 *  C. 取り込みで残った「ライブ」「受付枠」のテキスト列を削除し、「〇〇リンク」の列名を元の名前に戻す
 *     （全行がリレーションに紐づいていると確認できたDBだけ）
 *
 * 環境変数: NOTION_API_KEY / NOTION_DB_ID / NOTION_APPLICATION_DB_ID / NOTION_SLOT_DB_ID / NOTION_LOG_DB_ID
 */
const { Client } = require('@notionhq/client');
const APPLY = process.argv.includes('--apply');
const E = { live: process.env.NOTION_DB_ID, app: process.env.NOTION_APPLICATION_DB_ID, slot: process.env.NOTION_SLOT_DB_ID, log: process.env.NOTION_LOG_DB_ID };
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const warns = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(fn) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fn(); await sleep(Number(process.env.API_GAP_MS ?? 350)); return r; }
    catch (e) { if ((e.status === 429 || e.status >= 500 || e.code === 'rate_limited') && i < 4) { await sleep((i + 1) * 3000); continue; } throw e; }
  }
}
async function queryAll(dbId) {
  const out = []; let cursor;
  do { const r = await api(() => notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 })); out.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined; } while (cursor);
  return out;
}
const plain = (arr = []) => arr.map(t => t.plain_text).join('').trim();
const propText = p => !p ? '' : p.type === 'title' ? plain(p.title) : p.type === 'rich_text' ? plain(p.rich_text) : p.type === 'select' ? (p.select?.name || '') : p.type === 'url' ? (p.url || '') : '';
const titleName = meta => Object.entries(meta.properties).find(([, v]) => v.type === 'title')[0];
const retrieve = id => api(() => notion.databases.retrieve({ database_id: id }));

/** 値が入っているか（タイトル・数式・ロールアップ・処理済みURLは除外して判定） */
function hasData(page, titleKey) {
  for (const [k, p] of Object.entries(page.properties)) {
    if (k === titleKey || k === '処理済みURL') continue;
    switch (p.type) {
      case 'rich_text': if (plain(p.rich_text)) return true; break;
      case 'select': if (p.select) return true; break;
      case 'multi_select': if ((p.multi_select || []).length) return true; break;
      case 'date': if (p.date) return true; break;
      case 'url': if (p.url) return true; break;
      case 'relation': if ((p.relation || []).length) return true; break;
      case 'number': if (p.number !== null && p.number !== undefined) return true; break;
      case 'checkbox': if (p.checkbox) return true; break;
      default: break;
    }
  }
  return false;
}

async function taskA() {
  console.log('\nA. 申込記録に「金額」の数式列を追加');
  if (!E.app) return console.log('  NOTION_APPLICATION_DB_ID が未設定のためスキップ');
  const meta = await retrieve(E.app);
  if (meta.properties['金額']) return console.log('  「金額」列は既にあります');
  const need = { '結果': null, '枚数': 'number', '単価': 'number' };
  for (const [k, t] of Object.entries(need)) {
    if (!meta.properties[k]) return warns.push(`申込記録に「${k}」列がありません。金額の列は追加しませんでした`);
    if (t && meta.properties[k].type !== t) return warns.push(`申込記録の「${k}」が数値ではありません（現在: ${meta.properties[k].type}）。列の種類を「数値」に変えてから、もう一度実行してください`);
  }
  console.log('  「金額」列（= 当選・入手のとき 単価 × 枚数）を追加します');
  if (!APPLY) return;
  try {
    await api(() => notion.databases.update({ database_id: E.app, properties: { '金額': { formula: { expression: 'if(or(prop("結果") == "当選", prop("結果") == "入手"), prop("枚数") * prop("単価"), 0)' } } } }));
  } catch (e) { warns.push(`「金額」の数式を自動で作れませんでした（${e.message}）。手で数式の列を追加し、次の式を入れてください: if(or(prop("結果") == "当選", prop("結果") == "入手"), prop("枚数") * prop("単価"), 0)`); }
}

async function taskB() {
  console.log('\nB. ライブDBの空白行を整理');
  const meta = await retrieve(E.live), tk = titleName(meta);
  const pages = await queryAll(E.live);
  const logUrls = new Set();
  if (E.log) { const lm = await retrieve(E.log); for (const p of await queryAll(E.log)) logUrls.add(propText(p.properties[titleName(lm)])); }
  const blanks = pages.filter(p => !propText(p.properties[tk]));
  console.log(`  タイトルが空の行: ${blanks.length}件`);
  let archived = 0, kept = 0;
  for (const p of blanks) {
    const urls = propText(p.properties['処理済みURL']).split(',').map(u => u.trim()).filter(Boolean);
    const missing = urls.filter(u => !logUrls.has(u));
    if (hasData(p, tk)) { kept++; warns.push(`空白行(${p.id.slice(0, 8)}…)に、タイトル以外の値が入っているため残しました`); continue; }
    if (missing.length) { kept++; warns.push(`空白行(${p.id.slice(0, 8)}…)の処理済みURLのうち ${missing.length}件が取得ログにありません。取得ログに追加してから、もう一度実行してください`); continue; }
    archived++;
    if (APPLY) await api(() => notion.pages.update({ page_id: p.id, archived: true }));
  }
  console.log(`  削除（ゴミ箱へ）: ${archived}件 / 残す: ${kept}件`);
}

async function taskC() {
  console.log('\nC. テキスト列の整理（「ライブリンク」→「ライブ」へ）');
  const targets = [[E.slot, '受付枠', 'ライブ'], [E.app, '申込記録', 'ライブ'], [E.app, '申込記録', '受付枠'], [E.log, '取得ログ', 'ライブ']];
  for (const [dbId, label, base] of targets) {
    if (!dbId) { console.log(`  ${label}: DBのIDが未設定のためスキップ`); continue; }
    const meta = await retrieve(dbId), link = base + 'リンク';
    const text = meta.properties[base], rel = meta.properties[link];
    if (text?.type === 'relation') { console.log(`  ${label}「${base}」: 既にリレーションです`); continue; }
    if (!text || text.type !== 'rich_text' || !rel || rel.type !== 'relation') { console.log(`  ${label}「${base}」: 整理の対象ではありません`); continue; }
    const rows = await queryAll(dbId);
    const unlinked = rows.filter(r => propText(r.properties[base]) && !(r.properties[link]?.relation || []).length);
    if (unlinked.length) { warns.push(`${label}「${base}」: リレーションが未設定の行が${unlinked.length}件あるため整理しませんでした（先にスナイパーの移行スクリプトで紐づけてください）`); continue; }
    console.log(`  ${label}「${base}」: テキスト列を削除し、「${link}」を「${base}」に改名します（全${rows.length}行が紐づけ済み）`);
    if (APPLY) {
      await api(() => notion.databases.update({ database_id: dbId, properties: { [base]: null } }));
      await api(() => notion.databases.update({ database_id: dbId, properties: { [link]: { name: base } } }));
    }
  }
}

async function main() {
  if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY が未設定です');
  if (!E.live) throw new Error('NOTION_DB_ID が未設定です');
  console.log(APPLY ? '【実行モード】Notionを変更します' : '【ドライラン】読み取りのみ。変更は行いません');
  await taskA(); await taskB(); await taskC();
  if (warns.length) { console.log(`\n⚠️ 確認が必要な点 (${warns.length}件)`); warns.forEach(w => console.log(' - ' + w)); }
  if (!APPLY) console.log('\n※ドライランです。内容を確認して問題なければ --apply を付けて実行してください');
}
module.exports = { hasData };
if (require.main === module) main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
