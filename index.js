const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function fetchWithRetry(url, options, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        const res = await fetch(url, options);
        if (res.ok) return res;
        
        if (res.status === 429 || res.status === 503) {
            const waitTime = (i + 1) * 30000; 
            console.log(` ├─ ⚠️ 通信混雑(${res.status})。${waitTime / 1000}秒待機して再試行します...(${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
        }
        
        const errorText = await res.text();
        console.log(` ├─ ❌ 致命的なAPIエラー発生 (HTTP ${res.status})`);
        console.log(` ├─ 🔍 エラー詳細: ${errorText}`);
        return null;
    }
    console.log(` ├─ ❌ リトライ上限（${maxRetries}回）に到達しました。`);
    return null;
}

async function run() {
    console.log("🚀 スナイパー起動（安定第一・クリーンアップ版）");
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // ※エラーの原因となった page.route によるURLブロック処理を完全に削除しました

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
                console.log(" ├─ ⏩ スキップ: タイトルから対象外と判定");
                continue;
            }

            // ※ waitUntil を元の安定した networkidle に戻しました
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
            
            const prompt = `以下のテキストからイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【抽出フォーマット】
{
  "is_target_live": true, 
  "base_live_name": "ライブの基本名称（装飾を除外した正式名称）",
  "short_name": "カレンダー表示用の短い略称（例: デレ15周年オケコンなど15文字以内）",
  "live_date": "ライブ開催初日の日付（YYYY-MM-DD形式。例: 2026-11-20。不明なら空文字）",
  "live_end_date": "ライブ最終日の日付（YYYY-MM-DD形式。例: 2026-11-21。1日限りの場合はlive_dateと同じ日付。不明なら空文字）",
  "official_url": "特設サイトのURL（不明なら空文字）",
  "venues": "会場名（不明なら未定）",
  "schedules": ["Day1: 2月27日(土) 開場15:30 / 開演17:00"],
  "ticket_tier": "今回の記事で募集している受付名称（例: アソビストアプレミアム先行。不明なら空文字）",
  "deadline_date": "受付の最終締切日（YYYY-MM-DD形式。例: 2026-10-20。不明なら空文字）",
  "result_date_notion": "当落発表日の日付（YYYY-MM-DD形式。例: 2026-10-24。不明なら空文字）"
}

【厳格な判定ルール】
・is_target_live: 現地開催のアイマス単独音楽ライブ、コンサート、ファンミ、オーケストラコンサートであれば true。「遊園地等のコラボ」「上映会」「オンライン限定」「外部フェスへの出展」は必ず false。
【テキスト】
${text.substring(0, 3000)}`;
            
            let data = null;
            try {
                // ★ 正しい最新モデル（1.5-flash-latest）に修正
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
                
                const res = await fetchWithRetry(url, {
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
                        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
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
                        console.log(` ├─ ❌ AIが回答をブロックしました: ${JSON.stringify(result.promptFeedback)}`);
                    }
                } else {
                    continue;
                }
            } catch (e) {
                console.log(` ├─ ⚠️ システムエラー: ${e.message}`);
                continue;
            }

            if (!data) continue;
            if (data.is_target_live === false) {
                console.log(` ├─ ⏩ スキップ: AI判定により非対象`);
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

            if (data.ticket_tier) notionPayload["受付枠"] = { rich_text: [{ text: { content: data.ticket_tier } }] };
            if (data.deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(data.deadline_date)) notionPayload["締切日"] = { date: { start: data.deadline_date } };
            
            if (data.live_date && /^\d{4}-\d{2}-\d{2}$/.test(data.live_date)) {
                const dateObj = { start: data.live_date };
                if (data.live_end_date && /^\d{4}-\d{2}-\d{2}$/.test(data.live_end_date) && data.live_date !== data.live_end_date) dateObj.end = data.live_end_date;
                notionPayload["ライブ開催日"] = { date: dateObj };
            }
            if (data.result_date_notion && /^\d{4}-\d{2}-\d{2}$/.test(data.result_date_notion)) notionPayload["当落発表日"] = { date: { start: data.result_date_notion } };
            
            if (existing.results.length === 0) {
                const childrenBlocks = [
                    { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `🔗 ${data.base_live_name}`, link: { url: data.official_url || article.url } } }] } },
                    { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📍 開催情報" } }] } },
                    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `会場: ${data.venues || "未定"}` } }] } }
                ];
                if (data.schedules) data.schedules.forEach(sched => childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: sched } }] } }));
                await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload, children: childrenBlocks });
                console.log(" ├─ ⭐ 成功: Notionに新規登録！");
                processedCount++;
            } else {
                const pageId = existing.results[0].id;
                let updated = false;
                const updatePayload = {};

                if (data.deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(data.deadline_date)) { updatePayload["締切日"] = { date: { start: data.deadline_date } }; updated = true; }
                if (data.live_date && /^\d{4}-\d{2}-\d{2}$/.test(data.live_date)) {
                    const dateObj = { start: data.live_date };
                    if (data.live_end_date && data.live_date !== data.live_end_date) dateObj.end = data.live_end_date;
                    updatePayload["ライブ開催日"] = { date: dateObj }; updated = true;
                }
                if (data.short_name) { updatePayload["略称"] = { rich_text: [{ text: { content: data.short_name } }] }; updated = true; }
                if (data.ticket_tier) { updatePayload["受付枠"] = { rich_text: [{ text: { content: data.ticket_tier } }] }; updated = true; }
                if (data.result_date_notion && /^\d{4}-\d{2}-\d{2}$/.test(data.result_date_notion)) { updatePayload["当落発表日"] = { date: { start: data.result_date_notion } }; updated = true; }

                if (updated) {
                    await notion.pages.update({ page_id: pageId, properties: updatePayload });
                    console.log(` ├─ 🔄 更新: 既存データをアップデート！`);
                    processedCount++;
                } else {
                    console.log(" ├─ 🆗 スキップ: 更新なし");
                }
            }
            
            console.log(" ├─ ⏳ 10秒待機...");
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        console.log(`\n完了！ 新規・更新: ${processedCount}件`);
    } catch (error) {
        console.error("エラー:", error);
    } finally {
        await browser.close();
    }
}
run();
