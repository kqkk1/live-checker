'use strict';
/**
 * 旧ライブDBの本文（サイドピーク）から、新構成へ移行するスクリプト。
 *
 *   node migrate.js                      … ドライラン（読み取りのみ。何も書き込まない）
 *   node migrate.js --apply              … 実際に書き込む
 *   node migrate.js --only=リフラク      … 名前に含まれる文字で対象を絞る（最初の試運転用）
 *
 * やること
 *  1. ライブDBに足りない列を追加（会場・最寄り駅・各種URL・特別カラー・ロック・最終自動更新）
 *  2. 公演日程DBを作成（NOTION_SCHEDULE_DB_ID が未設定のとき。作成先は NOTION_PARENT_PAGE_ID）
 *  3. 各ライブの本文を読み、ライブDBの空欄を埋め、公演日程の行を作成（ロック済みのライブは触らない）
 *  4. 申込記録に「公演」列を追加し、ライブ + Day で紐づけ
 *  0. （最初に実行）CSVから取り込んだ「ライブ」「受付枠」のテキスト列を、名前の一致でリレーションに変換
 *     → 元のテキスト列は消さずに残し、新しく「〇〇リンク」というリレーション列を作る（手で型変換しなくてよい）
 *
 * 環境変数
 *  NOTION_API_KEY / NOTION_DB_ID（ライブ） / NOTION_APPLICATION_DB_ID（申込記録）
 *  NOTION_SLOT_DB_ID（受付枠） / NOTION_LOG_DB_ID（取得ログ）  … テキストの列をリレーションに変換するために使用
 *  NOTION_SCHEDULE_DB_ID（任意） / NOTION_PARENT_PAGE_ID（公演日程DBを作るとき必須）
 */
const { Client } = require('@notionhq/client');

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const E = {
  live: process.env.NOTION_DB_ID,
  app: process.env.NOTION_APPLICATION_DB_ID,
  sched: process.env.NOTION_SCHEDULE_DB_ID,
  parent: process.env.NOTION_PARENT_PAGE_ID,
  slot: process.env.NOTION_SLOT_DB_ID,
  log: process.env.NOTION_LOG_DB_ID,
};
const notion = new Client({ auth: process.env.NOTION_API_KEY });

/* ---------- 共通 ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(fn) {   // 呼び出し間隔の確保と、429/5xx の自動リトライ
  for (let i = 0; i < 5; i++) {
    try { const r = await fn(); await sleep(350); return r; }
    catch (e) {
      if ((e.status === 429 || e.status >= 500 || e.code === 'rate_limited') && i < 4) { await sleep((i + 1) * 3000); continue; }
      throw e;
    }
  }
}
async function queryAll(dbId) {
  const out = []; let cursor;
  do {
    const r = await api(() => notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 }));
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}
const plain = (arr = []) => arr.map(t => t.plain_text).join('').trim();
const propText = p => !p ? '' : p.type === 'title' ? plain(p.title) : p.type === 'rich_text' ? plain(p.rich_text) : p.type === 'select' ? (p.select?.name || '') : '';
const rt = s => s ? [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] : [];

/* ---------- 解析（純粋関数） ---------- */
const dkey = label => (String(label).split(/[:：]/)[0] || '').trim();   // Pagesの公演キーと同じ規則

function inferYear(m, d, anchorIso) {
  const a = Date.parse(anchorIso.slice(0, 10) + 'T00:00:00Z'), y0 = new Date(a).getUTCFullYear();
  let best = y0, bd = Infinity;
  for (const y of [y0 - 1, y0, y0 + 1]) { const diff = Math.abs(Date.UTC(y, m - 1, d) - a); if (diff < bd) { best = y; bd = diff; } }
  return best;
}
function parseLabelDate(label, anchorIso) {
  const pad = n => String(n).padStart(2, '0');
  let y, m, d;
  const full = label.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (full) { y = +full[1]; m = +full[2]; d = +full[3]; }
  else {
    const md = label.match(/(\d{1,2})月\s*(\d{1,2})日/);
    if (!md) return null;
    m = +md[1]; d = +md[2]; y = anchorIso ? inferYear(m, d, anchorIso) : new Date().getFullYear();
  }
  const date = `${y}-${pad(m)}-${pad(d)}`;
  const st = label.match(/開演\s*(\d{1,2}):(\d{2})/), op = label.match(/開場\s*(\d{1,2}):(\d{2})/);
  return { date, start: st ? `${date}T${pad(+st[1])}:${st[2]}:00+09:00` : date, open: op ? `${pad(+op[1])}:${op[2]}` : '' };
}
function castFromUrl(url) {
  try { const u = new URL(url); return (u.searchParams.get('auto_cast') || u.searchParams.get('cast') || '').split(',').map(s => s.trim()).filter(Boolean); }
  catch (e) { return []; }
}

/* ---------- 本文の読み取り ---------- */
async function readBody(pageId) {
  const out = { venue: '', station: '', mapUrl: '', accessUrl: '', officialUrl: '', fullName: '', special: false, schedules: [] };
  const res = await api(() => notion.blocks.children.list({ block_id: pageId, page_size: 100 }));
  for (const b of res.results) {
    if (b.type === 'callout') {
      const rts = b.callout.rich_text || [], text = plain(rts);
      const links = rts.filter(t => t.href).map(t => ({ text: t.plain_text, href: t.href }));
      if (text.includes('会場：') || b.callout.icon?.emoji === '🏟️') {
        const lines = text.split('\n');
        out.venue = (lines.find(l => l.includes('会場：')) || lines[0] || '').replace(/.*会場：/, '').replace(/\(🗺️.*$/, '').replace(/｜.*$/, '').trim();
        const st = lines.find(l => l.includes('最寄り駅：')); if (st) out.station = st.replace(/.*最寄り駅：/, '').trim();
        const m = links.find(l => l.text.includes('マップ') || l.href.includes('maps')), a = links.find(l => l.text.includes('アクセス') || l.href.includes('search'));
        if (m) out.mapUrl = m.href; if (a) out.accessUrl = a.href;
      } else if (!out.officialUrl && links.length) {
        out.officialUrl = links[0].href;
        out.fullName = text.replace(/\s*[（(]イベント公式サイトへ[）)]\s*$/, '').trim();
      }
    } else if (b.type === 'bulleted_list_item') {
      const rts = b.bulleted_list_item.rich_text || [], full = plain(rts);
      const label = full.split('\n')[0] || full;
      const hrefs = rts.filter(t => t.href).map(t => t.href);
      if (b.has_children) {
        const ch = await api(() => notion.blocks.children.list({ block_id: b.id }));
        for (const c of ch.results) (c.paragraph?.rich_text || []).forEach(t => { if (t.href) hrefs.push(t.href); });
      }
      const pen = hrefs.find(u => u.includes('penlight-supporter')) || '';
      if (pen.includes('special=1')) out.special = true;
      out.schedules.push({ label, cast: castFromUrl(pen) });
    }
  }
  return out;
}

/* ---------- テキスト列 → リレーション（名前の一致で紐づけ） ---------- */
const planned = new Map();   // ドライランで「紐づけ予定」の記録（行ID|列名 → 紐づけ先ID）
const relOf = (page, base) => {   // リレーション化済みの列、または「〇〇リンク」列から、紐づけ先のIDを取る
  const p = page.properties[base];
  if (p && p.type === 'relation') return p.relation?.[0]?.id;
  return page.properties[base + 'リンク']?.relation?.[0]?.id || planned.get(`${page.id}|${base}`);
};
async function linkByTitle(dbId, base, targetDbId, label, warns) {
  if (!dbId || !targetDbId) { console.log(`  ${label}: DBのIDが未設定のためスキップ`); return; }
  const meta = await api(() => notion.databases.retrieve({ database_id: dbId }));
  const prop = meta.properties[base];
  if (!prop) { warns.push(`${label}: 「${base}」列が見つかりません`); return; }
  if (prop.type === 'relation') { console.log(`  ${label}: 「${base}」は既にリレーションです`); return; }
  const linkName = base + 'リンク';
  if (!meta.properties[linkName]) {
    console.log(`  ${label}: 「${linkName}」（リレーション）列を追加します`);
    if (APPLY) await api(() => notion.databases.update({ database_id: dbId, properties: { [linkName]: { relation: { database_id: targetDbId, type: 'single_property', single_property: {} } } } }));
  }
  const tmeta = await api(() => notion.databases.retrieve({ database_id: targetDbId }));
  const tTitle = Object.entries(tmeta.properties).find(([, v]) => v.type === 'title')[0];
  const byTitle = new Map((await queryAll(targetDbId)).map(pg => [propText(pg.properties[tTitle]), pg.id]).filter(([t]) => t));
  let ok = 0, miss = 0;
  for (const row of await queryAll(dbId)) {
    const txt = propText(row.properties[base]);
    if (!txt || row.properties[linkName]?.relation?.length) continue;
    const id = byTitle.get(txt);
    if (!id) { miss++; warns.push(`${label}「${propText(Object.values(row.properties).find(v => v.type === 'title'))}」: ${base}「${txt}」に一致するページがありません`); continue; }
    ok++; planned.set(`${row.id}|${base}`, id);
    if (APPLY) await api(() => notion.pages.update({ page_id: row.id, properties: { [linkName]: { relation: [{ id }] } } }));
  }
  console.log(`  ${label}: 「${base}」→ 一致 ${ok}件 / 不一致 ${miss}件`);
}

/* ---------- スキーマ ---------- */
const LIVE_PROPS = {
  '正式名称': { rich_text: {} }, '会場': { rich_text: {} }, '最寄り駅': { rich_text: {} },
  '地図URL': { url: {} }, 'アクセスURL': { url: {} }, '公式URL': { url: {} },
  '特別カラー': { checkbox: {} }, 'ロック': { checkbox: {} }, '最終自動更新': { date: {} },
};
async function ensureProps(dbId, wanted, label) {
  const meta = await api(() => notion.databases.retrieve({ database_id: dbId }));
  const missing = Object.fromEntries(Object.entries(wanted).filter(([k]) => !meta.properties[k]));
  const names = Object.keys(missing);
  if (!names.length) { console.log(`  ${label}: 追加する列はありません`); return meta; }
  console.log(`  ${label}: 追加する列 → ${names.join(', ')}`);
  if (APPLY) await api(() => notion.databases.update({ database_id: dbId, properties: missing }));
  return meta;
}

/* ---------- 本体 ---------- */
async function main() {
  for (const k of ['NOTION_API_KEY']) if (!process.env[k]) throw new Error(`${k} が未設定です`);
  if (!E.live) throw new Error('NOTION_DB_ID（ライブDB）が未設定です');
  console.log(APPLY ? '【実行モード】Notionに書き込みます' : '【ドライラン】読み取りのみ。書き込みは行いません');
  if (ONLY) console.log(`対象を絞り込み: 「${ONLY}」を含むライブのみ`);
  const warns = [];

  console.log('\n⓪ テキストの列をリレーションに変換（名前の一致で紐づけ）');
  await linkByTitle(E.slot, 'ライブ', E.live, '受付枠', warns);
  await linkByTitle(E.app, 'ライブ', E.live, '申込記録', warns);
  await linkByTitle(E.app, '受付枠', E.slot, '申込記録', warns);
  await linkByTitle(E.log, 'ライブ', E.live, '取得ログ', warns);

  console.log('\n① ライブDBの列を確認');
  const liveMeta = await ensureProps(E.live, LIVE_PROPS, 'ライブ');
  const titleName = Object.entries(liveMeta.properties).find(([, v]) => v.type === 'title')[0];

  console.log('\n② 公演日程DBを確認');
  let schedId = E.sched;
  if (!schedId && E.parent) {   // 二重作成の防止：作成先ページに「公演日程」DBが既にあれば、それを使う
    const kids = await api(() => notion.blocks.children.list({ block_id: E.parent, page_size: 100 }));
    const found = kids.results.find(x => x.type === 'child_database' && x.child_database?.title === '公演日程');
    if (found) { schedId = found.id; console.log(`  既存の「公演日程」DBを使います（ID: ${schedId}）`); }
  }
  if (!schedId) {
    if (!E.parent) {
      if (APPLY) throw new Error('公演日程DBを作るには NOTION_PARENT_PAGE_ID が必要です');
      warns.push('NOTION_PARENT_PAGE_ID が未設定です。実行(--apply)の前に、公演日程DBを作るページのIDを設定してください');
    }
    console.log('  公演日程DBを新規作成します');
    if (APPLY) {
      const db = await api(() => notion.databases.create({
        parent: { type: 'page_id', page_id: E.parent },
        title: [{ type: 'text', text: { content: '公演日程' } }],
        properties: {
          '名前': { title: {} },
          'ライブ': { relation: { database_id: E.live, type: 'dual_property', dual_property: {} } },
          'Day': { rich_text: {} }, '開演日時': { date: {} }, '開場時刻': { rich_text: {} },
          '出演者': { rich_text: {} }, '順番': { number: {} }, '表示ラベル': { rich_text: {} },
        },
      }));
      schedId = db.id;
      console.log(`  作成しました。次回のために NOTION_SCHEDULE_DB_ID=${schedId} を設定してください`);
      try {
        await api(() => notion.databases.update({ database_id: schedId, properties: { '出演者数': { formula: { expression: 'if(empty(prop("出演者")), 0, prop("出演者").split(",").length())' } } } }));
      } catch (e) { warns.push('「出演者数」の数式は自動作成できませんでした。手で追加してください（式は手順書に記載）'); }
    }
  }
  const schedMap = new Map();   // `${liveId}|${key}` -> pageId（ドライランでは仮ID）
  if (schedId) for (const p of await queryAll(schedId)) {
    const lid = p.properties['ライブ']?.relation?.[0]?.id, k = propText(p.properties['Day']);
    if (lid && k) schedMap.set(`${lid}|${k}`, p.id);
  }

  console.log('\n③ 各ライブの本文を読み取り');
  const all = (await queryAll(E.live)).filter(p => propText(p.properties[titleName]));
  const targets = all.filter(p => !ONLY || propText(p.properties[titleName]).includes(ONLY));
  const touched = new Set();
  let createdRows = 0, filledLive = 0;
  for (const p of targets) {
    const title = propText(p.properties[titleName]);
    if (p.properties['ロック']?.checkbox) { console.log(`- ${title}: ロック中のためスキップ`); continue; }
    touched.add(p.id);
    const body = await readBody(p.id);
    const dr = p.properties['ライブ開催日']?.date, ls = dr?.start || '', le = dr?.end || ls;

    // ライブ本体：空欄だけ埋める
    const set = {}, cur = p.properties;
    const fill = (name, val, type) => {
      if (!val) return; const c = cur[name];
      if (c && ((type === 'rich_text' && plain(c.rich_text)) || (type === 'url' && c.url))) return;
      set[name] = type === 'rich_text' ? { rich_text: rt(val) } : { url: val };
    };
    fill('正式名称', body.fullName, 'rich_text'); fill('会場', body.venue, 'rich_text'); fill('最寄り駅', body.station, 'rich_text');
    fill('地図URL', body.mapUrl, 'url'); fill('アクセスURL', body.accessUrl, 'url'); fill('公式URL', body.officialUrl, 'url');
    if (body.special && !cur['特別カラー']?.checkbox) set['特別カラー'] = { checkbox: true };
    set['最終自動更新'] = { date: { start: new Date().toISOString() } };
    console.log(`- ${title}: 会場=${body.venue || '(なし)'} / 公演 ${body.schedules.length}件 / 本体の更新項目 ${Object.keys(set).length - 1}`);
    if (APPLY) await api(() => notion.pages.update({ page_id: p.id, properties: set }));
    filledLive++;

    // 公演日程の行
    const seen = {};
    for (let i = 0; i < body.schedules.length; i++) {
      const s = body.schedules[i];
      let key = dkey(s.label) || `公演${i + 1}`; if (seen[key]) key += `#${i + 1}`; seen[key] = 1;
      const d = parseLabelDate(s.label, ls);
      if (d && ls && (d.date < ls.slice(0, 10) || d.date > le.slice(0, 10))) {
        const dayMs = 864e5, t = Date.parse(d.date + 'T00:00:00Z');
        if (t < Date.parse(ls.slice(0, 10) + 'T00:00:00Z') - dayMs || t > Date.parse(le.slice(0, 10) + 'T00:00:00Z') + dayMs)
          warns.push(`${title} / ${key}: 公演日(${d.date})がライブ開催日(${ls.slice(0, 10)}〜${le.slice(0, 10)})の範囲外です。Notionの値を確認してください`);
      }
      if (!d) warns.push(`${title} / ${key}: 公演日を読み取れませんでした（ラベル: ${s.label}）`);
      const mk = `${p.id}|${key}`;
      if (schedMap.has(mk)) continue;   // 既にある行は触らない（何度実行しても重複しない）
      createdRows++;
      if (APPLY && schedId) {
        const props = {
          '名前': { title: rt(`${title} ${key}`) }, 'ライブ': { relation: [{ id: p.id }] }, 'Day': { rich_text: rt(key) },
          '出演者': { rich_text: rt(s.cast.join(',')) }, '順番': { number: i + 1 }, '表示ラベル': { rich_text: rt(s.label) },
        };
        if (d) props['開演日時'] = { date: d.start.includes('T') ? { start: d.start, time_zone: 'Asia/Tokyo' } : { start: d.start } };
        if (d?.open) props['開場時刻'] = { rich_text: rt(d.open) };
        const page = await api(() => notion.pages.create({ parent: { database_id: schedId }, properties: props }));
        schedMap.set(mk, page.id);
      } else schedMap.set(mk, `(仮)${mk}`);
    }
  }

  console.log('\n④ 申込記録を公演日程に紐づけ');
  let linked = 0;
  if (E.app) {
    if (APPLY && schedId) await ensureProps(E.app, { '公演': { relation: { database_id: schedId, type: 'single_property', single_property: {} } } }, '申込記録');
    else console.log('  申込記録: 「公演」列（リレーション）を追加予定');
    for (const a of await queryAll(E.app)) {
      const lid = relOf(a, 'ライブ'), day = propText(a.properties['Day']), nm = propText(a.properties['名前']);
      if (!lid) { warns.push(`申込記録「${nm}」: ライブが紐づいていません（ライブ名がライブDBと一致しているか確認してください）`); continue; }
      if (!touched.has(lid)) continue;
      if (a.properties['公演']?.relation?.length) continue;
      const exact = schedMap.get(`${lid}|${day}`);
      const loose = [...schedMap.entries()].filter(([k]) => k.startsWith(`${lid}|${day} `));
      const id = exact || (loose.length === 1 ? loose[0][1] : null);
      if (!id) { warns.push(`申込記録「${nm}」: ${day} に一致する公演が${loose.length > 1 ? '複数あり（昼夜など）' : 'ありません'}。手で選んでください`); continue; }
      linked++;
      if (APPLY && schedId) await api(() => notion.pages.update({ page_id: a.id, properties: { '公演': { relation: [{ id }] } } }));
    }
  } else console.log('  NOTION_APPLICATION_DB_ID が未設定のためスキップ');

  console.log('\n========== 結果 ==========');
  console.log(`対象ライブ: ${filledLive}件 / 公演日程の新規行: ${createdRows}件 / 申込記録の紐づけ: ${linked}件`);
  if (warns.length) { console.log(`\n⚠️ 確認が必要な点 (${warns.length}件)`); warns.forEach(w => console.log(' - ' + w)); }
  if (!APPLY) console.log('\n※ドライランです。内容を確認して問題なければ --apply を付けて実行してください');
}

module.exports = { dkey, inferYear, parseLabelDate, castFromUrl };
if (require.main === module) main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
