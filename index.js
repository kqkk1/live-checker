const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// API制限(429)やサーバー混雑(503)時の自動リトライ関数
async function fetchWithRetry(url, options, maxRetries = 4) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
            
            if (res.status === 429 || res.status === 503) {
                const waitTime = (i + 1) * 30000; 
                console.log(` ├─ ⚠️ API制限/混雑(${res.status})。${waitTime / 1000}秒待機して再試行します...(${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }
            
            const errorText = await res.text();
            console.log(` ├─ ❌ APIエラー発生 (HTTP ${res.status}): ${errorText}`);
            return null;
        } catch (err) {
            console.log(` ├─ ⚠️ 通信エラー: ${err.message}。再試行します...(${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 15000));
        }
    }
    console.log(` ├─ ❌ リトライ上限（${maxRetries}回）に到達しました。次の記事へ進みます。`);
    return null;
}

// 処理済みURLを安全に追記・整形する関数
function appendUrlToListString(currentUrlsText, newUrl) {
    const urlList = currentUrlsText ? currentUrlsText.split(',').map(u => u.trim()).filter(Boolean) : [];
    if (!urlList.includes(newUrl)) {
        urlList.push(newUrl);
    }
    return urlList.slice(-20).join(', ');
}

// AIが出力した略称を整える安全フィルター
function enforceShortName(shortName, fullName) {
    let target = (shortName && shortName.trim() !== "") ? shortName.trim() : fullName;
    
    target = target
        .replace(/PROJECT IM@S\s*/gi, '')
        .replace(/vα-liv/gi, 'ヴイアラ')
        .replace(/THE IDOLM@STER\s*/gi, '')
        .replace(/アイドルマスター\s*/g, '')
        .replace(/CINDERELLA GIRLS/gi, 'デレ')
        .replace(/シンデレラガールズ/g, 'デレ')
        .replace(/MILLION LIVE!/gi, 'ミリオン')
        .replace(/ミリオンライブ！?/g, 'ミリオン')
        .replace(/SHINY COLORS/gi, 'シャニ')
        .replace(/シャイニーカラーズ/g, 'シャニ')
        .replace(/SideM/gi, 'SideM')
        .replace(/学園アイドルマスター/g, '学マス')
        .replace(/Anniversary/gi, '周年')
        .replace(/Memorial/gi, '')
        .replace(/Orchestra Concert/gi, 'オケコン')
        .replace(/\s+/g, ' ')
        .trim();

    target = target.replace(/(\d+(?:st|nd|rd|th))\s*PM\s*/gi, '$1');
    return target;
}

// イベント内容やタイトルから最適な絵文字アイコンを自動判定する関数
function selectEventEmoji(ev, fullOfficialName) {
    const validEmojis = ["🎤", "✨", "🎻", "🤝", "🎪"];
    if (ev.icon_emoji && validEmojis.includes(ev.icon_emoji.trim())) {
        return ev.icon_emoji.trim();
    }
    const target = `${fullOfficialName} ${ev.short_name || ""}`;
    if (/オーケストラ|オケコン|Orchestra|音楽祭/i.test(target)) return "🎻";
    if (/xR|MR|vα-liv|ヴイアラ|Streaming/i.test(target)) return "✨";
    if ((/PRODUCER MEETING|プロミ|ファンミ|トーク|挨拶/i.test(target)) && !/LIVE/i.test(target)) return "🤝";
    return "🎤";
}

// ブランド名の表記揺れを統一してマルチセレクト用の配列にする関数
function normalizeBrands(brandsArray, fullOfficialName) {
    const rawList = Array.isArray(brandsArray) ? [...brandsArray] : [];
    const normalized = new Set();

    const checkAndAdd = (str) => {
        if (/765|ALLSTARS|AS/i.test(str)) normalized.add("765AS");
        if (/デレ|CINDERELLA|シンデレラ/i.test(str)) normalized.add("デレマス");
        if (/ミリ|MILLION/i.test(str)) normalized.add("ミリオン");
        if (/シャニ|SHINY/i.test(str)) normalized.add("シャニマス");
        if (/SideM|サイドエム/i.test(str)) normalized.add("SideM");
        if (/学マス|学園/i.test(str)) normalized.add("学マス");
        if (/ヴイアラ|vα-liv/i.test(str)) normalized.add("ヴイアラ");
        if (/876|ディアリースターズ/i.test(str)) normalized.add("876");
    };

    rawList.forEach(b => checkAndAdd(String(b)));
    if (normalized.size === 0 && fullOfficialName) {
        checkAndAdd(fullOfficialName);
    }
    return Array.from(normalized);
}

// 特別カラー対象ライブ（REFRAC7IONS等）かどうかを自動判定する関数
function isSpecialColorEvent(ev, fullOfficialName) {
    if (ev.is_special_color === true) return true;
    const target = `${fullOfficialName || ""} ${ev.short_name || ""}`;
    return /REFRAC7IONS|リフラクションズ/i.test(target);
}

// 出演者名の配列をクレンジング・重複排除する関数
function cleanCastList(castArray) {
    if (!Array.isArray(castArray)) return [];
    const cleaned = castArray
        .map(name => String(name).replace(/（.*?）|\(.*?\)/g, '').replace(/\s+/g, '').trim())
        .filter(Boolean);
    return Array.from(new Set(cleaned));
}

// 出演者リストと特別カラーフラグからペンライト設定サイトの専用URLを生成する関数
function buildPenlightUrl(castArray, isSpecial = false) {
    const baseUrl = "https://penlight-supporter.onrender.com/setlist";
    const cleanedCast = cleanCastList(castArray);
    
    if (cleanedCast.length === 0) {
        return isSpecial ? `${baseUrl}?special=1` : baseUrl;
    }

    let castStr = "";
    for (const name of cleanedCast) {
        const nextStr = castStr ? `${castStr},${name}` : name;
        const encoded = encodeURIComponent(nextStr);
        if ((baseUrl.length + 25 + encoded.length) > 1900) {
            break;
        }
        castStr = nextStr;
    }
    const query = `auto_cast=${encodeURIComponent(castStr)}${isSpecial ? "&special=1" : ""}`;
    return `${baseUrl}?${query}`;
}

// ★修正版：スケジュール配列からNotionの箇条書き＋ペンライトURLブロック群（昼夜個別URL対応版）を生成する関数
function buildScheduleBlocks(schedules, isSpecialColor = false) {
    const blocks = [];
    if (!Array.isArray(schedules)) return blocks;

    schedules.forEach((schedObj, idx) => {
        const isObject = typeof schedObj === 'object' && schedObj !== null;
        const schedText = isObject ? (schedObj.text || "") : String(schedObj);
        const schedLabel = isObject && schedObj.label ? schedObj.label : `Day${idx + 1}`;
        const rawCastList = (isObject && Array.isArray(schedObj.cast)) ? cleanCastList(schedObj.cast) : [];

        let subSchedules = [];
        if (isObject && Array.isArray(schedObj.sub_schedules) && schedObj.sub_schedules.length > 0) {
            subSchedules = schedObj.sub_schedules;
        } else if (schedText.includes("昼公演") && schedText.includes("夜公演")) {
            subSchedules = [
                { label: `${schedLabel} 昼公演`, cast: rawCastList },
                { label: `${schedLabel} 夜公演`, cast: rawCastList }
            ];
        } else {
            subSchedules = [{ label: schedLabel, cast: rawCastList }];
        }

        const childParagraphs = [];

        subSchedules.forEach(sub => {
            const subLabel = sub.label || schedLabel;
            const subCast = cleanCastList(sub.cast || rawCastList);

            const normalUrl = buildPenlightUrl(subCast, false);
            const specialUrl = buildPenlightUrl(subCast, true);
            const castCountText = subCast.length > 0 ? `（出演: ${subCast.length}名 自動セット）` : `（手動セット画面へ）`;

            let paragraphRichText = [];
            if (isSpecialColor) {
                paragraphRichText = [
                    { type: "text", text: { content: "🎨 " } },
                    { 
                        type: "text", 
                        text: { 
                            content: `${subLabel} のペンライト設定を作成する【特別カラー対応】${castCountText}`, 
                            link: { url: specialUrl } 
                        },
                        annotations: { bold: true, color: "purple" }
                    },
                    { type: "text", text: { content: " ｜ " }, annotations: { color: "gray" } },
                    { 
                        type: "text", 
                        text: { 
                            content: "通常色で作成", 
                            link: { url: normalUrl } 
                        },
                        annotations: { color: "gray" }
                    }
                ];
            } else {
                paragraphRichText = [
                    { type: "text", text: { content: "🪄 " } },
                    { 
                        type: "text", 
                        text: { 
                            content: `${subLabel} のペンライト設定を作成する${castCountText}`, 
                            link: { url: normalUrl } 
                        },
                        annotations: { bold: true, color: "purple" }
                    }
                ];
            }

            childParagraphs.push({
                object: "block",
                type: "paragraph",
                paragraph: {
                    rich_text: paragraphRichText
                }
            });
        });

        blocks.push({
            object: "block",
            type: "bulleted_list_item",
            bulleted_list_item: {
                rich_text: [{ type: "text", text: { content: schedText }, annotations: { bold: true } }],
                children: childParagraphs
            }
        });
    });
    return blocks;
}

// 既存ページのサイドピーク内にあるスケジュール＆ペンライトURLを最新情報で更新する関数
async function updatePageSchedulesAndCast(pageId, newSchedules, isSpecialColor = false) {
    if (!Array.isArray(newSchedules) || newSchedules.length === 0) return false;

    try {
        const existingBlocksRes = await notion.blocks.children.list({ block_id: pageId });
        const existingBullets = existingBlocksRes.results.filter(b => b.type === "bulleted_list_item");

        const oldSchedulesData = [];
        let existingHadSpecial = false;

        for (const bullet of existingBullets) {
            const oldText = bullet.bulleted_list_item?.rich_text?.map(r => r.plain_text).join("") || "";
            let oldCast = [];
            if (bullet.has_children) {
                try {
                    const childrenRes = await notion.blocks.children.list({ block_id: bullet.id });
                    for (const child of childrenRes.results) {
                        const richTexts = child.paragraph?.rich_text || [];
                        for (const rt of richTexts) {
                            const urlStr = rt.href || rt.text?.link?.url || "";
                            if (urlStr.includes("special=1")) {
                                existingHadSpecial = true;
                            }
                            if (urlStr.includes("auto_cast=") && oldCast.length === 0) {
                                const urlObj = new URL(urlStr);
                                const castParam = urlObj.searchParams.get("auto_cast");
                                if (castParam) {
                                    oldCast = castParam.split(",").map(s => s.trim()).filter(Boolean);
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
            oldSchedulesData.push({ id: bullet.id, text: oldText, cast: oldCast });
        }

        const hasNewCast = newSchedules.some(s => {
            if (Array.isArray(s.cast) && s.cast.length > 0) return true;
            if (Array.isArray(s.sub_schedules) && s.sub_schedules.some(sub => Array.isArray(sub.cast) && sub.cast.length > 0)) return true;
            return false;
        });
        const hasDetailedText = newSchedules.some(s => s.text && (s.text.includes("開場") || s.text.includes("開演") || s.text.includes("[")));

        if (!hasNewCast && !hasDetailedText && oldSchedulesData.length > 0) {
            return false;
        }

        const mergedSchedules = newSchedules.map((newSched, idx) => {
            const isObj = typeof newSched === 'object' && newSched !== null;
            const label = isObj && newSched.label ? newSched.label : `Day${idx + 1}`;
            const newText = isObj ? (newSched.text || "") : String(newSched);
            const newCast = isObj && Array.isArray(newSched.cast) ? cleanCastList(newSched.cast) : [];

            const matchedOld = oldSchedulesData.find(old => old.text.includes(label)) || oldSchedulesData[idx];

            let finalText = newText;
            if (matchedOld && matchedOld.text) {
                const isNewTextBrief = !newText.includes("開演") && matchedOld.text.includes("開演");
                if (!newText || isNewTextBrief) {
                    finalText = matchedOld.text;
                }
            }

            const oldCast = matchedOld ? matchedOld.cast : [];
            const finalCast = cleanCastList([...oldCast, ...newCast]);
            
            let finalSubSchedules = [];
            if (isObj && Array.isArray(newSched.sub_schedules)) {
                finalSubSchedules = newSched.sub_schedules.map(sub => ({
                    label: sub.label,
                    cast: cleanCastList([...oldCast, ...(sub.cast || [])])
                }));
            }

            return {
                label: label,
                text: finalText || `${label}`,
                cast: finalCast,
                sub_schedules: finalSubSchedules
            };
        });

        for (const oldItem of oldSchedulesData) {
            try {
                await notion.blocks.delete({ block_id: oldItem.id });
            } catch (e) {}
        }

        const finalSpecialFlag = isSpecialColor || existingHadSpecial;
        const newBlocks = buildScheduleBlocks(mergedSchedules, finalSpecialFlag);
        if (newBlocks.length > 0) {
            await notion.blocks.children.append({
                block_id: pageId,
                children: newBlocks
            });
        }
        return true;
    } catch (err) {
        console.log(` ├─ ⚠️ サイドピーク内のブロック更新中に軽微なエラー: ${err.message}`);
        return false;
    }
}

// 指定されたNotionデータベースを読み込み＆スキーマ確認・初期修復する関数
async function loadDatabaseState(dbId, label) {
    const state = { id: dbId, label, pages: [], processedUrls: new Set(), listForAI: [], hasBrandProp: false };
    if (!dbId) return null;

    try {
        const dbMeta = await notion.databases.retrieve({ database_id: dbId });
        if (dbMeta.properties && dbMeta.properties["ブランド"]?.type === "multi_select") {
            state.hasBrandProp = true;
        }
    } catch (e) {}

    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
        const dbQuery = await notion.databases.query({
            database_id: dbId,
            start_cursor: startCursor
        });
        state.pages.push(...dbQuery.results);
        hasMore = dbQuery.has_more;
        startCursor = dbQuery.next_cursor;
    }

    for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];
        const titleText = page.properties["名前"]?.title?.[0]?.plain_text || "";
        const startDate = page.properties["ライブ開催日"]?.date?.start || "";

        const cleanedTitle = enforceShortName(titleText, titleText);
        if (titleText && cleanedTitle !== titleText && (titleText.length > 28 || /\d+(?:st|nd|rd|th)\s*PM/i.test(titleText))) {
            console.log(` ├─ 🔧 [${label}] タイトル自動修復: 『${titleText}』→『${cleanedTitle}』`);
            try {
                const fixedPage = await notion.pages.update({
                    page_id: page.id,
                    properties: { "名前": { title: [{ text: { content: cleanedTitle } }] } }
                });
                state.pages[i] = fixedPage;
            } catch (e) {}
        }

        const currentTitle = state.pages[i].properties["名前"]?.title?.[0]?.plain_text || "";
        if (currentTitle) {
            state.listForAI.push(`・略称: "${currentTitle}" (開催初日: ${startDate || "未定"})`);
        }

        const urlsText = state.pages[i].properties["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
        if (urlsText) {
            urlsText.split(',').map(u => u.trim()).filter(Boolean).forEach(u => state.processedUrls.add(u));
        }
    }
    console.log(` ├─ [${label}] 登録済みライブ枠: ${state.pages.length}件 / 記憶済み記事URL: ${state.processedUrls.size}件 / ブランドタグ列: ${state.hasBrandProp ? "あり" : "なし"}`);
    return state;
}

// 指定されたDBに対して非対象URLを記憶させる関数
async function recordSkippedUrlToDb(dbState, url) {
    if (!dbState || dbState.pages.length === 0 || dbState.processedUrls.has(url)) return;
    const memoPage = dbState.pages[0];
    const currentUrls = memoPage.properties["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
    const updatedUrls = appendUrlToListString(currentUrls, url);
    try {
        const updatedMemoPage = await notion.pages.update({
            page_id: memoPage.id,
            properties: { "処理済みURL": { rich_text: [{ text: { content: updatedUrls } }] } }
        });
        dbState.pages[0] = updatedMemoPage;
        dbState.processedUrls.add(url);
    } catch (e) {}
}

// 抽出されたイベント群を指定されたDBへ登録・更新する関数
async function applyEventsToDb(dbState, eventsList, article) {
    if (!dbState || dbState.processedUrls.has(article.url)) return 0;
    const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    let count = 0;

    for (const ev of eventsList) {
        const fullOfficialName = ev.full_official_name || ev.base_live_name || article.title || "アイマスイベント";
        const displayShortName = enforceShortName(ev.short_name, fullOfficialName);
        const emojiIcon = selectEventEmoji(ev, fullOfficialName);
        const brandsList = normalizeBrands(ev.brands, fullOfficialName);
        const specialColorFlag = isSpecialColorEvent(ev, fullOfficialName);

        let targetPage = null;
        if (isValidDate(ev.live_date)) {
            targetPage = dbState.pages.find(p => {
                const startDate = p.properties["ライブ開催日"]?.date?.start || "";
                return startDate === ev.live_date;
            });
        }
        if (!targetPage) {
            targetPage = dbState.pages.find(p => {
                const titleText = p.properties["名前"]?.title?.[0]?.plain_text || "";
                return titleText !== "" && (titleText === displayShortName || titleText === fullOfficialName);
            });
        }

        if (!targetPage) {
            const notionPayload = {
                "名前": { title: [{ text: { content: displayShortName } }] },
                "処理済みURL": { rich_text: [{ text: { content: article.url } }] }
            };

            if (dbState.hasBrandProp && brandsList.length > 0) {
                notionPayload["ブランド"] = { multi_select: brandsList.map(b => ({ name: b })) };
            }
            if (ev.ticket_tier) notionPayload["受付枠"] = { rich_text: [{ text: { content: ev.ticket_tier } }] };
            if (isValidDate(ev.deadline_date)) notionPayload["締切日"] = { date: { start: ev.deadline_date } };
            if (isValidDate(ev.result_date_notion)) notionPayload["当落発表日"] = { date: { start: ev.result_date_notion } };
            
            if (isValidDate(ev.live_date)) {
                const dateObj = { start: ev.live_date };
                if (isValidDate(ev.live_end_date) && ev.live_date !== ev.live_end_date) {
                    dateObj.end = ev.live_end_date;
                }
                notionPayload["ライブ開催日"] = { date: dateObj };
            }

            const linkUrl = (ev.official_url && ev.official_url.startsWith('http')) ? ev.official_url : article.url;
            const venueName = ev.venues || "未定";
            const stationInfo = ev.nearest_station || "情報なし";

            let venueRichText = [];
            if (venueName !== "未定") {
                const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueName)}`;
                const officialSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(venueName + " 公式 アクセス")}`;
                
                venueRichText = [
                    { type: "text", text: { content: "会場：" }, annotations: { bold: true } },
                    { type: "text", text: { content: `${venueName} (🗺️マップ)`, link: { url: mapUrl } }, annotations: { bold: true } },
                    { type: "text", text: { content: " ｜ " } },
                    { type: "text", text: { content: "🌐公式アクセス情報", link: { url: officialSearchUrl } } },
                    { type: "text", text: { content: `\n🚃 最寄り駅：${stationInfo}` } }
                ];
            } else {
                venueRichText = [
                    { type: "text", text: { content: "会場：未定" } }
                ];
            }

            const childrenBlocks = [
                { 
                    object: "block", 
                    type: "callout", 
                    callout: { 
                        icon: { type: "emoji", emoji: "🔗" },
                        color: "blue_background",
                        rich_text: [{ type: "text", text: { content: `${fullOfficialName} (イベント公式サイトへ)`, link: { url: linkUrl } }, annotations: { bold: true } }] 
                    } 
                },
                { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📍 開催・アクセス・ペンライト連携" } }] } },
                { 
                    object: "block", 
                    type: "callout", 
                    callout: { 
                        icon: { type: "emoji", emoji: "🏟️" },
                        color: "gray_background",
                        rich_text: venueRichText
                    } 
                },
                ...buildScheduleBlocks(ev.schedules, specialColorFlag)
            ];

            const newPage = await notion.pages.create({
                parent: { database_id: dbState.id },
                icon: { type: "emoji", emoji: emojiIcon },
                properties: notionPayload,
                children: childrenBlocks
            });
            console.log(` ├─ ⭐ [${dbState.label}] 新規登録: ${emojiIcon}『${displayShortName}』（期間: ${ev.live_date}〜${ev.live_end_date || ev.live_date}${specialColorFlag ? " / 🎨特別カラー対応" : ""}）`);
            
            dbState.pages.push(newPage);
            dbState.listForAI.push(`・略称: "${displayShortName}" (開催初日: ${ev.live_date || "未定"})`);
            count++;
        } else {
            const props = targetPage.properties;
            const updatePayload = {
                "名前": { title: [{ text: { content: displayShortName } }] }
            };

            const currentUrlsText = props["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
            const updatedUrlsText = appendUrlToListString(currentUrlsText, article.url);
            updatePayload["処理済みURL"] = { rich_text: [{ text: { content: updatedUrlsText } }] };

            if (dbState.hasBrandProp && brandsList.length > 0) {
                updatePayload["ブランド"] = { multi_select: brandsList.map(b => ({ name: b })) };
            }
            if (isValidDate(ev.deadline_date)) {
                updatePayload["締切日"] = { date: { start: ev.deadline_date } };
            }
            if (isValidDate(ev.result_date_notion)) {
                updatePayload["当落発表日"] = { date: { start: ev.result_date_notion } };
            }
            if (ev.ticket_tier) {
                updatePayload["受付枠"] = { rich_text: [{ text: { content: ev.ticket_tier } }] };
            }
            if (isValidDate(ev.live_date)) {
                const dateObj = { start: ev.live_date };
                if (isValidDate(ev.live_end_date) && ev.live_date !== ev.live_end_date) {
                    dateObj.end = ev.live_end_date;
                }
                updatePayload["ライブ開催日"] = { date: dateObj };
            }

            const updateParams = { page_id: targetPage.id, properties: updatePayload };
            if (!targetPage.icon) {
                updateParams.icon = { type: "emoji", emoji: emojiIcon };
            }

            const updatedPage = await notion.pages.update(updateParams);
            const isBodyUpdated = await updatePageSchedulesAndCast(targetPage.id, ev.schedules, specialColorFlag);
            console.log(` ├─ 🔄 [${dbState.label}] 既存更新: ${emojiIcon}『${displayShortName}』のプロパティ${isBodyUpdated ? "＆出演者ペンライトURL" : ""}を最新化！`);
            
            const idx = dbState.pages.findIndex(p => p.id === targetPage.id);
            if (idx !== -1) dbState.pages[idx] = updatedPage;
            count++;
        }
    }

    dbState.processedUrls.add(article.url);
    return count;
}

// ★修正版：Notion全件から GitHub Pages 用の events.json を同期生成する関数（キャスト・URL完全復元対応版）
async function syncNotionToEventsJson(notionClient, targetDbId) {
    if (!targetDbId) {
        console.log('⚠️ events.json 出力用のDB IDが指定されていません。');
        return;
    }

    console.log('\n🌐 Notionから全イベントデータを読み取って events.json を生成中（キャスト復元強化版）...');
    const pages = [];
    let cursor = undefined;

    do {
        const res = await notionClient.databases.query({
            database_id: targetDbId,
            start_cursor: cursor,
            page_size: 100,
        });
        pages.push(...res.results);
        cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    const getText = (richTextArr = []) => richTextArr.map(t => t.plain_text).join('').trim();
    const findProp = (props, types, keywords) => {
        for (const [key, val] of Object.entries(props)) {
            if (types.includes(val.type) && keywords.some(k => key.includes(k))) return val;
        }
        return null;
    };

    const eventsList = [];

    for (const page of pages) {
        const props = page.properties || {};

        const titleProp = Object.values(props).find(p => p.type === 'title');
        const title = titleProp ? getText(titleProp.title) : '無題のイベント';
        if (!title) continue;

        const icon = page.icon?.type === 'emoji' ? page.icon.emoji : '🎤';

        const brandProp = findProp(props, ['multi_select', 'select'], ['ブランド', 'Brand']);
        let brands = [];
        if (brandProp?.type === 'multi_select') {
            brands = brandProp.multi_select.map(o => o.name);
        } else if (brandProp?.type === 'select' && brandProp.select) {
            brands = [brandProp.select.name];
        }

        const phaseProp = findProp(props, ['rich_text', 'select'], ['受付', '枠', '先行', 'ステータス']);
        const phase = phaseProp?.type === 'rich_text'
            ? getText(phaseProp.rich_text)
            : (phaseProp?.select?.name || '');

        const deadlineProp = findProp(props, ['date'], ['締切', '申込']);
        const lotteryProp = findProp(props, ['date'], ['当落', '発表']);
        const eventDateProp = findProp(props, ['date'], ['開催', '日程', '日時', '日付']);

        const deadline = deadlineProp?.date?.start ? deadlineProp.date.start.slice(0, 10) : '';
        const lotteryDate = lotteryProp?.date?.start ? lotteryProp.date.start.slice(0, 10) : '';
        const eventDateStart = eventDateProp?.date?.start ? eventDateProp.date.start.slice(0, 10) : '';
        const eventDateEnd = eventDateProp?.date?.end ? eventDateProp.date.end.slice(0, 10) : eventDateStart;

        const urlProp = findProp(props, ['url'], ['公式', 'URL', 'リンク']);
        let officialUrl = urlProp?.url || '';

        let venue = '';
        let mapUrl = '';
        let accessUrl = '';
        let nearestStation = '';
        let isSpecialColor = false;
        const schedules = [];

        try {
            const blocksRes = await notionClient.blocks.children.list({
                block_id: page.id,
                page_size: 100,
            });

            for (let i = 0; i < blocksRes.results.length; i++) {
                const block = blocksRes.results[i];

                if (block.type === 'callout') {
                    const text = getText(block.callout.rich_text);
                    const links = block.callout.rich_text
                        .filter(t => t.href)
                        .map(t => ({ text: t.plain_text, href: t.href }));

                    if (text.includes('会場：') || block.callout.icon?.emoji === '🏟️') {
                        const lines = text.split('\n');
                        const venueLine = lines.find(l => l.includes('会場：')) || lines[0] || '';
                        venue = venueLine.replace(/.*会場：/, '').replace(/\(🗺️.*$/, '').replace(/｜.*$/, '').trim();

                        const stLine = lines.find(l => l.includes('最寄り駅：'));
                        if (stLine) nearestStation = stLine.replace(/.*最寄り駅：/, '').trim();

                        const mLink = links.find(l => l.text.includes('マップ') || l.href.includes('maps'));
                        const aLink = links.find(l => l.text.includes('アクセス') || l.href.includes('search'));
                        if (mLink) mapUrl = mLink.href;
                        if (aLink) accessUrl = aLink.href;
                    } else if (!officialUrl && links.length > 0) {
                        officialUrl = links[0].href;
                    }
                }

                // 箇条書き（スケジュール行）の処理：階層ズレやテキスト直打ちでもリンクを再構築
                if (block.type === 'bulleted_list_item') {
                    const richTexts = block.bulleted_list_item.rich_text || [];
                    const fullText = getText(richTexts);
                    const label = fullText.split('\n')[0] || fullText;

                    let penlightUrl = '';
                    let castNames = [];

                    const allLinks = [];
                    richTexts.forEach(t => { if (t.href) allLinks.push(t.href); });

                    if (block.has_children) {
                        try {
                            const childrenRes = await notionClient.blocks.children.list({ block_id: block.id });
                            for (const child of childrenRes.results) {
                                const childTexts = child.paragraph?.rich_text || [];
                                childTexts.forEach(ct => { if (ct.href) allLinks.push(ct.href); });
                                
                                // 子ブロックがただのテキストになっていてURLが含まれていない場合の自動救済
                                const childFullText = getText(childTexts);
                                if (!allLinks.length && childFullText.includes('出演:')) {
                                    const match = childFullText.match(/出演:\s*(\d+)名/);
                                    if (match) castNames = new Array(parseInt(match[1])).fill('');
                                }
                            }
                        } catch (e) {}
                    }

                    const penLink = allLinks.find(url => url.includes('penlight-supporter'));
                    if (penLink) {
                        penlightUrl = penLink;
                        try {
                            const u = new URL(penLink);
                            const castParam = u.searchParams.get('auto_cast') || u.searchParams.get('cast') || '';
                            if (castParam) {
                                castNames = castParam.split(',').map(s => s.trim()).filter(Boolean);
                            }
                            if (u.searchParams.get('special') === '1') isSpecialColor = true;
                        } catch (e) {}
                    }

                    // リンクが見つからなくても、「🪄」や「自動セット」の文字があれば仮のURLを再構築
                    if (!penlightUrl && (fullText.includes('🪄') || fullText.includes('自動セット'))) {
                         penlightUrl = `https://penlight-supporter.onrender.com/setlist`;
                    }

                    schedules.push({
                        label,
                        castCount: castNames.length,
                        castNames,
                        penlightUrl: penlightUrl || `https://penlight-supporter.onrender.com/setlist${castNames.length ? '?auto_cast=' + encodeURIComponent(castNames.join(',')) : ''}`
                    });
                }
            }
        } catch (err) {
            console.warn(` ⚠️ ページ詳細の読み取りスキップ (${title}): ${err.message}`);
        }

        if (venue && !mapUrl) mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue)}`;
        if (venue && !accessUrl) accessUrl = `https://www.google.com/search?q=${encodeURIComponent(venue + ' アクセス')}`;

        eventsList.push({
            id: page.id,
            icon, title, brands, phase, deadline, lotteryDate, eventDateStart, eventDateEnd,
            officialUrl, venue, mapUrl, accessUrl, nearestStation, isSpecialColor, schedules
        });
    }

    eventsList.sort((a, b) => (a.eventDateStart || a.deadline || '9999').localeCompare(b.eventDateStart || b.deadline || '9999'));

    const outPath = path.join(__dirname, 'events.json');
    fs.writeFileSync(outPath, JSON.stringify(eventsList, null, 2), 'utf8');
    console.log(`✅ events.json の同期完了！ (全 ${eventsList.length} 件のライブ情報を出力しました)`);
}

// -------------------------------------------------------------
// メイン処理（スナイパー本体）
// -------------------------------------------------------------
async function run() {
    console.log("🚀 スナイパー起動（単一DB・ポータルサイト連動・昼夜個別・URL自動復元対応版）");
    
    const dbId = process.env.NOTION_DB_ID;

    console.log("Notionの既存データを読み込み中...");
    let dbState = null;

    try {
        dbState = await loadDatabaseState(dbId, "📝アイマスライブ管理(自分用DB)");
    } catch (err) {
        console.error("⚠️ Notionの初期読み込みに失敗しました:", err.message);
        return;
    }

    if (!dbState) return;

    const sharedNonTargetUrls = new Set();
    if (dbState.pages.length > 0) {
        const firstPageUrls = dbState.pages[0].properties["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
        const urlArr = firstPageUrls.split(',').map(u => u.trim()).filter(Boolean);
        if (urlArr.length > 1) {
            urlArr.slice(1).forEach(u => sharedNonTargetUrls.add(u));
        }
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        console.log("ニュース一覧にアクセス中...");
        await page.goto('https://idolmaster-official.jp/news?category=live-event', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        
        const links = await page.$$eval('a', anchors => {
            return anchors
                .map(a => ({ url: a.href ? a.href.trim() : "", title: a.innerText ? a.innerText.trim() : "" }))
                .filter(a => 
                    a.url.startsWith('https://idolmaster-official.jp/news/') && 
                    !a.url.includes('category') && 
                    !a.url.includes('tag') &&
                    a.url.length > 38
                );
        });
        
        const uniqueUrls = new Map();
        for (const link of links) {
            if (!uniqueUrls.has(link.url)) {
                uniqueUrls.set(link.url, link);
            }
        }
        const articles = Array.from(uniqueUrls.values()).reverse();
        console.log(`抽出対象: ${articles.length}件`);
        
        let processedCount = 0;
        
        for (const article of articles) {
            console.log(`\n▶ 対象: ${article.title || article.url}`);
            
            const isProcessed = dbState.processedUrls.has(article.url);
            if (isProcessed || sharedNonTargetUrls.has(article.url)) {
                console.log(" ├─ ⏩ スキップ: 既にチェック済みの記事URLです（API消費ゼロ）");
                continue;
            }

            const title = article.title || "";
            if (title.includes("グッズ") || title.includes("Blu-ray") || title.includes("CD") || title.includes("配信") || title.includes("上映会") || title.includes("コラボ") || title.includes("展示") || title.includes("出展")) {
                console.log(" ├─ ⏩ スキップ: タイトルから対象外と判定");
                continue;
            }

            try {
                await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(2000);
            } catch (pageErr) {
                console.log(` ├─ ⚠️ ページ読み込みスキップ: ${pageErr.message}`);
                continue;
            }
            
            const pageData = await page.evaluate(() => {
                const mainEl = document.querySelector('main, article, .news-detail, #main') || document.body;
                const bodyText = mainEl ? mainEl.innerText : "";
                
                const extractedLinks = Array.from(document.querySelectorAll('a'))
                    .map(a => ({ text: (a.innerText || "").trim(), href: a.href || "" }))
                    .filter(l => 
                        l.href.startsWith('http') && 
                        !l.href.includes('/news/') && 
                        !l.href.includes('twitter.com') && 
                        !l.href.includes('x.com') &&
                        !l.href.includes('youtube.com') &&
                        (l.href.includes('live_event') || l.href.includes('idolmaster-official.jp') || l.text.includes('特設') || l.text.includes('公式') || l.text.includes('詳細') || l.text.includes('サイト'))
                    )
                    .map(l => `[${l.text || 'リンク'}](${l.href})`);
                
                const uniqueLinks = Array.from(new Set(extractedLinks)).slice(0, 20);
                return { text: bodyText, links: uniqueLinks.join('\n') };
            });

            const text = pageData.text;
            const hasTicket = text.includes("チケット") || text.includes("入場券") || text.includes("プロデューサーシート");
            const hasApply = text.includes("先行") || text.includes("抽選") || text.includes("一般発売") || text.includes("一般会員") || text.includes("受付");
            const hasAdditionalCast = title.includes("出演") || text.includes("追加出演") || text.includes("出演者追加") || text.includes("追加キャスト");
            
            if (!((hasTicket && hasApply) || hasAdditionalCast)) {
                console.log(" ├─ ⏩ スキップ: チケット申込または追加出演者の決定的なキーワードなし");
                continue;
            }
            
            console.log(" ├─ 🎯 新着情報を検知！ Geminiに全文解析＆出演者抽出を依頼します...");
            
            const existingNamesListStr = dbState.listForAI.length > 0 
                ? dbState.listForAI.join('\n') 
                : "（まだ登録なし）";

            // ★修正版：AIへの指示（昼夜分割ルール追加）
            const prompt = `以下のテキストおよびページ内リンク一覧からイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【最重要①：複数公演（ツアー・別都市・別週末）の分割ルール】
・もし1つの記事内に「名古屋公演（1/30〜1/31）」と「東京公演（3/21〜3/22）」のように、日程が離れた複数の公演（別会場・別週末）が含まれている場合は、必ず公演ごとに別々の要素として "events" 配列に分割して出力してください。
・同じ週末の連続するDay1とDay2は分割せず、1つの要素にまとめてください。

【最重要②：略称（short_name）の命名ルール】
現在データベースには以下のライブが登録されています。
${existingNamesListStr}
・既存リストと同じ公演であれば、表記揺れを防ぐため "short_name" は上記リストにある略称と一字一句一致させてください。
・複合イベントやナンバリングライブの場合は、"short_name" に『PM』を入れず『ヴイアラ3rd名古屋』のようにスッキリ命名してください。

【最重要③：nearest_station（最寄り駅）の記載ルール】
・会場から「距離が一番近い駅」と「多くの参加者が実際に利用する主要ターミナル駅」が異なる場合は、利便性のために必ずその2駅を併記してください。

【最重要④：schedules（各日の詳細スケジュールと出演アイドルの抽出）の記載ルール】
・"schedules" には、各公演をオブジェクトの配列として出力してください。
・★**もし同じ日に「昼公演」と「夜公演」がある場合は、必ず「昼公演」と「夜公演」で別々のオブジェクトとして2つに分割して出力してください。**（キャストが同じでも異なっていても必ず分けます）
  - 良い例（昼夜がある場合）：
    "schedules": [
      {
        "label": "Day2 昼公演",
        "text": "Day2 昼公演: 1月31日(日) [LIVE] 開場13:00/開演14:00",
        "cast": ["天海春香", "如月千早"]
      },
      {
        "label": "Day2 夜公演",
        "text": "Day2 夜公演: 1月31日(日) [LIVE] 開場17:00/開演18:00",
        "cast": ["高槻やよい", "萩原雪歩"]
      }
    ]
  - 良い例（1日1公演の場合）：
    "schedules": [
      {
        "label": "Day1",
        "text": "Day1: 1月30日(土) [PRODUCER MEETING] 開場16:00 / 開演17:00",
        "cast": ["灯里愛夏", "上水流宇宙", "レトラ"]
      }
    ]
・声優名（CV）やユニット名しか書かれていない場合でも、あなたの知識から該当するキャラクター名に変換・補完して出力してください。

【抽出フォーマット】
{
  "is_target_live": true,
  "events": [
    {
      "full_official_name": "イベントの正式フルタイトル（複数都市ある場合は都市名も補完）",
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
        {
          "label": "Day1",
          "text": "Day1: 1月30日(土) [LIVE] 開場16:30/開演17:30",
          "cast": ["灯里愛夏", "上水流宇宙", "レトラ"]
        }
      ],
      "ticket_tier": "現在募集している現地チケットの受付名称",
      "deadline_date": "上記受付の最終締切日（YYYY-MM-DD形式）",
      "result_date_notion": "上記受付の当落発表日（YYYY-MM-DD形式）"
    }
  ]
}

【厳格な判定ルール】
・is_target_live: 現地開催（リアル会場）があるアイマス関連の単独音楽ライブ、xRライブ、コンサート、PM、ファンミ、オーケストラであれば true。「遊園地等のコラボ」「上映会」「配信のみ」「外部フェス出展」は false。
・is_special_color: シャイニーカラーズの「REFRAC7IONS」シリーズ、または特別なシャッフル・特別カラー編成であることが明記されている特殊な公演のみ true。

【ページ内の主なリンク一覧】
${pageData.links}

【本文テキスト】
${text.substring(0, 12000)}`;
            
            let data = null;
            try {
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
                
                const res = await fetchWithRetry(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        safetySettings: [
                            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                        ],
                        generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 4096 }
                    })
                });
                
                if (res) {
                    const result = await res.json();
                    if (result.candidates && result.candidates.length > 0) {
                        const rawText = result.candidates[0].content.parts[0].text;
                        try {
                            const match = rawText.match(/\{[\s\S]*\}/);
                            data = match ? JSON.parse(match[0]) : JSON.parse(rawText);
                        } catch (parseErr) {
                            console.log(" ├─ ⚠️ JSONの解析に失敗しました。スキップします。");
                            continue;
                        }
                    } else if (result.promptFeedback) {
                        console.log(` ├─ ❌ AIブロック: ${JSON.stringify(result.promptFeedback)}`);
                        continue;
                    }
                } else {
                    continue;
                }
            } catch (e) {
                console.log(` ├─ ⚠️ 通信処理エラー: ${e.message}`);
                continue;
            }

            const eventsList = (data && Array.isArray(data.events)) ? data.events : [];

            if (!data || data.is_target_live === false || eventsList.length === 0) {
                console.log(` ├─ ⏩ スキップ: AI判定により非対象`);
                sharedNonTargetUrls.add(article.url);
                await recordSkippedUrlToDb(dbState, article.url);
                console.log(` ├─ 📝 非対象URLを記憶しました（次回から0秒スキップされます）`);
                await new Promise(resolve => setTimeout(resolve, 6000));
                continue;
            }
            
            // 自分用DB1つのみを更新する
            processedCount += await applyEventsToDb(dbState, eventsList, article);

            console.log(" ├─ ⏳ APIレート制限回避のため12秒待機します...");
            await new Promise(resolve => setTimeout(resolve, 12000));
        }
        console.log(`\n🎉 全処理完了！ 新規・更新枠（延べ件数）: ${processedCount}件`);
        
        // 最後に、自分用DBからポータル用の events.json を同期
        if (dbId) {
            await syncNotionToEventsJson(notion, dbId);
        }

    } catch (error) {
        console.error("致命的なエラー:", error);
    } finally {
        await browser.close();
    }
}

// 実行
run();
