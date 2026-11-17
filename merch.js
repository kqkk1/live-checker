'use strict';
/**
 * 物販情報の読み取り（純粋な関数だけ。Notionやブラウザには触れない）
 *
 * 各ライブの公式特設サイトには GOODS のページ（例: .../live_event/<名前>/goods/final.php）があり、
 *   ・会場物販 … 物販日時・物販場所・「デジタル注文書はこちら」のリンク
 *   ・整理券   … 受付URL・受付期間・当落発表
 *   ・事前販売 … アソビストア等の販売ページへのバナー（リンク）
 * が載っている。ここでは、その本文とリンク一覧から、情報を取り出す。
 */
const KIND_ORDER = ['会場物販', '整理券', '事前販売'];

/** 公式ページのURLから、物販ページの候補URLを作る */
function deriveGoodsUrls(officialUrl) {
  if (!officialUrl || !/^https?:\/\/idolmaster-official\.jp\/live_event\//.test(officialUrl)) return [];
  const out = [];
  const m = officialUrl.match(/^(https?:\/\/idolmaster-official\.jp\/live_event\/[^/]+\/)information\/([^/?#]+)/);   // 例: .../information/final.php → .../goods/final.php
  if (m) out.push(`${m[1]}goods/${m[2]}`);
  const base = officialUrl.match(/^(https?:\/\/idolmaster-official\.jp\/live_event\/[^/?#]+\/)/);
  if (base) out.push(`${base[1]}goods/`);
  return [...new Set(out)];
}

/** 公式ページのナビゲーションから「GOODS」のリンクを探す（候補URLが見つからないときの予備） */
function pickGoodsLink(anchors, officialUrl) {
  const show = (String(officialUrl || '').match(/\/information\/([^/?#]+)/) || [])[1];
  const cand = anchors.filter(a => a.href && /\/goods(\/|\.php|$)/.test(a.href.replace(/[?#].*$/, '')) || /^(GOODS|グッズ|物販)/i.test((a.text || '').trim()));
  const hrefs = cand.map(a => a.href).filter(h => /idolmaster-official\.jp/.test(h) && !/#$/.test(h));   // 「#」だけのリンク（まだ物販ページがないサイトのナビ）は除く
  if (show) { const hit = hrefs.find(h => h.includes(`/${show}`)); if (hit) return hit; }
  return hrefs[0] || '';
}

/** 「デジタル注文書はこちら」のリンク（会場物販の事前注文書） */
function extractDigitalOrder(anchors) {
  const a = anchors.find(x => /デジタル注文書/.test(x.text || '') && x.href) || anchors.find(x => /qo-kun\.com/.test(x.href || ''));
  return a ? a.href : '';
}

const pad2 = n => String(n).padStart(2, '0');
const wdayJ = date => new Date(`${date}T00:00:00+09:00`).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
const mdw = date => `${+date.slice(5, 7)}/${+date.slice(8, 10)}(${wdayJ(date)})`;

/** 「物販日時」の各行 → 日ごとの開始・終了（例: 2026年11月7日(土) 10:00～17:00） */
function parseOnsiteDays(text) {
  const m = String(text).match(/物販日時\s*([\s\S]*?)物販場所/);
  if (!m) return [];
  return m[1].split('\n').map(x => x.trim()).filter(Boolean).map(line => {
    const date = (parseJpPoints(line)[0] || '').slice(0, 10);
    const t = line.match(/(\d{1,2}):(\d{2})\s*[～〜~\-]\s*(\d{1,2}):(\d{2})/);
    return date ? { date, line, open: t ? `${pad2(t[1])}:${t[2]}` : '', close: t ? `${pad2(t[3])}:${t[4]}` : '' } : null;
  }).filter(Boolean);
}

/**
 * 「整理券をお持ちでないお客様」のご案内開始（フリーで並べる時間）の予定を取り出す
 *   例: 「整理券をお持ちでないお客様を順次ご案内いたします。11月7日(土)、11月8日(日)とも11:00からを予定」
 *   → { '2026-11-07': '11:00', '2026-11-08': '11:00' }（時刻が1つなら全日、日ごとに時刻があれば日ごと）
 */
function extractFreeTimes(text, days) {
  const t = String(text), i = t.search(/整理券をお持ちでない/);
  if (i < 0 || !days.length) return {};
  const rest = t.slice(i), j = rest.indexOf('※', 1), seg = rest.slice(0, j > 0 ? j : 400);
  const times = [...seg.matchAll(/(\d{1,2}):(\d{2})\s*から/g)].map(m => `${pad2(m[1])}:${m[2]}`);
  if (!times.length) return {};
  const mds = [...seg.matchAll(/(\d{1,2})月\s*(\d{1,2})日/g)].map(m => `${pad2(m[1])}-${pad2(m[2])}`);
  const out = {};
  if (times.length === 1) days.forEach(d => { out[d.date] = times[0]; });
  else if (times.length === mds.length) mds.forEach((md, k) => { const d = days.find(x => x.date.slice(5) === md); if (d) out[d.date] = times[k]; });
  return out;
}

/** 会場物販の情報: 物販日時・場所・整理券の方の時間帯・フリーの時間帯
 *   整理券の時間帯 = 物販の開始 ～ フリー開始（ページに明記はなく、「整理券の方を先にご案内し、終わり次第フリー」の記載からの目安） */
function extractOnsite(text) {
  const days = parseOnsiteDays(text);
  const place = (String(text).match(/物販場所\s*([^\n]+)/) || [])[1];
  if (!days.length || !place) return null;
  const free = extractFreeTimes(text, days), sei = [], fr = [];
  for (const d of days) {
    const f = free[d.date];
    if (!f) continue;
    if (d.open && f > d.open) sei.push(`${mdw(d.date)} ${d.open}〜${f}頃`);
    fr.push(`${mdw(d.date)} ${f}頃〜${d.close}`);
  }
  return { dates: days.map(d => d.line).join('\n'), place: place.trim(), seiriken: sei.join('\n'), free: fr.join('\n') };
}

/** 「2026年10月23日(金)13:00～10月28日(水)23:59」のような日本語の日時を、ISO形式の配列にする（年の省略・曜日・時刻に対応） */
function parseJpPoints(str, baseYear) {
  const re = /(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日(?:\s*[（(][^）)]*[）)])?(?:\s*(\d{1,2})[:：](\d{2}))?/g;
  const pad = n => String(n).padStart(2, '0');
  const pts = []; let m, year = baseYear || new Date().getFullYear(), prev = 0;
  while ((m = re.exec(String(str)))) {
    if (m[1]) year = +m[1]; else if (+m[2] < prev) year += 1;   // 年が省略され、月が戻ったら翌年
    prev = +m[2];
    const date = `${year}-${pad(m[2])}-${pad(m[3])}`;
    pts.push(m[4] ? `${date}T${pad(m[4])}:${m[5]}` : date);
  }
  return pts;
}

/**
 * 物販整理券（ASOBI TICKET等の受付URL・期間・当落発表）
 *
 * 【混入防止の方針】
 *  ・読む範囲は、公式ページの GOODS 欄（#goodsCol）の本文だけ。呼び出し側が渡した本文を、ここでさらにページ全体へ広げない
 *  ・その中の「物販整理券受付」のブロックを1つだけ切り出し、URL・受付期間・当落発表を「同じブロックの中から」まとめて取る
 *  ・ブロックの中に無い項目は空のまま返す（ほかの場所の値や、ライブ行・受付枠の値で補わない）。足りない項目は missing に入れる
 */
const SEIRIKEN_HEAD = /物販整理券(?:受付)?/g;
const SEIRIKEN_STOP = /\n\s*(?:会場物販|事前販売|物販日時|物販場所|デジタル注文書|注意事項|【)/;

/** GOODS 欄の本文から「物販整理券受付」のブロックだけを切り出す（なければ ''） */
function findSeirikenBlock(goodsText) {
  const t = String(goodsText || '');
  const heads = [...t.matchAll(SEIRIKEN_HEAD)].map(m => ({ i: m.index, len: m[0].length }));
  for (let k = 0; k < heads.length; k++) {
    const from = heads[k].i + heads[k].len;
    let to = Math.min(t.length, from + 900);
    if (heads[k + 1]) to = Math.min(to, heads[k + 1].i);
    let seg = t.slice(from, to);
    const stop = seg.slice(20).search(SEIRIKEN_STOP);
    if (stop >= 0) seg = seg.slice(0, stop + 20);
    const second = seg.indexOf('受付URL', seg.indexOf('受付URL') + 1);   // 2つ目の「受付URL」から先は、別のブロック
    if (seg.indexOf('受付URL') >= 0 && second > 0) seg = seg.slice(0, second);
    if (/受付URL|受付期間/.test(seg)) return seg;
  }
  return '';
}

function extractSeiriken(goodsText, baseYear) {
  const block = findSeirikenBlock(goodsText);
  if (!block) return null;
  const url = (block.match(/受付URL\s*(https?:\/\/[^\s)\]]+)/) || [])[1] || '';
  const period = (block.match(/受付期間\s*([\s\S]{0,120}?)(?=受付URL|当落発表|※|$)/) || [])[1] || '';
  const lot = (block.match(/当落発表\s*([\s\S]{0,60}?)(?=受付URL|受付期間|※|\n\s*\n|$)/) || [])[1] || '';
  const [start, end] = parseJpPoints(period, baseYear);
  const lottery = parseJpPoints(lot, baseYear)[0] || '';
  const missing = [];
  if (!url) missing.push('URL'); if (!start) missing.push('開始'); if (!end) missing.push('締切'); if (!lottery) missing.push('当落発表');
  if (missing.length === 4) return null;
  return { kind: '整理券', name: '物販整理券', url, start: start || '', end: end || '', lottery, missing };
}

/** URLの比較用に整える（#・?以降と、末尾の / を除く） */
const urlKey = u => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

/**
 * 書き込み前の確認（整理券）
 *  ・URL が、同じライブのチケット受付のURLと同じ → URL・期間・当落を書かない（混入の疑い）
 *  ・開始・締切の両方が、チケット受付の期間とまったく同じ → 開始・締切を書かない（混入の疑い）
 * ticket = { urls: [チケット受付のURL], periods: [{start, end}] }（同じライブのもの）。sameDate は日時の比較関数
 */
function guardSeiriken(item, ticket, sameDate) {
  const out = { ...item }, notes = [];
  const bad = new Set((ticket?.urls || []).map(urlKey).filter(Boolean));
  if (out.url && bad.has(urlKey(out.url))) {
    notes.push(`整理券のURLが、同じライブのチケット受付のURLと同じです（${out.url}）。混入の疑いがあるため、この回は整理券を書き込みません`);
    return { item: null, notes };
  }
  if (out.start && out.end && (ticket?.periods || []).some(p => p.start && p.end && sameDate(out.start, p.start) && sameDate(out.end, p.end))) {
    notes.push(`整理券の開始・締切が、同じライブのチケット受付の期間とまったく同じです（${out.start} 〜 ${out.end}）。混入の疑いがあるため、開始・締切は書き込みません`);
    out.start = ''; out.end = '';
  }
  return { item: out, notes };
}

/** 事前販売（アソビストア等の特集ページ）へのリンク */
function extractPresaleLinks(anchors) {
  const byUrl = new Map();
  for (const a of anchors) {
    if (!a.href || !/asobistore\.jp\/feature\//.test(a.href)) continue;
    const url = a.href.replace(/[?#].*$/, '');
    const name = (a.text || a.alt || '').replace(/\s+/g, ' ').trim();
    const cur = byUrl.get(url);
    if (!cur || (!/事前/.test(cur) && /事前/.test(name)) || (!cur && name)) byUrl.set(url, name);
    else if (!byUrl.has(url)) byUrl.set(url, name);
  }
  return [...byUrl].map(([url, name]) => ({ kind: '事前販売', name: name || '事前販売', url }));
}

const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
/** 同じ名前とみなす（一方がもう一方を含む場合も同じ扱い） */
function sameName(a, b) { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); }

/** 本文の変化を検知するためのハッシュ用に、空白を詰めた文字列 */
const squash = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 30000);

/** 事前販売ページ（アソビストア等）の本文から、販売の回と期間を取り出すための依頼文 */
function buildPresalePrompt(liveName, text) {
  return `以下は、イベント「${liveName}」の公式グッズ「事前販売」ページの本文です。販売（受注）の回ごとに、期間を抽出し、JSONだけを出力してください。Markdownブロックは不要です。

【ルール】
・"rounds" には、販売の回（第1弾・第2弾・ファイナル・追加販売など）を、1回につき1要素で入れてください。回が1つだけなら1要素です。
・"name" は、ページに書かれている回の名前（例: 「事前販売 ファイナル」）。名前がなければ「事前販売」としてください。
・"start" と "end" は、受注（受付）の開始日時と終了日時を 'YYYY-MM-DDTHH:mm'（時刻が不明なら 'YYYY-MM-DD'）で。不明なら空文字。
・グッズの発売日、お届け日、イベント開催日は、期間として入れないでください。受注・予約の受付期間だけを入れてください。
・年が書かれていない場合は、イベント開催時期に近い年にしてください。
・情報がなければ {"rounds": []} としてください。

【出力形式】
{ "rounds": [ { "name": "事前販売 ファイナル", "start": "2026-08-06T16:00", "end": "2026-08-16T23:59" } ] }

【本文】
${squash(text).slice(0, 9000)}`;
}

/** AIの返答の整形（日付の形式の確認と、不正な回の除外） */
function cleanRounds(data) {
  const ok = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(d.trim());
  const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
  return rounds.map(r => ({ name: String(r?.name || '事前販売').trim() || '事前販売', start: ok(r?.start) ? r.start.trim() : '', end: ok(r?.end) ? r.end.trim() : '' }))
    .filter(r => r.start || r.end);
}

module.exports = { findSeirikenBlock, urlKey, guardSeiriken, parseOnsiteDays, extractFreeTimes, KIND_ORDER, deriveGoodsUrls, pickGoodsLink, extractDigitalOrder, extractOnsite, parseJpPoints, extractSeiriken, extractPresaleLinks, sameName, squash, buildPresalePrompt, cleanRounds, norm };
