'use strict';
/**
 * 過去のライブの取り込み（1回だけ使う道具）
 *
 * tools/past-lives.json（2023年以降の現地ライブ。アイマスDBを参考に作成）を、
 * 今のNotionの「ライブDB」と「公演日程DB」に追加する。
 *
 *   node tools/import-past.js           確認だけ（Notionには何も書かない）
 *   node tools/import-past.js --write   実際に追加する
 *
 * ・同じライブがすでにあれば（略称か正式名称が同じ、または初日が同じでブランドが重なる）、新しく作らない
 *   空欄の「正式名称」「会場」「都道府県」「セトリURL」だけ埋め、足りない公演の行を足す（公演の呼び名が違う行があるライブには、行を足さない）
 *   → 途中で止まっても、もう一度動かせば続きから入る（2回動かしても重複しない）
 * ・追加したライブと公演には「ロック」を付け、自動チェックが書き換えないようにする
 * ・公式サイトで確かめて直した公演（JSONに prevOpen / prevStart / prevKey があるもの）は、
 *   この道具が前に作った行のままなら、時刻・表示ラベル・公演の呼び名を新しい内容に直す（手で直した行には触らない）
 * ・公演日程DBに「セトリURL」、ライブDBに「都道府県」の列がなければ、--write のときに作る
 */
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const LIVE_DB = process.env.NOTION_DB_ID, SCHED_DB = process.env.NOTION_SCHEDULE_DB_ID;
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'past-lives.json'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(fn) {   // 呼び出し間隔の確保と、429 / 5xx の自動リトライ
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
const propText = p => !p ? '' : p.type === 'title' ? plain(p.title) : p.type === 'rich_text' ? plain(p.rich_text)
  : p.type === 'select' ? (p.select?.name || '') : p.type === 'url' ? (p.url || '') : '';
const rt = s => s ? [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] : [];
const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const titleName = meta => Object.entries(meta.properties).find(([, v]) => v.type === 'title')[0];
const relName = (meta, base) => meta.properties[base]?.type === 'relation' ? base : meta.properties[base + 'リンク']?.type === 'relation' ? base + 'リンク' : null;
const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** 列の種類に合わせて書き込み用の値を作る（ない列は黙って飛ばす） */
function put(meta, props, name, v) {
  const p = meta.properties[name];
  if (!p || v === undefined || v === '' || v === null) return false;
  switch (p.type) {
    case 'title': props[name] = { title: rt(v) }; break;
    case 'rich_text': props[name] = { rich_text: rt(v) }; break;
    case 'select': props[name] = { select: { name: v } }; break;
    case 'multi_select': props[name] = { multi_select: v.map(n => ({ name: n })) }; break;
    case 'url': props[name] = { url: v }; break;
    case 'checkbox': props[name] = { checkbox: !!v }; break;
    case 'number': props[name] = { number: v }; break;
    case 'date': props[name] = { date: typeof v === 'string' ? { start: v } : v }; break;
    case 'relation': props[name] = { relation: [].concat(v).map(id => ({ id })) }; break;
    default: return false;
  }
  return true;
}

/** 表示ラベル（例: 「Day1: 2023年1月14日(土) 開場15:30/開演17:30」）。ポータルはこの「:」より前を公演の呼び名にする */
function labelOf(d) {
  const [y, m, dd] = d.date.split('-').map(Number);
  const wd = WD[new Date(`${d.date}T00:00:00+09:00`).getDay()];
  const t = [d.open ? `開場${d.open.padStart(5, '0')}` : '', d.start ? `開演${d.start.padStart(5, '0')}` : ''].filter(Boolean).join('/');
  return `${d.key}: ${y}年${m}月${dd}日(${wd})${t ? ' ' + t : ''}`;
}

async function main() {
  if (!LIVE_DB || !SCHED_DB || !process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY・NOTION_DB_ID・NOTION_SCHEDULE_DB_ID が必要です（GitHubのSecrets）');
  console.log(WRITE ? '✍️  Notionに追加します' : '🔍 確認だけします（Notionには書き込みません。追加するときは「書き込む」にチェックして実行）');
  let liveMeta = await api(() => notion.databases.retrieve({ database_id: LIVE_DB }));
  let schedMeta = await api(() => notion.databases.retrieve({ database_id: SCHED_DB }));
  const rel = relName(schedMeta, 'ライブ');
  if (!rel) throw new Error('公演日程DBに、ライブへのリレーション列がありません');
  for (const [db, meta, cols] of [['ライブDB', liveMeta, ['ブランド', 'ライブ開催日', '会場', '正式名称', 'ロック']], ['公演日程DB', schedMeta, ['Day', '表示ラベル', '順番', '開演日時']]])
    for (const c of cols) if (!meta.properties[c]) console.log(`⚠️ ${db}に「${c}」の列がありません（この項目は入りません）`);

  // 足りない列を作る（--write のときだけ）
  const addCols = [];
  if (!schedMeta.properties['セトリURL']) addCols.push([SCHED_DB, '公演日程DB', 'セトリURL', { url: {} }]);
  if (!liveMeta.properties['都道府県']) addCols.push([LIVE_DB, 'ライブDB', '都道府県', { select: {} }]);
  for (const [id, db, name, def] of addCols) {
    console.log(`${WRITE ? '➕' : '（追加予定）'} ${db}に「${name}」の列を作ります`);
    if (WRITE) await api(() => notion.databases.update({ database_id: id, properties: { [name]: def } }));
  }
  if (!WRITE) for (const [id, , name, def] of addCols) (id === LIVE_DB ? liveMeta : schedMeta).properties[name] = { type: Object.keys(def)[0] };   // 確認のときも、作る予定の列があるものとして数える
  if (WRITE && addCols.length) {
    liveMeta = await api(() => notion.databases.retrieve({ database_id: LIVE_DB }));
    schedMeta = await api(() => notion.databases.retrieve({ database_id: SCHED_DB }));
  }

  // ブランドの選択肢の確認（ない名前は、書き込むとNotionが自動で選択肢を作る。表記ゆれに気づけるよう知らせる）
  const opts = (liveMeta.properties['ブランド']?.multi_select?.options || []).map(o => o.name);
  const newBrands = [...new Set(DATA.flatMap(l => l.brands))].filter(b => !opts.includes(b));
  if (newBrands.length) console.log(`⚠️ ブランドの選択肢にない名前: ${newBrands.join('、')}（このまま書き込むと、新しい選択肢として作られます。表記が今の選択肢と合っているか確認してください）`);

  const lives = await queryAll(LIVE_DB), scheds = await queryAll(SCHED_DB);
  const lt = titleName(liveMeta), stn = titleName(schedMeta);
  let newLives = 0, newRows = 0, skipped = 0, filled = 0, fixedRows = 0;
  const timeProps = (d, props) => {   // 表示ラベル・開演日時・開場時刻
    put(schedMeta, props, '表示ラベル', labelOf(d));
    put(schedMeta, props, '開演日時', d.start ? `${d.date}T${d.start.padStart(5, '0')}:00+09:00` : d.date);
    if (d.open) put(schedMeta, props, '開場時刻', schedMeta.properties['開場時刻']?.type === 'date' ? `${d.date}T${d.open.padStart(5, '0')}:00+09:00` : d.open.padStart(5, '0'));
  };
  const brandsOf = p => (p.properties['ブランド']?.multi_select || []).map(o => o.name);
  const startOf = p => (p.properties['ライブ開催日']?.date?.start || '').slice(0, 10);
  const fill = async (meta, page, name, v, what) => {   // 空欄のときだけ書く
    if (!v || !meta.properties[name] || propText(page.properties[name])) return;
    const props = {}; if (!put(meta, props, name, v)) return;
    filled++; console.log(`${WRITE ? '✏️' : '（補完予定）'} ${what}: 「${name}」を入れます`);
    if (WRITE) Object.assign(page, await api(() => notion.pages.update({ page_id: page.id, properties: props })));
  };
  for (const L of DATA) {
    let live = lives.find(p => [norm(L.title), norm(L.fullName)].includes(norm(propText(p.properties[lt]))) || (L.fullName && norm(propText(p.properties['正式名称'])) === norm(L.fullName)))
      || lives.find(p => startOf(p) === L.dateStart && brandsOf(p).some(b => L.brands.includes(b)));
    const existed = !!live;
    if (existed) {
      skipped++;
      const name = propText(live.properties[lt]);
      console.log(`🔁 登録済み: ${L.dateStart} ${L.title}${norm(name) !== norm(L.title) ? `（Notionでは『${name}』）` : ''}`);
      for (const [col, v] of [['正式名称', L.fullName], ['会場', L.venue], ['都道府県', L.prefecture]]) await fill(liveMeta, live, col, v, name);
    } else {
      const props = {};
      put(liveMeta, props, lt, L.title);
      put(liveMeta, props, 'ブランド', L.brands);
      put(liveMeta, props, 'ライブ開催日', L.dateEnd !== L.dateStart ? { start: L.dateStart, end: L.dateEnd } : { start: L.dateStart });
      put(liveMeta, props, '正式名称', L.fullName);
      put(liveMeta, props, '会場', L.venue);
      put(liveMeta, props, '都道府県', L.prefecture);
      put(liveMeta, props, '地図URL', `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(L.venue)}`);
      put(liveMeta, props, 'アクセスURL', `https://www.google.com/search?q=${encodeURIComponent(L.venue + ' 公式 アクセス')}`);
      if (L.xr) put(liveMeta, props, 'XR', true);
      put(liveMeta, props, 'ロック', true);
      newLives++;
      console.log(`${WRITE ? '⭐' : '（追加予定）'} ${L.dateStart} ${L.title}（${L.days.length}公演 / ${L.venue}）`);
      if (WRITE) { live = await api(() => notion.pages.create({ parent: { database_id: LIVE_DB }, icon: { type: 'emoji', emoji: '🎤' }, properties: props })); lives.push(live); }
    }
    const rows = live ? scheds.filter(p => (p.properties[rel]?.relation || []).some(r => r.id === live.id)) : [];
    const keys = L.days.map(d => norm(d.key)), keyOf = p => norm(propText(p.properties['Day']));
    // 前に取り込んだ行を、公式サイトで確かめた内容に直す（この道具が作ったときのラベルのままの行だけ）
    for (const d of L.days) {
      if (d.prevOpen === undefined && !d.prevKey) continue;
      const oldKey = d.prevKey || d.key, oldLabel = labelOf({ ...d, key: oldKey, open: d.prevOpen ?? d.open, start: d.prevStart ?? d.start });
      const row = rows.find(p => keyOf(p) === norm(oldKey) && propText(p.properties['表示ラベル']) === oldLabel);
      if (!row || (d.prevKey && rows.some(p => keyOf(p) === norm(d.key)))) continue;
      const props = {};
      if (d.prevKey) { put(schedMeta, props, stn, `${L.title} ${d.key}`); put(schedMeta, props, 'Day', d.key); }
      timeProps(d, props);
      fixedRows++;
      console.log(`${WRITE ? '🕒' : '（修正予定）'} ${L.title} ${oldKey}${d.prevKey ? ` → ${d.key}` : ''}: ${d.prevOpen || '—'}/${d.prevStart || '—'} → ${d.open || '—'}/${d.start || '—'}`);
      if (WRITE) Object.assign(row, await api(() => notion.pages.update({ page_id: row.id, properties: props })));
      else row.properties['Day'] = { type: 'rich_text', rich_text: [{ plain_text: d.key }] };   // 確認のときも、直したあとの呼び名として数える
    }
    for (const d of L.days) { const row = rows.find(p => keyOf(p) === norm(d.key)); if (row) await fill(schedMeta, row, 'セトリURL', d.setlistUrl, `${L.title} ${d.key}`); }
    const odd = rows.filter(p => !keys.includes(keyOf(p)));
    if (odd.length) { console.log(`　⚠️ ${L.title}: 公演の呼び名が違う行（${odd.map(p => propText(p.properties['Day']) || '空欄').join('、')}）があるため、公演の行は足しません`); continue; }
    for (const [i, d] of L.days.entries()) {
      if (rows.some(p => keyOf(p) === norm(d.key))) continue;
      const props = {};
      put(schedMeta, props, stn, `${L.title} ${d.key}`);
      if (live) put(schedMeta, props, rel, [live.id]);
      put(schedMeta, props, 'Day', d.key);
      put(schedMeta, props, '順番', i + 1);
      put(schedMeta, props, '公演名', d.name);
      timeProps(d, props);
      put(schedMeta, props, 'セトリURL', d.setlistUrl);
      put(schedMeta, props, 'ロック', true);
      newRows++;
      if (existed) console.log(`${WRITE ? '📅' : '（追加予定）'} ${L.title}: 公演「${d.key}」`);
      if (WRITE) { const pg = await api(() => notion.pages.create({ parent: { database_id: SCHED_DB }, properties: props })); scheds.push(pg); }
    }
  }
  console.log(`\n${WRITE ? '✅ 追加しました' : '🔍 確認の結果'}: 新しいライブ ${newLives}件・公演 ${newRows}行${skipped ? ` / 登録済みのライブ ${skipped}件` : ''}${filled ? ` / 空欄の補完 ${filled}か所` : ''}${fixedRows ? ` / 時刻などの修正 ${fixedRows}行` : ''}`);
  if (WRITE && (newLives || newRows || filled || fixedRows)) console.log('このあと events.json を作り直すので、ポータルにも反映されます');
}
main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
