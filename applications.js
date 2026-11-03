'use strict';
/**
 * （任意機能）新しい受付枠ができたとき、申込記録の行を自動で作る
 *
 * 「誰が」「どの公演に」「どの受付枠で」の行を、結果「未申込」で用意しておき、
 * 利用者は結果の選択肢を変えるだけで済むようにする。
 * 既にある行（同じ 受付枠 + 公演 + 申込者）は作らないので、何度動いても重複しない。
 *
 * 使い方（index.js への組み込みは、一番下のコメントを参照）
 *   環境変数  NOTION_APPLICATION_DB_ID … 申込記録DBのID
 *             APPLICANTS               … 申込者の名前をカンマ区切りで（例: ねこぷち,カッキ～）
 *   どちらかが未設定なら、何もしない（今の動作は変わらない）
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const plain = (arr = []) => arr.map(t => t.plain_text).join('').trim();
const propText = p => !p ? '' : p.type === 'title' ? plain(p.title) : p.type === 'rich_text' ? plain(p.rich_text) : p.type === 'select' ? (p.select?.name || '') : '';
const rt = s => s ? [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] : [];
const titleName = meta => Object.entries(meta.properties).find(([, v]) => v.type === 'title')[0];
const relName = (meta, base) => meta.properties[base]?.type === 'relation' ? base : (meta.properties[base + 'リンク']?.type === 'relation' ? base + 'リンク' : null);

function put(meta, props, name, v) {
  const p = meta.properties[name];
  if (!p || v === undefined) return false;
  switch (p.type) {
    case 'title': props[name] = { title: rt(v) }; break;
    case 'rich_text': props[name] = { rich_text: rt(v) }; break;
    case 'select': props[name] = { select: v ? { name: v } : null }; break;
    case 'number': props[name] = { number: v ?? null }; break;
    case 'relation': props[name] = { relation: (Array.isArray(v) ? v : [v]).filter(Boolean).map(id => ({ id })) }; break;
    default: return false;
  }
  return true;
}

function create({ notion, appDbId, applicants, dryRun = false, defaultTickets = 2, gapMs = 350 }) {
  const names = (applicants || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!appDbId || !names.length) return null;   // 未設定なら無効
  let ctx = null;
  const made_ = new Set();   // この実行中に作った行の記録（Notionの返答が不完全でも重複させない）
  async function load() {
    if (ctx) return ctx;
    const meta = await notion.databases.retrieve({ database_id: appDbId });
    const pages = []; let cursor;
    do { const r = await notion.databases.query({ database_id: appDbId, start_cursor: cursor, page_size: 100 }); pages.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined; } while (cursor);
    ctx = { meta, pages, liveRel: relName(meta, 'ライブ'), slotRel: relName(meta, '受付枠'), schedRel: meta.properties['公演']?.type === 'relation' ? '公演' : null };
    return ctx;
  }
  /**
   * @param live       ライブのページ
   * @param liveTitle  ライブ名
   * @param slotPage   新しくできた受付枠のページ
   * @param slotTier   受付枠の名前
   * @param schedPages そのライブの公演日程のページ一覧
   * @returns 作成した行数
   */
  async function ensureRows({ live, liveTitle, slotPage, slotTier, schedPages }) {
    const c = await load();
    if (!c.slotRel || !c.liveRel) { console.log(' ├─ ⚠️ 申込記録に「ライブ」「受付枠」のリレーション列がないため、行の自動作成をスキップします'); return 0; }
    let made = 0;
    const targets = schedPages.length ? schedPages : [null];   // 公演日程がまだ無いライブは、受付枠単位で1行
    for (const sp of targets) {
      for (const who of names) {
        const dup = c.pages.some(p => (p.properties[c.slotRel]?.relation || []).some(r => r.id === slotPage.id)
          && (!sp || !c.schedRel || (p.properties[c.schedRel]?.relation || []).some(r => r.id === sp.id))
          && propText(p.properties['申込者']) === who);
        const mk = `${slotPage.id}|${sp ? sp.id : '-'}|${who}`;
        if (dup || made_.has(mk)) continue;
        made_.add(mk);
        const day = sp ? propText(sp.properties['Day']) : '';
        const props = {};
        put(c.meta, props, titleName(c.meta), `${liveTitle}${day ? ' ' + day : ''} ${who}｜${slotTier}`);
        if (c.meta.properties['ライブ']?.type === 'rich_text') put(c.meta, props, 'ライブ', liveTitle);
        if (c.meta.properties['受付枠']?.type === 'rich_text') put(c.meta, props, '受付枠', slotTier);
        put(c.meta, props, c.liveRel, [live.id]); put(c.meta, props, c.slotRel, [slotPage.id]);
        if (sp && c.schedRel) put(c.meta, props, c.schedRel, [sp.id]);
        put(c.meta, props, '申込者', who); put(c.meta, props, '結果', '未申込'); put(c.meta, props, '枚数', defaultTickets);
        // Actionsのログは公開される場合があるため、申込者の名前はログに出さない
        if (dryRun) { console.log(` │ [DRY] 申込記録を作成: ${liveTitle} ${day}（申込者名はログに出しません）`); made++; continue; }
        const pg = await notion.pages.create({ parent: { database_id: appDbId }, properties: props });
        await sleep(gapMs);
        c.pages.push(pg); made++;
      }
    }
    if (made) console.log(` ├─ 📋 申込記録を${made}行、自動作成しました（結果は「未申込」）`);
    return made;
  }
  return { ensureRows };
}
module.exports = { create };

/* =====================================================================
 * index.js への組み込み（3か所。今は入れなくても、今の動作は変わりません）
 *
 * ① ファイルの先頭付近（const ENV = ... の下）に追加
 *      const appRows = require('./applications.js').create({
 *        notion, appDbId: process.env.NOTION_APPLICATION_DB_ID, applicants: process.env.APPLICANTS, dryRun: DRY });
 *
 * ② applyEvent の「受付枠」の処理で、新規作成した枠を覚えておく
 *      （「受付枠」のブロックの直前に）   let newSlot = null;
 *      （if (!existing) { ... } の中、W.create の直後に）  if (!pg.__dry) newSlot = { page: pg, tier };
 *
 * ③ applyEvent の「公演日程」のループの直後（「一覧表示用の列と、サイドピークを最新化」の直前）に追加
 *      if (appRows && newSlot) await appRows.ensureRows({
 *        live, liveTitle, slotPage: newSlot.page, slotTier: newSlot.tier, schedPages: schedPagesOfLive(live.id) });
 *
 * ④ GitHub Actions の env に追加
 *      NOTION_APPLICATION_DB_ID: ${{ secrets.NOTION_APPLICATION_DB_ID }}
 *      APPLICANTS: ${{ secrets.APPLICANTS }}      （例: ねこぷち,カッキ～）
 * ===================================================================== */
