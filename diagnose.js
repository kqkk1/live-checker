'use strict';
/**
 * 原因の切り分け用（読み取りだけ。Notion は変更しない）
 *   node diagnose.js "SideMプロミ2027" "LP noctchill" "デレ15thPARTY"
 * 指定したライブについて、Notion に入っている値と、events.json に出る値を並べて表示する。
 * 申込記録（名前・精算）は読まない。
 */
const sn = require('./index.js');
const { S } = sn;
const pt = p => !p ? '' : p.type === 'title' ? p.title.map(t => t.plain_text).join('') : p.type === 'rich_text' ? p.rich_text.map(t => t.plain_text).join('')
  : p.type === 'select' ? (p.select?.name || '') : p.type === 'url' ? (p.url || '') : p.type === 'date' ? (p.date ? `${p.date.start}${p.date.end ? ' 〜 ' + p.date.end : ''}` : '')
  : p.type === 'number' ? (p.number ?? '') : p.type === 'checkbox' ? (p.checkbox ? '✔' : '') : p.type === 'relation' ? `[${(p.relation || []).length}件のリンク]` : '';
const title = (page, meta) => pt(page.properties[Object.entries(meta.properties).find(([, v]) => v.type === 'title')[0]]);
(async () => {
  const names = process.argv.slice(2);
  if (!names.length) { console.log('使い方: node diagnose.js "ライブの略称" ...'); return; }
  await sn.loadAll();
  const { events, issues } = sn.buildEvents(S);
  for (const n of names) {
    const live = S.live.pages.find(p => title(p, S.live.meta).includes(n));
    console.log(`\n==== ${n} ====`);
    if (!live) { console.log('ライブDBに見つかりません（略称を確認してください）'); continue; }
    const rel = (db, base) => sn.relName(db.meta, base);
    console.log('■ ライブ行:', ['ライブ開催日', '受付枠', '受付期間', '当落発表日', 'ロック'].map(k => `${k}=${pt(live.properties[k])}`).join(' / '));
    const slots = S.slot.pages.filter(p => (p.properties[rel(S.slot, 'ライブ')]?.relation || []).some(r => r.id === live.id));
    console.log(`■ 受付枠DB（${slots.length}件）`); slots.forEach(p => console.log('  -', ['枠名', '種別', '受付開始', '締切', '当落発表日', 'ロック'].map(k => `${k}=${pt(p.properties[k])}`).join(' / ')));
    const sch = S.sched.pages.filter(p => (p.properties[rel(S.sched, 'ライブ')]?.relation || []).some(r => r.id === live.id));
    console.log(`■ 公演日程DB（${sch.length}件）`); sch.forEach(p => console.log('  -', ['Day', '順番', '開演日時', '開場時刻', '公演名', '表示ラベル'].map(k => `${k}=${pt(p.properties[k])}`).join(' / '), ' 出演=', pt(p.properties['出演者']).split(',').filter(Boolean).length + '名'));
    const orphan = S.sched.pages.filter(p => !(p.properties[rel(S.sched, 'ライブ')]?.relation || []).length);
    if (orphan.length) console.log(`  ⚠️ ライブへのリンクが空の公演行が ${orphan.length}件あります（events.json には出ません）: ` + orphan.map(p => title(p, S.sched.meta)).join(' / '));
    if (S.merch) { const ms = S.merch.pages.filter(p => (p.properties[rel(S.merch, 'ライブ')]?.relation || []).some(r => r.id === live.id)); console.log(`■ 物販DB（${ms.length}件）`); ms.forEach(p => console.log('  -', ['種別', '名称', 'URL', '開始', '締切', '当落発表', 'ロック'].map(k => `${k}=${pt(p.properties[k])}`).join(' / '))); }
    const logs = S.log.pages.filter(p => (p.properties[rel(S.log, 'ライブ')]?.relation || []).some(r => r.id === live.id));
    console.log(`■ 取得ログDB（このライブに紐づく記事 ${logs.length}件）`); logs.forEach(p => console.log('  -', title(p, S.log.meta), '/ 判定=' + pt(p.properties['判定']), '/ 再処理=' + (pt(p.properties['再処理']) || '□')));
    console.log('■ 列の有無: ライブDBの「XR」=' + (S.live.meta.properties['XR'] ? 'あり' : 'なし') + ' / 公演日程DBの「ペンライト対象外」=' + (S.sched.meta.properties['ペンライト対象外'] ? 'あり' : 'なし') + ' / 「公演名」=' + (S.sched.meta.properties['公演名'] ? 'あり' : 'なし'));
    const ev = events.find(e => e.id === live.id);
    console.log('■ events.json に出る値:'); console.log(`  lotteryDate=${ev.lotteryDate || '(空)'} / 現在の枠=${ev.phase} / XR=${ev.isXR}`);
    ev.schedules.forEach(s => console.log('  公演:', s.label, `（出演${s.castCount}名 / ペンライト${s.penlightCastCount}名）`, /auto_cast/.test(s.penlightUrl) ? '' : ' ※auto_castなし'));
    (ev.merch || []).filter(m => m.kind === '整理券').forEach(m => console.log('  整理券:', m.url, m.start, m.end, m.lottery));
    issues.filter(m => m.startsWith(title(live, S.live.meta))).forEach(m => console.log('  ⚠️', m));
  }
})().catch(e => { console.error('エラー:', e.message); process.exit(1); });
