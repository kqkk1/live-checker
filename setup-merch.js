'use strict';
/**
 * 物販DB（会場物販のデジタル注文書・整理券・事前販売）を作成する（最初に1回だけ実行）
 *
 *   node setup-merch.js            … ドライラン（何も作らない）
 *   node setup-merch.js --apply    … 作成する
 *
 * 環境変数
 *   NOTION_API_KEY / NOTION_DB_ID（ライブ） / NOTION_PARENT_PAGE_ID（DBを置くページ）
 *   NOTION_MERCH_DB_ID（任意。既にあれば、足りない列だけを足す）
 *
 * 作成後に表示される NOTION_MERCH_DB_ID を、GitHubのSecretsに追加すると、スナイパーが物販情報を集め始める
 */
const { Client } = require('@notionhq/client');
const APPLY = process.argv.includes('--apply');
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const E = { live: process.env.NOTION_DB_ID, parent: process.env.NOTION_PARENT_PAGE_ID, merch: process.env.NOTION_MERCH_DB_ID };
const sleep = ms => new Promise(r => setTimeout(r, process.env.API_GAP_MS ? 0 : ms));
async function api(fn) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fn(); await sleep(350); return r; }
    catch (e) { if ((e.status === 429 || e.status >= 500 || e.code === 'rate_limited') && i < 4) { await sleep((i + 1) * 3000); continue; } throw e; }
  }
}
const COLS = {
  '種別': { select: { options: [{ name: '会場物販' }, { name: '整理券' }, { name: '事前販売' }] } },
  '名称': { rich_text: {} }, 'URL': { url: {} },
  '開始': { date: {} }, '締切': { date: {} }, '当落発表': { date: {} },
  '物販日時': { rich_text: {} }, '場所': { rich_text: {} }, '整理券の時間帯': { rich_text: {} }, 'フリーの時間帯': { rich_text: {} }, '取得元': { url: {} },
  'ロック': { checkbox: {} }, '最終自動更新': { date: {} },
};

async function main() {
  if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY が未設定です');
  if (!E.live) throw new Error('NOTION_DB_ID（ライブDB）が未設定です');
  console.log(APPLY ? '【実行モード】Notionに作成します' : '【ドライラン】何も作成しません');
  let id = E.merch;
  if (!id && E.parent) {   // 二重作成の防止：作成先ページに「物販」DBが既にあれば、それを使う
    const kids = await api(() => notion.blocks.children.list({ block_id: E.parent, page_size: 100 }));
    const found = kids.results.find(x => x.type === 'child_database' && x.child_database?.title === '物販');
    if (found) { id = found.id; console.log(`既存の「物販」DBを使います（ID: ${id}）`); }
  }
  if (!id) {
    if (!E.parent) { if (APPLY) throw new Error('DBを作るには NOTION_PARENT_PAGE_ID が必要です'); console.log('※ NOTION_PARENT_PAGE_ID が未設定です。実行前に設定してください'); }
    console.log('「物販」DBを新規作成します');
    if (APPLY) {
      const db = await api(() => notion.databases.create({
        parent: { type: 'page_id', page_id: E.parent }, title: [{ type: 'text', text: { content: '物販' } }],
        properties: { '名前': { title: {} }, 'ライブ': { relation: { database_id: E.live, type: 'dual_property', dual_property: {} } }, ...COLS },
      }));
      id = db.id;
      console.log(`\n✅ 作成しました。次の値を、GitHubのSecretsに「NOTION_MERCH_DB_ID」として追加してください:\n   ${id}`);
    }
    return;
  }
  const meta = await api(() => notion.databases.retrieve({ database_id: id }));
  const missing = Object.fromEntries(Object.entries(COLS).filter(([k]) => !meta.properties[k]));
  if (!meta.properties['ライブ'] || meta.properties['ライブ'].type !== 'relation') console.log('⚠️ 「ライブ」のリレーション列がありません。手で、ライブDBへのリレーション列を追加してください');
  if (!Object.keys(missing).length) console.log('足りない列はありません');
  else { console.log(`足りない列を追加します: ${Object.keys(missing).join(', ')}`); if (APPLY) await api(() => notion.databases.update({ database_id: id, properties: missing })); }
  console.log(`\nNOTION_MERCH_DB_ID = ${id}`);
}
main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
