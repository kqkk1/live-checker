const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ★ 追加：エラー時に自動で再チャレンジする「しぶとい」機能
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        const res = await fetch(url, options);
        if (res.ok) return res;
        
        if (res.status === 429 || res.status === 503) {
            const waitTime = (i + 1) * 10000; // 1回目は10秒、2回目は20秒、3回目は30秒待つ
            console.log(` ├─ ⚠️ Gemini APIエラー(${res.status})。${waitTime / 1000}秒後に自動リトライします...(${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
        }
        return res; // それ以外のエラーはそのまま返す
    }
    return null;
}

async function run() {
    console.log("🚀 スナイパー起動（自動リトライ搭載・最強エラー耐性版）");
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    try {
        console.log("ニュース一覧にアクセス中...");
        await page.goto('https://idolmaster-official.jp/news?category=live-event', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        
        const links = await page.$$eval('a', anchors => {
            return anchors.map(a => ({ url: a.href, title: a.innerText.trim() }))
                          .filter(a => a.url.includes('/news/') && !a.url.includes('category') && !a.url.includes('tag'));
        });
        
        const uniqueUrls = new Map();
        for (const link of links) {
            if (new URL(link.url).pathname.length > 6) uniqueUrls.set(link.url, link);
        }
        const articles = Array.from(uniqueUrls.values());
        console.log(`抽出対象: ${articles.length}件`);
        
        let processedCount = 0;
        for (const article of articles) {
            console.log(`\n▶ 対象: ${article.title || article.url}`);
            
            const title = article.title || "";
            if (title.includes("グッズ") || title.includes("Blu-ray") || title.includes("CD") || title.includes("配信") || title.includes("上映会") || title.includes("コラボ") || title.includes("展示") || title.includes("出展")) {
                console.log(" ├─ ⏩ スキップ: タイトルから対象外(グッズ/上映/コラボ等)と判定");
                continue;
            }

            await page.goto(article.url, { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);
            
            const text = await page.evaluate(() => document.body.innerText);
            const hasTicket = text.includes("チケット") || text.includes("入場券") || text.includes("プロデューサーシート");
            const hasApply = text.includes("先行") || text.includes("抽選") || text.includes("一般発売") || text.includes("一般会員") || text.includes("受付");
            
            if (!(hasTicket && hasApply)) {
                console.log(" ├─ ⏩ スキップ: チケット申込の決定的なキーワードなし");
                continue;
            }
            
            console.log(" ├─ 🎯 情報検知！ Geminiに詳細解析と判定を依頼します...");
            // 基本の待機（3秒）
            await page.waitForTimeout(3000);

            let data = null;

            const prompt = `以下のテキストからイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【抽出フォーマット】
{
  "is_target_live": true, 
  "base_live_name": "ライブの基本名称（装飾を除外した正式名称）",
  "short_name": "カレンダー表示用の短い略称（例: デレ15周年オケコン、シャニ 6.5th など15文字以内）",
  "live_date": "ライブ開催初日の日付（YYYY-MM-DD形式。例: 2026-11-20。不明なら空文字）",
  "official_url": "特設サイトのURL（不明なら空文字）",
  "venues": "会場名（不明なら未定）",
  "schedules": ["Day1: 2月27日(土) 開場15:30 / 開演17:00"],
  "performances": ["Day1", "Day2"],
  "ticket_tier": "今回の記事で募集している受付名称（例: アソビストアプレミアム。不明なら空文字）",
  "apply_period": "受付期間（例: 10/12(月)〜10/20(火)23:59。不明なら空文字）",
  "deadline_date": "受付の最終締切日（YYYY-MM-DD形式。例: 2026-10-20）。記載がない場合は空文字",
  "result_date": "当落発表日時（例: 10/24(木)13:00。不明なら空文字）"
}

【厳格な判定ルール】
・is_target_live: 現地開催のアイマス単独音楽ライブ、コンサート、ファンミ、オーケストラコンサートであれば true。「遊園地等のコラボ」「上映会」「オンライン限定」「外部フェスへの出展」は必ず false。
【テキスト】
${text.substring(0, 5000)}`;
            
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
                
                // ★ 通常のfetchの代わりに、自作のfetchWithRetryを使う
                const res = await fetchWithRetry(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
                    })
                });
                
                if (res && res.ok) {
                    const result = await res.json();
                    if (result.candidates && result.candidates.length > 0) {
                        const rawText = result.candidates[0].content.parts[0].text;
                        const match = rawText.match(/\{[\s\S]*\}/);
                        if (match) {
                            data = JSON.parse(match[0]);
                        }
                    }
                } else {
                    console.log(` ├─ ❌ スキップ: Geminiリトライ上限到達、またはエラー終了`);
                    continue;
                }
            } catch (e) {
                console.log(` ├─ ⚠️ Gemini通信失敗: ${e.message}`);
                continue;
            }

            if (!data) continue;
            if (data.is_target_live === false) {
                console.log(` ├─ ⏩ スキップ: AI判定により非対象イベントとみなされました`);
                continue;
            }
            
            const existing = await notion.databases.query({
                database_id: process.env.NOTION_DB_ID,
                filter: { property: "名前", title: { equals: data.base_live_name } }
            });
            
            const notionPayload = {
                "名前": { title: [{ text: { content: data.base_live_name } }] },
                "略称": { rich_text: [{ text: { content: data.short_name || "" } }] }
            };

            if (data.deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(data.deadline_date)) {
                notionPayload["締切日"] = { date: { start: data.deadline_date } };
            }
            if (data.live_date && /^\d{4}-\d{2}-\d{2}$/.test(data.live_date)) {
                notionPayload["ライブ開催日"] = { date: { start: data.live_date } };
            }
            
            if (existing.results.length === 0) {
                const childrenBlocks = [
                    { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `🔗 ${data.base_live_name} (公式サイトへ)`, link: { url: data.official_url || article.url } } }] } },
                    { object: "block", type: "paragraph", paragraph: { rich_text: [] } },
                    { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📍 開催情報" } }] } },
                    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `会場: ${data.venues || "未定"}` } }] } }
                ];

                if (data.schedules && data.schedules.length > 0) {
                    data.schedules.forEach(sched => childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: sched } }] } }));
                }

                childrenBlocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [] } });
                childrenBlocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: `✅ 当落状況` } }] } });

                if (data.performances && data.performances.length > 0) {
                    data.performances.forEach(perf => childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `${perf}: ` } }] } }));
                } else {
                    childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "参加者: " } }] } });
                }

                if (data.ticket_tier) {
                    childrenBlocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [] } });
                    childrenBlocks.push({ object: "block", type: "divider", divider: {} });
                    childrenBlocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: `🎫 受付履歴: ${data.ticket_tier}` } }] } });
                    childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `受付期間: ${data.apply_period || "不明"}` } }] } });
                    childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `当落発表: ${data.result_date || "不明"}` } }] } });
                    childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "詳細ニュースを開く", link: { url: article.url } } }] } });
                }

                await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload, children: childrenBlocks });
                console.log(" ├─ ⭐ 成功: Notionに新規登録しました！");
                processedCount++;
            } else {
                const pageId = existing.results[0].id;
                const blocks = await notion.blocks.children.list({ block_id: pageId });
                const blocksText = JSON.stringify(blocks.results);
                
                let updated = false;
                const updatePayload = {};

                if (data.deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(data.deadline_date)) {
                    updatePayload["締切日"] = { date: { start: data.deadline_date } };
                    updated = true;
                }
                if (data.live_date && /^\d{4}-\d{2}-\d{2}$/.test(data.live_date)) {
                    updatePayload["ライブ開催日"] = { date: { start: data.live_date } };
                    updated = true;
                }
                if (data.short_name) {
                    updatePayload["略称"] = { rich_text: [{ text: { content: data.short_name } }] };
                    updated = true;
                }

                if (updated) {
                    await notion.pages.update({ page_id: pageId, properties: updatePayload });
                }

                if (data.ticket_tier && data.ticket_tier !== "未定" && data.ticket_tier !== "" && !blocksText.includes(data.ticket_tier)) {
                    const appendBlocks = [
                        { object: "block", type: "paragraph", paragraph: { rich_text: [] } },
                        { object: "block", type: "divider", divider: {} },
                        { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: `🎫 追加受付: ${data.ticket_tier}` } }] } },
                        { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `受付期間: ${data.apply_period || "不明"}` } }] } },
                        { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `当落発表: ${data.result_date || "不明"}` } }] } },
                        { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "詳細ニュースを開く", link: { url: article.url } } }] } }
                    ];
                    await notion.blocks.children.append({ block_id: pageId, children: appendBlocks });
                    console.log(` ├─ 🔄 更新: 新しい受付情報（${data.ticket_tier}）を追記しました！`);
                    processedCount++;
                } else {
                    console.log(" ├─ 🆗 スキップ: 新しい受付情報はありません");
                }
            }
        }
        console.log(`\n完了！ 新規・更新: ${processedCount}件`);
    } catch (error) {
        console.error("エラー:", error);
    } finally {
        await browser.close();
    }
}
run();
