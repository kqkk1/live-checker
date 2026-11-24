'use strict';
/**
 * 終わった公演の「出演者」の取り込み（1回だけ使う道具。足りない分を埋めたいときは何度動かしてもよい）
 *
 * 公演日程DBの「セトリURL」（アイマスDBの公演ページ）を開き、「出演」欄に並んでいる声優名を、
 * アイマスDBの「関連声優の一覧」（https://imas-db.jp/misc/cv.html）でアイドル名に置き換えて、
 * 空欄の「出演者」に書き込む。AI（Gemini）は使わない。
 *
 *   node tools/import-cast.js           確認だけ（Notionには何も書かない）
 *   node tools/import-cast.js --write   実際に書き込む
 *
 * ・書き込むのは「出演者」が空欄の行だけ（手で入れた出演者や、チェッカーが入れた出演者には触らない）
 * ・対象は、ライブが終わっていて、開催日が CAST_FROM（初期値 2025-01-01）以降のもの
 * ・アイドル名は、ペンライトの色データ（colors.json）にある名前に合わせる。色データにない名前は書かない
 *   同じ声優が複数のアイドルを担当している場合は、そのライブのブランドのアイドルだけを使う
 * ・対応が見つからなかった名前は、ログに出す（ユニット名などは除く）
 */
const fs = require('fs');

const WRITE = process.argv.includes('--write');
const FROM = (process.env.CAST_FROM || '2025-01-01').trim();
const LIVE_DB = process.env.NOTION_DB_ID, SCHED_DB = process.env.NOTION_SCHEDULE_DB_ID;
const CV_URL = 'https://imas-db.jp/misc/cv.html';
const COLORS_URLS = [
  'https://raw.githubusercontent.com/kqkk1/penlight-assistant/main/penlight-assistant/data/colors.json',
  'https://cdn.jsdelivr.net/gh/kqkk1/penlight-assistant@main/penlight-assistant/data/colors.json',
];
const GAP_MS = Number(process.env.CAST_GAP_MS ?? 1500);   // アイマスDBへの負担を減らすため、ページを開く間隔をあける

const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = s => String(s || '').normalize('NFKC').replace(/[\s・=＝･.．]/g, '').toLowerCase();   // 名前を比べるための形（空白・中黒・イコールの違いを無視）
const stripParen = s => String(s || '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();

/* ---------- HTML の読み取り（ページの細かい作りに依存しないよう、タグを外した文字で扱う） ---------- */
function decode(s) {
  return String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)));
}
const textOf = html => decode(String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(li|ul|ol|p|div|tr|td|th|dt|dd|h[1-6])[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));
const linesOf = html => textOf(html).split('\n').map(l => l.trim()).filter(Boolean);

/** 関連声優の一覧（cv.html）から「声優名 → 担当キャラ名の一覧」を作る */
function parseCvPage(html) {
  const map = new Map();   // key(声優名) → { name, chars: Set }
  for (const row of String(html).match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(c => textOf(c).replace(/\s+/g, ' ').trim());
    if (cells.length < 2 || cells[0] === '名前') continue;
    const va = stripParen(cells[0]);
    const chars = cells[1].split(/[,、，]/).map(stripParen).filter(Boolean);
    if (!va || !chars.length) continue;
    const k = key(va), cur = map.get(k) || { name: va, chars: new Set() };
    chars.forEach(c => cur.chars.add(c));
    map.set(k, cur);
  }
  return map;
}

/** 公演ページの「出演」欄の部分（見つからなければ null） */
function castSection(html) {
  const src = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const re = /<(h[1-6]|dt|th|p|strong|b|div|span)(\s[^>]*)?>\s*(?:<[^>]+>\s*)*出演(?:者)?(?:\s*[（(][^)）<]*[)）])?\s*[:：]?\s*(?:<\/[^>]+>\s*)*<\/\1>/i;
  const m = re.exec(src);
  if (!m) return null;
  const tag = m[1].toLowerCase(), start = m.index + m[0].length;
  const rest = src.slice(start);
  const stops = [new RegExp(`<${tag}[\\s>]`, 'i'), /<h[1-6][\s>]/i].map(r => { const x = r.exec(rest); return x ? x.index : -1; }).filter(i => i >= 0);
  const end = stops.length ? Math.min(...stops) : Math.min(rest.length, 20000);
  return rest.slice(0, end);
}

/** 「出演」欄がないページ（xRライブ・LPなど）用: 「公演概要」の節。公演ごとの小見出し（昼公演・夕方公演・DAY1 など）があれば、label に合う小見出しの分だけ返す */
function overviewSection(html, label) {
  const src = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const hs = []; const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi; let m;
  while ((m = re.exec(src))) hs.push({ level: Number(m[1]), text: textOf(m[2]).replace(/\s+/g, ' ').trim(), start: m.index, end: m.index + m[0].length });
  const i = hs.findIndex(h => /公演概要/.test(h.text));
  if (i < 0) return null;
  const top = hs[i], next = hs.slice(i + 1).find(h => h.level <= top.level);
  const body = src.slice(top.end, next ? next.start : src.length);
  const subs = hs.slice(i + 1).filter(h => (!next || h.start < next.start) && h.level > top.level).map((h, j, arr) => {
    const after = hs.slice(hs.indexOf(h) + 1).find(x => x.level <= h.level);
    return { title: h.text, html: src.slice(h.end, after ? after.start : (next ? next.start : src.length)) };
  });
  if (!subs.length || !label) return body;
  const name = String(label).split(/[:：]/)[0].normalize('NFKC').toUpperCase();
  const day = (name.match(/DAY\s*(\d+)/) || [])[1], part = (name.match(/[朝昼夕夜]/) || [])[0];
  const fit = subs.map(x => { const t = x.title.normalize('NFKC').toUpperCase(); const d = day && new RegExp(`DAY\\s*${day}(?!\\d)`).test(t), p = part && t.includes(part); return { x, score: (d ? 1 : 0) + (p ? 1 : 0), bad: (day && /DAY\s*\d/.test(t) && !d) || (part && /[朝昼夕夜]/.test(t) && !p) }; })
    .filter(f => f.score > 0 && !f.bad).sort((a, b) => b.score - a.score);
  return fit.length ? fit[0].x.html : body;
}
/** VTR出演など、会場に出ていない人の行を外す */
function dropOffstage(lines) {
  const out = []; let skip = false;
  for (const l of lines) {
    if (/VTR|映像出演|声のみ|声の出演/.test(l)) { skip = true; continue; }
    if (/メンバー|出演|ゲスト/.test(l)) { skip = false; continue; }
    if (!skip) out.push(l);
  }
  return out;
}

/* ---------- 色データ（colors.json）から、アイドル名の一覧を作る ---------- */
const BRAND_SHEETS = { 'デレマス': ['デレマス'], 'ミリオン': ['ミリオン'], 'シャニマス': ['シャニマス'], 'SideM': ['SideM'], '765AS': ['765AS'], '学マス': ['学マス'], 'ヴイアラ': ['876'], '876': ['876'], '961': ['その他'] };
function buildIdols(colors) {
  const items = colors && colors.items ? colors.items : {};
  const idols = [];   // { name, sheet, keys: [...] }
  for (const [sheet, rows] of Object.entries(items)) for (const r of rows || []) {
    if (!r || r.role !== 'idol' || !r.n) continue;
    const parts = String(r.n).split(/[・]/).length > 1 && /^双海/.test(r.n) ? String(r.n).split('・') : [r.n];   // 「双海亜美・双海真美」は、どちらの名前でもこの1行に当てる
    idols.push({ name: r.n, sheet, keys: [...new Set([r.n, ...parts].map(key))] });
  }
  const units = new Set();
  for (const rows of Object.values(items)) for (const r of rows || []) if (r && r.role !== 'idol' && r.n) units.add(key(r.n));
  return { idols, units };
}

/** 「出演」欄の行から、アイドル名を取り出す。brands はそのライブのブランド（空なら全ブランド） */
function matchCast(lines, cv, idolData, brands) {
  const sheets = new Set((brands || []).flatMap(b => BRAND_SHEETS[b] || []));
  const pool = idolData.idols.filter(i => !sheets.size || sheets.has(i.sheet));
  const byKey = new Map(); for (const i of pool) for (const k of i.keys) if (!byKey.has(k)) byKey.set(k, i);
  const anyKey = new Map(); for (const i of idolData.idols) for (const k of i.keys) if (!anyKey.has(k)) anyKey.set(k, i);
  const found = [], unknown = [];
  const otherChars = new Set([...cv.values()].flatMap(v => [...v.chars].map(key)));   // 声優一覧にあるアイドル以外のキャラ（社長・スタッフなど）
  const add = n => { if (!found.includes(n)) found.push(n); };
  for (const raw of lines.flatMap(l => String(l).split(/[、,，\/／]/))) {
    const t = stripParen(raw).replace(/^[・\-*●○◆■□▼▽]+/, '').trim();
    if (!t || t.length > 30) continue;
    const k = key(t);
    if (idolData.units.has(k)) continue;   // ユニット名・ブランド名
    if (byKey.has(k)) { add(byKey.get(k).name); continue; }   // アイドル名がそのまま書かれている（vα-liv・xRライブなど）
    if (otherChars.has(k) && !anyKey.has(k)) continue;   // 社長・スタッフなど、アイドル以外のキャラ
    const va = cv.get(k);
    if (va) {
      const hits = [...va.chars].map(c => byKey.get(key(c))).filter(Boolean);
      if (hits.length) { hits.forEach(h => add(h.name)); continue; }
      const other = [...va.chars].map(c => anyKey.get(key(c))).filter(Boolean);
      if (other.length && !sheets.size) { other.forEach(h => add(h.name)); continue; }
      unknown.push(`${t}（${[...va.chars].join('・')}）`);   // 声優は分かったが、このライブのブランドのアイドルではない
      continue;
    }
    if (/^[^\s]{2,12}$/.test(t) && !/[!！?？:：「」『』【】\d０-９]/.test(t) && !/(公演|日時|会場|開場|開演|メンバー)$/.test(t)) unknown.push(t);
  }
  return { found, unknown };
}

module.exports = { parseCvPage, castSection, overviewSection, dropOffstage, linesOf, buildIdols, matchCast, key };

/* ---------- ここから実行部分 ---------- */
async function getText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'imas-live-portal cast importer (https://kqkk1.github.io/live-checker/)' } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (e) { /* 次の試行へ */ }
    await sleep((i + 1) * 3000);
  }
  return null;
}

async function main() {
  const { Client } = require('@notionhq/client');
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  async function api(fn) {
    for (let i = 0; i < 5; i++) {
      try { const r = await fn(); await sleep(350); return r; }
      catch (e) { if ((e.status === 429 || e.status >= 500 || e.code === 'rate_limited') && i < 4) { await sleep((i + 1) * 3000); continue; } throw e; }
    }
  }
  async function queryAll(dbId) {
    const out = []; let cursor;
    do { const r = await api(() => notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 })); out.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined; } while (cursor);
    return out;
  }
  const plain = (arr = []) => arr.map(t => t.plain_text).join('').trim();
  const propText = p => !p ? '' : p.type === 'title' ? plain(p.title) : p.type === 'rich_text' ? plain(p.rich_text) : p.type === 'url' ? (p.url || '') : p.type === 'select' ? (p.select?.name || '') : '';
  const rel = (p, name) => (p.properties[name]?.relation || []).map(r => r.id);

  if (!LIVE_DB || !SCHED_DB || !process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY・NOTION_DB_ID・NOTION_SCHEDULE_DB_ID が必要です（GitHubのSecrets）');
  console.log(WRITE ? '✍️  空欄の「出演者」に書き込みます' : '🔍 確認だけします（Notionには書き込みません。書き込むときは「書き込む」にチェックして実行）');
  console.log(`対象: ${FROM} 以降に開催され、すでに終わったライブ`);

  // 色データと声優一覧
  let colors = null;
  for (const u of COLORS_URLS) { const t = await getText(u); if (t) { try { colors = JSON.parse(t); break; } catch (e) { /* 次へ */ } } }
  if (!colors) throw new Error('ペンライトの色データ（colors.json）を読めませんでした');
  const idolData = buildIdols(colors);
  const cvHtml = await getText(CV_URL);
  if (!cvHtml) throw new Error(`アイマスDBの声優一覧を読めませんでした（${CV_URL}）`);
  const cv = parseCvPage(cvHtml);
  console.log(`色データのアイドル ${idolData.idols.length}人 / アイマスDBの声優一覧 ${cv.size}人`);
  console.log(`（声優一覧の読み取り例: ${[...cv.values()].slice(0, 3).map(v => `${v.name}→${[...v.chars].join('・')}`).join(' ／ ')}）`);
  if (cv.size < 100) throw new Error('声優一覧の読み取りに失敗したようです（人数が少なすぎます）。ページの作りが変わった可能性があります');

  // Notion
  const schedMeta = await api(() => notion.databases.retrieve({ database_id: SCHED_DB }));
  if (schedMeta.properties['出演者']?.type !== 'rich_text') throw new Error('公演日程DBに「出演者」（テキスト）の列がありません');
  const relName = ['ライブ', 'ライブリンク'].find(n => schedMeta.properties[n]?.type === 'relation');
  if (!relName) throw new Error('公演日程DBに、ライブへのリレーション列がありません');
  const [lives, scheds] = [await queryAll(LIVE_DB), await queryAll(SCHED_DB)];
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const liveInfo = new Map(lives.map(l => {
    const tp = Object.values(l.properties).find(v => v.type === 'title');
    const d = l.properties['ライブ開催日']?.date || {};
    return [l.id, { title: tp ? plain(tp.title) : '', start: (d.start || '').slice(0, 10), end: (d.end || d.start || '').slice(0, 10), brands: (l.properties['ブランド']?.multi_select || []).map(o => o.name) }];
  }));

  const targets = scheds.map(s => ({ s, live: liveInfo.get(rel(s, relName)[0]), url: propText(s.properties['セトリURL']).trim(), cast: propText(s.properties['出演者']), label: propText(s.properties['表示ラベル']) || propText(s.properties['Day']) }))
    .filter(x => x.live && x.live.start && x.live.start >= FROM && x.live.end < today && !x.cast && /^https?:\/\/imas-db\.jp\//.test(x.url))
    .sort((a, b) => (a.live.start + a.label).localeCompare(b.live.start + b.label));
  console.log(`出演者が空欄で、セトリURLがある公演: ${targets.length}件\n`);

  const pages = new Map();   // URL → 出演欄の行（同じページを2回開かない）
  let done = 0, empty = 0, shownHeads = false;
  for (const t of targets) {
    if (!pages.has(t.url)) {
      const html = await getText(t.url);
      const sec = html ? castSection(html) : null;
      pages.set(t.url, html ? (sec ? linesOf(sec) : (overviewSection(html, '') ? { html } : 'nosection')) : 'noread');
      if (html && !sec && !shownHeads) {   // 1回だけ、ページの見出しを出す（ページの作りが想定と違うときの手がかり）
        shownHeads = true;
        const heads = (html.match(/<(h[1-6]|dt|th)[^>]*>[\s\S]*?<\/\1>/gi) || []).map(h => textOf(h).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);
        console.log(`   （参考: ${t.url} の見出し: ${heads.join(' ／ ') || 'なし'}）`);
      }
      await sleep(GAP_MS);
    }
    const got = pages.get(t.url);
    const lines = got && got.html ? dropOffstage(linesOf(overviewSection(got.html, t.label))) : got;
    const head = `${t.live.title}｜${t.label.split(':')[0]}`;
    if (lines === 'noread') { console.log(`⏩ ${head}: ページを読めませんでした（${t.url}）`); empty++; continue; }
    if (lines === 'nosection') { console.log(`⏩ ${head}: ページに「出演」欄が見つかりませんでした（${t.url}）`); empty++; continue; }
    const { found, unknown } = matchCast(lines, cv, idolData, t.live.brands);
    if (!found.length) { console.log(`⚠️ ${head}: 出演者を読み取れませんでした${unknown.length ? `（対応が見つからない名前: ${unknown.slice(0, 8).join('、')}）` : ''}`); empty++; continue; }
    console.log(`${WRITE ? '✅' : '📝'} ${head}: ${found.length}名 ${found.join(',')}`);
    if (unknown.length) console.log(`   └ 対応が見つからない名前: ${unknown.slice(0, 12).join('、')}${unknown.length > 12 ? ` ほか${unknown.length - 12}件` : ''}`);
    if (WRITE) await api(() => notion.pages.update({ page_id: t.s.id, properties: { '出演者': { rich_text: [{ type: 'text', text: { content: found.join(',').slice(0, 1900) } }] } } }));
    done++;
  }
  console.log(`\n${WRITE ? '書き込んだ' : '書き込める'}公演: ${done}件 / 読み取れなかった公演: ${empty}件`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 出演者の取り込み（${WRITE ? '書き込み' : '確認だけ'}）\n- 対象 ${targets.length}件 / ${WRITE ? '書き込んだ' : '書き込める'} ${done}件 / 読み取れなかった ${empty}件\n`);
}

if (require.main === module) main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
