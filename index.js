'use strict';
/**
 * アイマス ライブ情報スナイパー（新構成版）
 *
 * 公式サイトの新着記事 → Gemini で抽出 → Notion の4つのDBに反映 → events.json を生成
 *
 *   ライブ DB      … ライブの基本情報（手で直した値は上書きしない。「ロック」で完全に保護）
 *   受付枠 DB      … 先行・一般・リセールなどの履歴（1行 = 1つの受付枠）
 *   公演日程 DB    … Day ごとの日時と出演者
 *   取得ログ DB    … 処理した記事URLの記録（「再処理」にチェックで再判定）
 *
 * 実行オプション
 *   node index.js              通常実行
 *   node index.js --dry        Notion に書き込まない（events.json も作らない）
 *   node index.js --max=3      新しい記事を最大3件だけ処理する（試運転用）
 */
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const MAX = Number((process.argv.find(a => a.startsWith('--max=')) || '').slice(6)) || Infinity;
const ENV = {
  live: process.env.NOTION_DB_ID,
  slot: process.env.NOTION_SLOT_DB_ID,
  sched: process.env.NOTION_SCHEDULE_DB_ID,
  log: process.env.NOTION_LOG_DB_ID,
};
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const warns = [];
const warn = m => { warns.push(m); console.log(` ├─ ⚠️ ${m}`); };

/* =====================================================================
 * 共通ユーティリティ
 * ===================================================================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(fn) {   // 呼び出し間隔の確保と、429 / 5xx の自動リトライ
  for (let i = 0; i < 5; i++) {
    try { const r = await fn(); await sleep(Number(process.env.API_GAP_MS ?? 350)); return r; }
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
const isValidDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d);
const uniq = a => Array.from(new Set(a));

// 'YYYY-MM-DDTHH:mm' / 'YYYY-MM-DD HH:mm' → Notion 用（日本時間 +09:00）。日付のみはそのまま
function toNotionDate(d) {
  if (!d || typeof d !== 'string') return '';
  const s = d.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00+09:00`;
  return s;
}
function sameDate(a, b) {
  if (!a || !b) return a === b;
  const ta = Date.parse(a), tb = Date.parse(b);
  return (!isNaN(ta) && !isNaN(tb)) ? ta === tb : a === b;
}

/** プロパティの種類に応じて、書き込み用の値を作る（存在しない列は黙ってスキップ） */
function put(meta, props, name, v) {
  const p = meta.properties[name];
  if (!p || v === undefined) return false;
  switch (p.type) {
    case 'title': props[name] = { title: rt(v) }; break;
    case 'rich_text': props[name] = { rich_text: rt(v) }; break;
    case 'select': props[name] = { select: v ? { name: v } : null }; break;
    case 'multi_select': props[name] = { multi_select: (v || []).map(n => ({ name: n })) }; break;
    case 'url': props[name] = { url: v || null }; break;
    case 'checkbox': props[name] = { checkbox: !!v }; break;
    case 'number': props[name] = { number: v ?? null }; break;
    case 'date': props[name] = { date: v ? (typeof v === 'string' ? { start: v } : v) : null }; break;
    case 'relation': props[name] = { relation: (Array.isArray(v) ? v : [v]).filter(Boolean).map(id => ({ id })) }; break;
    default: return false;
  }
  return true;
}
const titleName = meta => Object.entries(meta.properties).find(([, v]) => v.type === 'title')[0];
const titleOf = (page, meta) => propText(page.properties[titleName(meta)]);
const dateStart = (page, name) => { const p = page.properties[name]; return p?.type === 'date' ? (p.date?.start || '') : ''; };
const dateEnd = (page, name) => { const p = page.properties[name]; return p?.type === 'date' ? (p.date?.end || '') : ''; };
const isLocked = page => !!page.properties['ロック']?.checkbox;

// CSV取り込みで「テキスト」のまま残っている列と、リレーション列の両方に対応する
function relName(meta, base) {
  if (meta.properties[base]?.type === 'relation') return base;
  if (meta.properties[base + 'リンク']?.type === 'relation') return base + 'リンク';
  return null;
}
const relIds = (page, name) => (name ? (page.properties[name]?.relation || []).map(r => r.id) : []);

/* =====================================================================
 * Notion への書き込み（--dry のときは何も書かない）
 * ===================================================================== */
let dryN = 0;
const W = {
  async create(params) {
    if (DRY) { console.log(' │ [DRY] ページ作成'); return { id: `dry-${++dryN}`, properties: {}, icon: params.icon || null, __dry: true }; }
    return api(() => notion.pages.create(params));
  },
  async update(params) {
    if (DRY) { console.log(' │ [DRY] ページ更新'); return null; }
    return api(() => notion.pages.update(params));
  },
  async del(id) { if (DRY) return; return api(() => notion.blocks.delete({ block_id: id })); },
  async append(id, children) { if (DRY) return; return api(() => notion.blocks.children.append({ block_id: id, children })); },
};

/* =====================================================================
 * 表記の整形（以前のものをそのまま引き継ぎ）
 * ===================================================================== */
async function fetchWithRetry(url, options, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status === 429 || res.status === 503) {
        const waitTime = (i + 1) * 30000;
        console.log(` ├─ ⚠️ API制限/混雑(${res.status})。${waitTime / 1000}秒待機して再試行します...(${i + 1}/${maxRetries})`);
        await sleep(waitTime); continue;
      }
      console.log(` ├─ ❌ APIエラー発生 (HTTP ${res.status}): ${await res.text()}`);
      return null;
    } catch (err) {
      console.log(` ├─ ⚠️ 通信エラー: ${err.message}。再試行します...(${i + 1}/${maxRetries})`);
      await sleep(15000);
    }
  }
  console.log(` ├─ ❌ リトライ上限（${maxRetries}回）に到達しました。次の記事へ進みます。`);
  return null;
}

function enforceShortName(shortName, fullName) {
  let target = (shortName && shortName.trim() !== '') ? shortName.trim() : fullName;
  target = target
    .replace(/PROJECT IM@S\s*/gi, '').replace(/vα-liv/gi, 'ヴイアラ').replace(/THE IDOLM@STER\s*/gi, '')
    .replace(/アイドルマスター\s*/g, '').replace(/CINDERELLA GIRLS/gi, 'デレ').replace(/シンデレラガールズ/g, 'デレ')
    .replace(/MILLION LIVE!/gi, 'ミリオン').replace(/ミリオンライブ！?/g, 'ミリオン').replace(/SHINY COLORS/gi, 'シャニ')
    .replace(/シャイニーカラーズ/g, 'シャニ').replace(/学園アイドルマスター/g, '学マス').replace(/Anniversary/gi, '周年')
    .replace(/Memorial/gi, '').replace(/Orchestra Concert/gi, 'オケコン').replace(/\s+/g, ' ').trim();
  return target.replace(/(\d+(?:st|nd|rd|th))\s*PM\s*/gi, '$1');
}
function selectEventEmoji(ev, fullOfficialName) {
  const valid = ['🎤', '✨', '🎻', '🤝', '🎪'];
  if (ev.icon_emoji && valid.includes(ev.icon_emoji.trim())) return ev.icon_emoji.trim();
  const t = `${fullOfficialName} ${ev.short_name || ''}`;
  if (/オーケストラ|オケコン|Orchestra|音楽祭/i.test(t)) return '🎻';
  if (/xR|MR|vα-liv|ヴイアラ|Streaming/i.test(t)) return '✨';
  if ((/PRODUCER MEETING|プロミ|ファンミ|トーク|挨拶/i.test(t)) && !/LIVE/i.test(t)) return '🤝';
  return '🎤';
}
function normalizeBrands(brandsArray, fullOfficialName) {
  const set = new Set();
  const add = str => {
    if (/765|ALLSTARS|AS/i.test(str)) set.add('765AS');
    if (/デレ|CINDERELLA|シンデレラ/i.test(str)) set.add('デレマス');
    if (/ミリ|MILLION/i.test(str)) set.add('ミリオン');
    if (/シャニ|SHINY/i.test(str)) set.add('シャニマス');
    if (/SideM|サイドエム/i.test(str)) set.add('SideM');
    if (/学マス|学園/i.test(str)) set.add('学マス');
    if (/ヴイアラ|vα-liv/i.test(str)) set.add('ヴイアラ');
    if (/876|ディアリースターズ/i.test(str)) set.add('876');
  };
  (Array.isArray(brandsArray) ? brandsArray : []).forEach(b => add(String(b)));
  if (set.size === 0 && fullOfficialName) add(fullOfficialName);
  return Array.from(set);
}
const isSpecialColorEvent = (ev, full) => ev.is_special_color === true || /REFRAC7IONS|リフラクションズ/i.test(`${full || ''} ${ev.short_name || ''}`);
function cleanCastList(arr) {
  if (!Array.isArray(arr)) return [];
  return uniq(arr.map(n => String(n).replace(/（.*?）|\(.*?\)/g, '').replace(/\s+/g, '').trim()).filter(Boolean));
}
function buildPenlightUrl(castArray, isSpecial = false) {
  const base = 'https://penlight-supporter.onrender.com/setlist';
  const cast = cleanCastList(castArray);
  if (!cast.length) return isSpecial ? `${base}?special=1` : base;
  let castStr = '';
  for (const name of cast) {
    const next = castStr ? `${castStr},${name}` : name;
    if ((base.length + 25 + encodeURIComponent(next).length) > 1900) break;
    castStr = next;
  }
  return `${base}?auto_cast=${encodeURIComponent(castStr)}${isSpecial ? '&special=1' : ''}`;
}

/* =====================================================================
 * 日時の解析（公演ラベル → 開演日時）
 * ===================================================================== */
const dkey = label => (String(label).split(/[:：]/)[0] || '').trim();   // Pages の公演キーと同じ規則
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

/* =====================================================================
 * 受付枠の「現在の枠」の選び方（Pages と同じ考え方）
 *   受付中（締切が近い順） → 受付前（開始が近い順） → 終了（締切が新しい順）
 * ===================================================================== */
function slotState(s, now = Date.now()) {
  const st = s.start ? Date.parse(s.start) : null, en = s.end ? Date.parse(s.end) : null;
  if (en && en < now) return 'closed';
  if (st && st > now) return 'before';
  return (st || en) ? 'open' : 'tbd';
}
function pickCurrent(slots, now = Date.now()) {
  if (!slots.length) return null;
  const by = st => slots.filter(s => slotState(s, now) === st);
  const t = (s, k) => (s[k] ? Date.parse(s[k]) : Infinity);
  const open = by('open').sort((a, b) => t(a, 'end') - t(b, 'end'));
  if (open.length) return open[0];
  const before = by('before').sort((a, b) => t(a, 'start') - t(b, 'start'));
  if (before.length) return before[0];
  const closed = by('closed').sort((a, b) => (b.end ? Date.parse(b.end) : 0) - (a.end ? Date.parse(a.end) : 0));
  if (closed.length) return closed[0];
  return slots[0];
}

/* =====================================================================
 * Notion 4DB の読み込み
 * ===================================================================== */
const S = { live: null, slot: null, sched: null, log: null };
async function loadDb(id) {
  const meta = await api(() => notion.databases.retrieve({ database_id: id }));
  return { id, meta, pages: await queryAll(id), rel: {} };
}
async function loadAll() {
  for (const [k, v] of Object.entries({ NOTION_DB_ID: ENV.live, NOTION_SLOT_DB_ID: ENV.slot, NOTION_SCHEDULE_DB_ID: ENV.sched, NOTION_LOG_DB_ID: ENV.log }))
    if (!v) throw new Error(`${k} が未設定です（GitHubのSecretsと、ワークフローのenvを確認してください）`);
  S.live = await loadDb(ENV.live); S.slot = await loadDb(ENV.slot); S.sched = await loadDb(ENV.sched); S.log = await loadDb(ENV.log);
  S.slot.rel.live = relName(S.slot.meta, 'ライブ');
  S.sched.rel.live = relName(S.sched.meta, 'ライブ');
  S.log.rel.live = relName(S.log.meta, 'ライブ');
  if (!S.slot.rel.live) throw new Error('受付枠DBに、ライブへのリレーション列（「ライブ」または「ライブリンク」）がありません');
  if (!S.sched.rel.live) throw new Error('公演日程DBに、ライブへのリレーション列がありません');
}
function replacePage(db, page) {
  if (!page || page.__dry) return;
  const i = db.pages.findIndex(p => p.id === page.id);
  if (i >= 0) db.pages[i] = page; else db.pages.push(page);
}

/* ---- 受付枠 / 公演日程 の、ページ → 扱いやすい形 ---- */
function toSlot(p) {
  const name = propText(p.properties['枠名']) || titleOf(p, S.slot.meta).split('｜').slice(1).join('｜');
  const kind = propText(p.properties['種別']) || (/先着/.test(name) ? '先着' : '抽選');
  return { id: p.id, name, kind, start: dateStart(p, '受付開始'), end: dateStart(p, '締切'), lottery: dateStart(p, '当落発表日'), locked: isLocked(p) };
}
const slotsOfLive = liveId => S.slot.pages.filter(p => relIds(p, S.slot.rel.live).includes(liveId)).map(toSlot);
const schedPagesOfLive = liveId => S.sched.pages
  .filter(p => relIds(p, S.sched.rel.live).includes(liveId))
  .sort((a, b) => (a.properties['順番']?.number ?? 99) - (b.properties['順番']?.number ?? 99));

/* =====================================================================
 * サイドピーク（ページ本文）の自動生成：DBの項目から組み立てる
 * ===================================================================== */
function buildBodyBlocks(live, schedRows, special) {
  const blocks = [];
  if (live.officialUrl) blocks.push({ object: 'block', type: 'callout', callout: { icon: { type: 'emoji', emoji: '🔗' }, color: 'blue_background',
    rich_text: [{ type: 'text', text: { content: `${live.fullName || live.title} (イベント公式サイトへ)`, link: { url: live.officialUrl } }, annotations: { bold: true } }] } });
  blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: '📍 開催・アクセス・ペンライト連携' } }] } });
  let venueRt;
  if (live.venue && live.venue !== '未定') {
    venueRt = [
      { type: 'text', text: { content: '会場：' }, annotations: { bold: true } },
      { type: 'text', text: { content: `${live.venue} (🗺️マップ)`, link: { url: live.mapUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(live.venue)}` } }, annotations: { bold: true } },
      { type: 'text', text: { content: ' ｜ ' } },
      { type: 'text', text: { content: '🌐公式アクセス情報', link: { url: live.accessUrl || `https://www.google.com/search?q=${encodeURIComponent(live.venue + ' 公式 アクセス')}` } } },
      { type: 'text', text: { content: `\n🚃 最寄り駅：${live.station || '情報なし'}` } },
    ];
  } else venueRt = [{ type: 'text', text: { content: '会場：未定' } }];
  blocks.push({ object: 'block', type: 'callout', callout: { icon: { type: 'emoji', emoji: '🏟️' }, color: 'gray_background', rich_text: venueRt } });
  for (const r of schedRows) {
    const key = r.key, cast = r.cast, label = r.label || key;
    const countText = cast.length ? `（出演: ${cast.length}名 自動セット）` : '（手動セット画面へ）';
    const para = special ? [
      { type: 'text', text: { content: '🎨 ' } },
      { type: 'text', text: { content: `${key} のペンライト設定を作成する【特別カラー対応】${countText}`, link: { url: buildPenlightUrl(cast, true) } }, annotations: { bold: true, color: 'purple' } },
      { type: 'text', text: { content: ' ｜ ' }, annotations: { color: 'gray' } },
      { type: 'text', text: { content: '通常色で作成', link: { url: buildPenlightUrl(cast, false) } }, annotations: { color: 'gray' } },
    ] : [
      { type: 'text', text: { content: '🪄 ' } },
      { type: 'text', text: { content: `${key} のペンライト設定を作成する${countText}`, link: { url: buildPenlightUrl(cast, false) } }, annotations: { bold: true, color: 'purple' } },
    ];
    blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: {
      rich_text: [{ type: 'text', text: { content: label }, annotations: { bold: true } }],
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: para } }] } });
  }
  return blocks;
}
// 自動生成した種類のブロックだけを入れ替える（手で書いたメモ等は残す）
async function rebuildBody(pageId, blocks) {
  if (DRY) { console.log(' │ [DRY] サイドピークを再生成'); return; }
  const res = await api(() => notion.blocks.children.list({ block_id: pageId, page_size: 100 }));
  for (const b of res.results) {
    const gen =
      (b.type === 'callout' && ['🔗', '🏟️'].includes(b.callout?.icon?.emoji)) ||
      (b.type === 'heading_3' && plain(b.heading_3?.rich_text).startsWith('📍')) ||
      (b.type === 'bulleted_list_item' && b.has_children);
    if (gen) await W.del(b.id);
  }
  await W.append(pageId, blocks);
}

/* =====================================================================
 * 1件のイベント（AIの抽出結果）を反映する
 * ===================================================================== */
const brandsOf = p => (p.properties['ブランド']?.multi_select || []).map(o => o.name);
const startOf = p => dateStart(p, 'ライブ開催日');

function findLive(full, short, ev, brands) {
  const names = [norm(short), norm(full)];
  let hit = S.live.pages.find(p => names.includes(norm(titleOf(p, S.live.meta))));
  if (!hit && isValidDate(ev.live_date)) {
    const cands = S.live.pages.filter(p => startOf(p).slice(0, 10) === ev.live_date);
    hit = cands.find(p => brandsOf(p).some(b => brands.includes(b)));
  }
  return hit || null;
}

async function applyEvent(ev, article) {
  const full = ev.full_official_name || ev.base_live_name || article.title || 'アイマスイベント';
  const short = enforceShortName(ev.short_name, full);
  const brands = normalizeBrands(ev.brands, full);
  const special = isSpecialColorEvent(ev, full);
  const emoji = selectEventEmoji(ev, full);
  const linkUrl = (ev.official_url && ev.official_url.startsWith('http')) ? ev.official_url : article.url;
  const venue = (ev.venues || '').trim(), station = (ev.nearest_station || '').trim();
  const meta = S.live.meta;
  let bodyChanged = false, created = false;

  /* --- ライブ本体（空欄だけ埋める。ロック中は触らない） --- */
  let live = findLive(full, short, ev, brands);
  if (!live) {
    const props = {};
    put(meta, props, titleName(meta), short);
    put(meta, props, 'ブランド', brands);
    if (isValidDate(ev.live_date)) {
      const d = { start: ev.live_date };
      if (isValidDate(ev.live_end_date) && ev.live_end_date !== ev.live_date) d.end = ev.live_end_date;
      put(meta, props, 'ライブ開催日', d);
    }
    put(meta, props, '正式名称', full);
    if (venue && venue !== '未定') {
      put(meta, props, '会場', venue); put(meta, props, '最寄り駅', station);
      put(meta, props, '地図URL', `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue)}`);
      put(meta, props, 'アクセスURL', `https://www.google.com/search?q=${encodeURIComponent(venue + ' 公式 アクセス')}`);
    }
    put(meta, props, '公式URL', linkUrl);
    put(meta, props, '特別カラー', special);
    put(meta, props, '最終自動更新', new Date().toISOString());
    live = await W.create({ parent: { database_id: S.live.id }, icon: { type: 'emoji', emoji }, properties: props });
    replacePage(S.live, live); created = true; bodyChanged = true;
    console.log(` ├─ ⭐ 新規登録: ${emoji}『${short}』（${ev.live_date || '日付未定'}〜${ev.live_end_date || ev.live_date || ''}${special ? ' / 🎨特別カラー' : ''}）`);
  } else if (!isLocked(live)) {
    const props = {};
    const empty = (name, type) => { const c = live.properties[name]; if (!c) return false; return type === 'rich_text' ? !plain(c.rich_text) : type === 'url' ? !c.url : type === 'multi' ? !(c.multi_select || []).length : !c.date; };
    const fill = (name, val, type) => { if (val && empty(name, type) && put(meta, props, name, val)) bodyChanged = true; };
    fill('正式名称', full, 'rich_text');
    if (venue && venue !== '未定') {
      fill('会場', venue, 'rich_text'); fill('最寄り駅', station, 'rich_text');
      fill('地図URL', `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue)}`, 'url');
      fill('アクセスURL', `https://www.google.com/search?q=${encodeURIComponent(venue + ' 公式 アクセス')}`, 'url');
    }
    fill('公式URL', linkUrl, 'url'); fill('ブランド', brands, 'multi');
    if (isValidDate(ev.live_date)) {
      const cur = startOf(live).slice(0, 10);
      if (!cur) { const d = { start: ev.live_date }; if (isValidDate(ev.live_end_date) && ev.live_end_date !== ev.live_date) d.end = ev.live_end_date; put(meta, props, 'ライブ開催日', d); bodyChanged = true; }
      else if (cur !== ev.live_date) warn(`『${titleOf(live, meta)}』: 記事の公演日(${ev.live_date})が登録済み(${cur})と異なります。変更が必要なら手で直してください`);
    }
    if (special && !live.properties['特別カラー']?.checkbox && put(meta, props, '特別カラー', true)) bodyChanged = true;
    if (Object.keys(props).length) { const u = await W.update({ page_id: live.id, properties: props }); if (u) { replacePage(S.live, u); live = u; } }
    console.log(` ├─ 🔄 既存: 『${titleOf(live, meta)}』を確認${Object.keys(props).length ? '（空欄を補完）' : ''}`);
  } else console.log(` ├─ 🔒 ロック中: 『${titleOf(live, meta)}』のライブ本体は更新しません`);

  const liveTitle = titleOf(live, meta) || short;

  /* --- 受付枠 --- */
  const tier = (ev.ticket_tier || '').trim();
  if (tier) {
    const kind = (ev.ticket_kind === '先着' || ev.ticket_kind === '抽選') ? ev.ticket_kind : (/先着/.test(tier) ? '先着' : '抽選');
    const start = toNotionDate(ev.apply_start_date), end = toNotionDate(ev.deadline_date);
    const lot = isValidDate(ev.result_date_notion) ? toNotionDate(ev.result_date_notion) : '';
    const existing = S.slot.pages.find(p => relIds(p, S.slot.rel.live).includes(live.id) && norm(toSlot(p).name) === norm(tier));
    const sm = S.slot.meta;
    if (!existing) {
      const props = {};
      put(sm, props, titleName(sm), `${liveTitle}｜${tier}`); put(sm, props, '枠名', tier);
      if (sm.properties['ライブ']?.type === 'rich_text') put(sm, props, 'ライブ', liveTitle);   // テキスト列が残っている場合のみ
      put(sm, props, S.slot.rel.live, [live.id]);
      put(sm, props, '種別', kind); put(sm, props, '受付開始', start); put(sm, props, '締切', end);
      if (lot) put(sm, props, '当落発表日', lot);
      put(sm, props, '取得元記事URL', article.url); put(sm, props, '最終自動更新', new Date().toISOString());
      const pg = await W.create({ parent: { database_id: S.slot.id }, properties: props });
      if (!pg.__dry) replacePage(S.slot, pg); else S.slot.pages.push({ id: pg.id, properties: Object.fromEntries(Object.entries(props).map(([k]) => [k, null])) , __dry: true });
      console.log(` ├─ 🎫 受付枠を追加: ${tier}（${kind}）`);
    } else if (!isLocked(existing)) {
      const props = {};
      const changes = [];
      if (start && !sameDate(start, dateStart(existing, '受付開始'))) { put(sm, props, '受付開始', start); changes.push('開始'); }
      if (end && !sameDate(end, dateStart(existing, '締切'))) { put(sm, props, '締切', end); changes.push('締切'); }
      if (lot && !sameDate(lot, dateStart(existing, '当落発表日'))) { put(sm, props, '当落発表日', lot); changes.push('当落発表'); }
      if (changes.length) {
        put(sm, props, '取得元記事URL', article.url); put(sm, props, '最終自動更新', new Date().toISOString());
        const u = await W.update({ page_id: existing.id, properties: props }); if (u) replacePage(S.slot, u);
        console.log(` ├─ 🎫 受付枠を更新: ${tier}（${changes.join('・')}）`);
      } else console.log(` ├─ 🎫 受付枠は変更なし: ${tier}`);
    } else console.log(` ├─ 🔒 受付枠「${tier}」はロック中のため更新しません`);
  }

  /* --- 公演日程 --- */
  const sm2 = S.sched.meta;
  const anchor = startOf(live) || ev.live_date || '';
  const liveStart = anchor.slice(0, 10), liveEnd = (dateEnd(live, 'ライブ開催日') || anchor).slice(0, 10);
  let schedChanged = false;
  for (let i = 0; i < (ev.schedules || []).length; i++) {
    const s = ev.schedules[i];
    const text = typeof s === 'string' ? s : (s.text || '');
    const key = (text.includes(':') || text.includes('：')) ? dkey(text) : ((typeof s === 'object' && s.label) || dkey(text) || `Day${i + 1}`);
    const cast = cleanCastList(typeof s === 'object' ? s.cast : []);
    const d = parseLabelDate(text, liveStart);
    if (d && liveStart && (Date.parse(d.date) < Date.parse(liveStart) - 864e5 || Date.parse(d.date) > Date.parse(liveEnd) + 864e5))
      warn(`${liveTitle} / ${key}: 公演日(${d.date})がライブ開催日(${liveStart}〜${liveEnd})の範囲外です`);
    const row = schedPagesOfLive(live.id).find(p => norm(propText(p.properties['Day'])) === norm(key));
    if (!row) {
      const props = {};
      put(sm2, props, titleName(sm2), `${liveTitle} ${key}`); put(sm2, props, S.sched.rel.live, [live.id]);
      put(sm2, props, 'Day', key); put(sm2, props, '出演者', cast.join(',')); put(sm2, props, '順番', i + 1); put(sm2, props, '表示ラベル', text);
      if (d) put(sm2, props, '開演日時', d.start);
      if (d?.open) put(sm2, props, '開場時刻', d.open);
      const pg = await W.create({ parent: { database_id: S.sched.id }, properties: props });
      replacePage(S.sched, pg.__dry ? { id: pg.id, properties: { 'ライブ': { relation: [{ id: live.id }] }, 'Day': { type: 'rich_text', rich_text: [{ plain_text: key }] }, '出演者': { type: 'rich_text', rich_text: [{ plain_text: cast.join(',') }] }, '表示ラベル': { type: 'rich_text', rich_text: [{ plain_text: text }] } } } : pg);
      schedChanged = true; console.log(` ├─ 📅 公演を追加: ${key}（出演 ${cast.length}名）`);
    } else {
      const props = {}, changes = [];
      const oldCast = cleanCastList(propText(row.properties['出演者']).split(','));
      const merged = cleanCastList([...oldCast, ...cast]);
      if (merged.length !== oldCast.length) { put(sm2, props, '出演者', merged.join(',')); changes.push(`出演者 ${oldCast.length}→${merged.length}名`); }
      const oldLabel = propText(row.properties['表示ラベル']);
      if (text && text !== oldLabel && /開演/.test(text) && (!/開演/.test(oldLabel) || text.length > oldLabel.length)) { put(sm2, props, '表示ラベル', text); changes.push('日時'); }
      if (d && !dateStart(row, '開演日時') && put(sm2, props, '開演日時', d.start)) changes.push('開演日時');
      if (d?.open && !propText(row.properties['開場時刻']) && put(sm2, props, '開場時刻', d.open)) changes.push('開場時刻');
      if (changes.length) {
        const u = await W.update({ page_id: row.id, properties: props }); if (u) replacePage(S.sched, u);
        schedChanged = true; console.log(` ├─ 📅 公演を更新: ${key}（${changes.join('・')}）`);
      }
    }
  }

  /* --- 一覧表示用の列と、サイドピークを最新化 --- */
  if (!isLocked(live)) {
    const props = {};
    const cur = pickCurrent(slotsOfLive(live.id));
    // 既存のビュー（受付枠／受付期間／当落発表日）を壊さないよう、現在の枠の内容を書き戻す
    if (cur) {
      put(meta, props, '受付枠', cur.name);
      put(meta, props, '受付期間', cur.start && cur.end ? { start: cur.start, end: cur.end } : (cur.start || cur.end || null));
      put(meta, props, '当落発表日', cur.lottery || null);
    }
    put(meta, props, '最終自動更新', new Date().toISOString());
    const u = await W.update({ page_id: live.id, properties: props }); if (u) { replacePage(S.live, u); live = u; }
    if (created || bodyChanged || schedChanged) {
      const info = { title: liveTitle, fullName: propText(live.properties['正式名称']) || full, venue: propText(live.properties['会場']), station: propText(live.properties['最寄り駅']),
        mapUrl: propText(live.properties['地図URL']), accessUrl: propText(live.properties['アクセスURL']), officialUrl: propText(live.properties['公式URL']) };
      const rows = schedPagesOfLive(live.id).map(p => ({ key: propText(p.properties['Day']), label: propText(p.properties['表示ラベル']), cast: cleanCastList(propText(p.properties['出演者']).split(',')) }));
      await rebuildBody(live.id, buildBodyBlocks(info, rows, special || !!live.properties['特別カラー']?.checkbox));
      console.log(' ├─ 📝 サイドピークを最新化しました');
    }
  }
  return live;
}

/* =====================================================================
 * 取得ログ
 * ===================================================================== */
function logIndex() {
  const m = new Map();
  for (const p of S.log.pages) { const url = propText(p.properties[titleName(S.log.meta)]); if (url) m.set(url, p); }
  return m;
}
async function recordLog(url, title, verdict, live) {
  const lm = S.log.meta, existing = logIndex().get(url), props = {};
  put(lm, props, '判定', verdict); put(lm, props, '取得日', new Date().toISOString().slice(0, 10)); put(lm, props, '再処理', false);
  if (live) { if (lm.properties['ライブ']?.type === 'rich_text') put(lm, props, 'ライブ', propText(live.properties[titleName(S.live.meta)])); put(lm, props, S.log.rel.live, [live.id]); }
  if (existing) { const u = await W.update({ page_id: existing.id, properties: props }); if (u) replacePage(S.log, u); }
  else { put(lm, props, titleName(lm), url); const pg = await W.create({ parent: { database_id: S.log.id }, properties: props });
    replacePage(S.log, pg.__dry ? { id: pg.id, properties: { [titleName(lm)]: { type: 'title', title: [{ plain_text: url }] }, '再処理': { type: 'checkbox', checkbox: false } } } : pg); }
}
function isProcessed(url) {
  const p = logIndex().get(url);
  if (p) return !p.properties['再処理']?.checkbox && ['対象', '非対象'].includes(propText(p.properties['判定']));
  // 旧方式（ライブ行の「処理済みURL」）の記録も引き続き有効にする
  return S.live.pages.some(l => (propText(l.properties['処理済みURL']) || '').split(',').map(u => u.trim()).includes(url));
}

/* =====================================================================
 * events.json の生成（4つのDBから）
 * ===================================================================== */
function buildEvents({ live, slot, sched }, now = Date.now()) {
  const out = [], issues = [];
  const slotRel = relName(slot.meta, 'ライブ'), schedRel = relName(sched.meta, 'ライブ');
  const lt = titleName(live.meta);
  const mapOwners = new Map();
  for (const page of live.pages) {
    const title = propText(page.properties[lt]);
    if (!title) continue;
    const g = n => propText(page.properties[n]);
    const slots = slot.pages.filter(p => relIds(p, slotRel).includes(page.id)).map(p => {
      const name = propText(p.properties['枠名']) || propText(p.properties[titleName(slot.meta)]).split('｜').slice(1).join('｜');
      return { name, kind: propText(p.properties['種別']) || (/先着/.test(name) ? '先着' : '抽選'), start: dateStart(p, '受付開始'), end: dateStart(p, '締切'), lottery: dateStart(p, '当落発表日') };
    });
    const cur = pickCurrent(slots, now);
    const special = !!page.properties['特別カラー']?.checkbox;
    const ds = dateStart(page, 'ライブ開催日').slice(0, 10), de = (dateEnd(page, 'ライブ開催日') || ds).slice(0, 10);
    const schedules = sched.pages.filter(p => relIds(p, schedRel).includes(page.id))
      .sort((a, b) => (a.properties['順番']?.number ?? 99) - (b.properties['順番']?.number ?? 99))
      .map(p => {
        const key = propText(p.properties['Day']);
        let label = propText(p.properties['表示ラベル']) || key;
        if (key && !label.startsWith(key)) label = `${key}: ${label}`;   // Pages は「:」より前を公演キーにする
        const castNames = cleanCastList(propText(p.properties['出演者']).split(','));
        return { label, castCount: castNames.length, castNames, penlightUrl: buildPenlightUrl(castNames, special) };
      });
    // 検査
    for (const s of schedules) { const d = parseLabelDate(s.label, ds); if (d && ds && (Date.parse(d.date) < Date.parse(ds) - 864e5 || Date.parse(d.date) > Date.parse(de) + 864e5)) issues.push(`${title} / ${dkey(s.label)}: 公演日(${d.date})がライブ開催日(${ds}〜${de})の範囲外`); }
    if (!g('会場')) issues.push(`${title}: 会場が未入力です`);
    const mapUrl = g('地図URL'), venue = g('会場');
    if (mapUrl) { const o = mapOwners.get(mapUrl); if (o && o !== venue) issues.push(`${title}: 地図URLが「${o}」と同じです（会場が違うのにURLが同一）`); else mapOwners.set(mapUrl, venue); }
    out.push({
      id: page.id, icon: page.icon?.type === 'emoji' ? page.icon.emoji : '🎤', title,
      brands: (page.properties['ブランド']?.multi_select || []).map(o => o.name),
      phase: cur?.name || '', phaseKind: cur?.kind || '',
      applyStartDate: cur?.start || '', deadline: cur?.end || '', lotteryDate: (cur?.lottery || '').slice(0, 10),
      slots: slots.map(s => ({ name: s.name, kind: s.kind, start: s.start, end: s.end, lottery: s.lottery.slice(0, 10) })),
      eventDateStart: ds, eventDateEnd: de,
      officialUrl: g('公式URL'), venue, mapUrl, accessUrl: g('アクセスURL'), nearestStation: g('最寄り駅'),
      isSpecialColor: special, schedules,
    });
  }
  out.sort((a, b) => (a.eventDateStart || a.deadline || '9999').localeCompare(b.eventDateStart || b.deadline || '9999'));
  return { events: out, issues };
}
async function syncEventsJson() {
  console.log('\n🌐 Notionの4つのDBから events.json を生成中...');
  await loadAll();   // 最新の状態を読み直す
  const { events, issues } = buildEvents(S);
  issues.forEach(warn);
  if (DRY) { console.log(`   [DRY] events.json は作りません（${events.length}件分を生成できました）`); return; }
  fs.writeFileSync(path.join(__dirname, 'events.json'), JSON.stringify(events, null, 2), 'utf8');
  console.log(`✅ events.json の同期完了！ (全 ${events.length} 件)`);
}

/* =====================================================================
 * AI への依頼文
 * ===================================================================== */
function buildPrompt(existingNames, links, text) {
  return `以下のテキストおよびページ内リンク一覧からイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【最重要①：複数公演（ツアー・別都市・別週末）の分割ルール】
・もし1つの記事内に「名古屋公演（1/30〜1/31）」と「東京公演（3/21〜3/22）」のように、日程が離れた複数の公演が含まれている場合は、必ず公演ごとに別々の要素として "events" 配列に分割して出力してください。

【最重要②：略称（short_name）の命名ルール】
現在データベースには以下のライブが登録されています。
${existingNames}
・既存リストと同じ公演であれば、表記揺れを防ぐため "short_name" は上記リストにある略称と一字一句一致させてください。
・複合イベントやナンバリングライブの場合は、"short_name" に『PM』を入れず『ヴイアラ3rd名古屋』のようにスッキリ命名してください。

【最重要③：nearest_station（最寄り駅）の記載ルール】
・会場から「距離が一番近い駅」と「多くの参加者が実際に利用する主要ターミナル駅」が異なる場合は必ずその2駅を併記してください。

【最重要④：schedules（各日の詳細スケジュールと出演アイドルの抽出）の記載ルール】
・★もし同じ日に「昼公演」と「夜公演」がある場合は、必ず「昼公演」と「夜公演」で別々のオブジェクトとして2つに分割して出力してください。
・各 "text" は必ず「Day1: 」「Day2 昼公演: 」のように、公演名のあとに半角コロンを付けて始めてください。
・声優名やユニット名しか書かれていない場合でも、知識から該当するキャラクター名に変換して出力してください。

【最重要⑤：受付の種類・先着・リセールの扱い・受付開始日】
・"ticket_kind" は、抽選の受付（先行・抽選販売・リセール）なら "抽選"、先着順の販売なら "先着" としてください。
・「一般発売(先着)」や「リセール」の場合、当落発表はないため "result_date_notion" は必ず空文字("")にしてください。
・申込受付には「開始日時」と「締切日時」があります。両方わかる場合は "apply_start_date" と "deadline_date" の両方を出力してください。先着などで開始日時しかわからない場合は "apply_start_date" に開始日時を入れ、"deadline_date" は空文字にしてください。

【抽出フォーマット】
{
  "is_target_live": true,
  "events": [
    {
      "full_official_name": "イベントの正式フルタイトル",
      "short_name": "カレンダー表示用の略称（例: ヴイアラ3rd名古屋）",
      "brands": ["対象ブランド名の配列。選択肢: '765AS', 'デレマス', 'ミリオン', 'シャニマス', 'SideM', '学マス', 'ヴイアラ', '876'"],
      "icon_emoji": "イベント種別に応じた絵文字1文字",
      "is_special_color": false,
      "live_date": "その公演ブロックの初日の日付（YYYY-MM-DD形式）",
      "live_end_date": "その公演ブロックの最終日の日付（YYYY-MM-DD形式）",
      "official_url": "イベント公式・特設サイトのURL",
      "venues": "会場名のみを簡潔に",
      "nearest_station": "最寄り駅と主要利用駅の所要時間",
      "schedules": [
        { "label": "Day1", "text": "Day1: 1月30日(土) [LIVE] 開場16:30/開演17:30", "cast": ["灯里愛夏", "上水流宇宙", "レトラ"] }
      ],
      "ticket_tier": "現在募集している現地チケットの受付名称",
      "ticket_kind": "抽選 または 先着",
      "apply_start_date": "上記受付の開始日時（'YYYY-MM-DDTHH:mm' または 'YYYY-MM-DD' 形式。不明なら空文字）",
      "deadline_date": "上記受付の最終締切日時（'YYYY-MM-DDTHH:mm' または 'YYYY-MM-DD' 形式。不明なら空文字）",
      "result_date_notion": "上記受付の当落発表日（YYYY-MM-DD形式。不明なら空文字。※先着・リセールは絶対に空文字）"
    }
  ]
}

【厳格な判定ルール】
・is_target_live: 現地開催（リアル会場）があるアイマス関連の単独音楽ライブ、xRライブ、コンサート、PM、ファンミ、オーケストラであれば true。「遊園地等のコラボ」「上映会」「配信のみ」「外部フェス出展」は false。
・is_special_color: シャイニーカラーズの「REFRAC7IONS」シリーズ等、特別カラー編成であることが明記されている特殊な公演のみ true。

【ページ内の主なリンク一覧】
${links}

【本文テキスト】
${text.substring(0, 12000)}`;
}

/* =====================================================================
 * メイン処理
 * ===================================================================== */
async function run() {
  const { chromium } = require('playwright');   // テスト時に不要なため、ここで読み込む
  console.log(`🚀 スナイパー起動（新構成版${DRY ? ' / ドライラン' : ''}${MAX < Infinity ? ` / 最大${MAX}件` : ''}）`);
  console.log('Notionの既存データを読み込み中...');
  try { await loadAll(); } catch (err) { console.error('⚠️ Notionの初期読み込みに失敗しました:', err.message); process.exitCode = 1; return; }
  console.log(` ├─ ライブ ${S.live.pages.length}件 / 受付枠 ${S.slot.pages.length}件 / 公演日程 ${S.sched.pages.length}件 / 取得ログ ${S.log.pages.length}件`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let processed = 0, handled = 0;
  try {
    console.log('ニュース一覧にアクセス中...');
    await page.goto('https://idolmaster-official.jp/news?category=live-event', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    const links = await page.$$eval('a', as => as.map(a => ({ url: a.href ? a.href.trim() : '', title: a.innerText ? a.innerText.trim() : '' }))
      .filter(a => a.url.startsWith('https://idolmaster-official.jp/news/') && !a.url.includes('category') && !a.url.includes('tag') && a.url.length > 38));
    const uniqueUrls = new Map();
    for (const l of links) if (!uniqueUrls.has(l.url)) uniqueUrls.set(l.url, l);
    const articles = Array.from(uniqueUrls.values()).reverse();
    console.log(`抽出対象: ${articles.length}件`);

    for (const article of articles) {
      console.log(`\n▶ 対象: ${article.title || article.url}`);
      if (isProcessed(article.url)) { console.log(' ├─ ⏩ スキップ: 取得ログに記録済みの記事です（API消費ゼロ）'); continue; }
      if (handled >= MAX) { console.log(` ├─ ⏹ --max=${MAX} に達したため、残りは次回に回します`); break; }
      const title = article.title || '';
      if (/グッズ|Blu-ray|CD|配信|上映会|コラボ|展示|出展/.test(title)) {
        console.log(' ├─ ⏩ スキップ: タイトルから対象外と判定');
        await recordLog(article.url, title, '非対象', null); handled++; continue;
      }
      try { await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(2000); }
      catch (e) { console.log(` ├─ ⚠️ ページ読み込みスキップ: ${e.message}`); continue; }

      const pageData = await page.evaluate(() => {
        const mainEl = document.querySelector('main, article, .news-detail, #main') || document.body;
        const extracted = Array.from(document.querySelectorAll('a')).map(a => ({ text: (a.innerText || '').trim(), href: a.href || '' }))
          .filter(l => l.href.startsWith('http') && !l.href.includes('/news/') && !l.href.includes('twitter.com') && !l.href.includes('x.com') && !l.href.includes('youtube.com') &&
            (l.href.includes('live_event') || l.href.includes('idolmaster-official.jp') || l.text.includes('特設') || l.text.includes('公式') || l.text.includes('詳細') || l.text.includes('サイト')))
          .map(l => `[${l.text || 'リンク'}](${l.href})`);
        return { text: mainEl ? mainEl.innerText : '', links: Array.from(new Set(extracted)).slice(0, 20).join('\n') };
      });
      const text = pageData.text;
      const hasTicket = /チケット|入場券|プロデューサーシート/.test(text);
      const hasApply = /先行|抽選|一般発売|一般会員|受付/.test(text);
      const hasAdditionalCast = /出演/.test(title) || /追加出演|出演者追加|追加キャスト/.test(text);
      if (!((hasTicket && hasApply) || hasAdditionalCast)) {
        console.log(' ├─ ⏩ スキップ: チケット申込または追加出演者の決定的なキーワードなし');
        await recordLog(article.url, title, '非対象', null); handled++; continue;
      }

      console.log(' ├─ 🎯 新着情報を検知！ Geminiに全文解析＆出演者抽出を依頼します...');
      const existingNames = S.live.pages.map(p => ({ t: titleOf(p, S.live.meta), d: startOf(p).slice(0, 10) })).filter(x => x.t).map(x => `・略称: "${x.t}" (開催初日: ${x.d || '未定'})`).join('\n') || '（まだ登録なし）';
      let data = null;
      try {
        const res = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(existingNames, pageData.links, text) }] }],
            safetySettings: ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT'].map(c => ({ category: `HARM_CATEGORY_${c}`, threshold: 'BLOCK_NONE' })),
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json', maxOutputTokens: 4096 } }),
        });
        if (!res) { await recordLog(article.url, title, 'エラー', null); continue; }
        const result = await res.json();
        if (result.candidates?.length) {
          const raw = result.candidates[0].content.parts[0].text;
          try { const m = raw.match(/\{[\s\S]*\}/); data = m ? JSON.parse(m[0]) : JSON.parse(raw); }
          catch (e) { console.log(' ├─ ⚠️ JSONの解析に失敗しました。次回に再試行します。'); await recordLog(article.url, title, 'エラー', null); continue; }
        } else { console.log(` ├─ ❌ AIブロック: ${JSON.stringify(result.promptFeedback || {})}`); await recordLog(article.url, title, 'エラー', null); continue; }
      } catch (e) { console.log(` ├─ ⚠️ 通信処理エラー: ${e.message}`); continue; }

      const evs = Array.isArray(data?.events) ? data.events : [];
      if (!data || data.is_target_live === false || !evs.length) {
        console.log(' ├─ ⏩ スキップ: AI判定により非対象');
        await recordLog(article.url, title, '非対象', null); handled++;
        await sleep(6000); continue;
      }
      let firstLive = null;
      for (const ev of evs) {
        try { const lv = await applyEvent(ev, article); firstLive = firstLive || lv; processed++; }
        catch (e) { warn(`「${ev.short_name || ev.full_official_name}」の反映に失敗: ${e.message}`); }
      }
      await recordLog(article.url, title, '対象', firstLive); handled++;
      console.log(' ├─ ⏳ APIレート制限回避のため12秒待機します...');
      await sleep(12000);
    }
    console.log(`\n🎉 全処理完了！ 反映したイベント（延べ件数）: ${processed}件`);
    await syncEventsJson();
  } catch (error) {
    console.error('致命的なエラー:', error); process.exitCode = 1;
  } finally {
    await browser.close();
  }
  if (warns.length) { console.log(`\n⚠️ 確認が必要な点 (${warns.length}件)`); warns.forEach(w => console.log(' - ' + w)); }
}

module.exports = { S, loadAll, applyEvent, buildEvents, buildBodyBlocks, pickCurrent, slotState, recordLog, isProcessed, syncEventsJson,
  parseLabelDate, enforceShortName, normalizeBrands, buildPenlightUrl, cleanCastList, toNotionDate, put, relName, dkey, warns };
if (require.main === module) run();
