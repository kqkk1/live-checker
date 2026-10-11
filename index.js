const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function run() {
    console.log("🚀 チェッカー起動（美麗フォーマット＆タイトルリンク版）");
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
            if (title.includes("グッズ") || title.includes("Blu-ray") || title.includes("CD") || title.includes("放送") || title.includes("配信") || title.includes("受注")) {
                console.log(" ├─ ⏩ スキップ: タイトルからグッズ・配信情報と判定");
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
            
            console.log(" ├─ 🎯 ライブ情報検知！ Geminiに詳細抽出を依頼します...");
            
            let data = {
                live_name: title,
                official_url: article.url,
                venues: "未定",
                schedules: [],
                performances: [],
                result_date_text: "次回募集待ち"
            };

            const prompt = `以下のテキストから、ライブやイベントのチケットに関する情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。複数日程（Day1, Day2など）や昼夜公演がある場合は、配列に分けて見やすく整形してください。

【抽出フォーマット】
{
  "live_name": "イベントの正式名称（装飾文字などは省く）",
  "official_url": "特設サイトのURL",
  "venues": "会場名",
  "schedules": [
    "Day1: 2月27日(土) 開場15:30 / 開演17:00",
    "Day2: 2月28日(日) 開場15:30 / 開演17:00"
  ],
  "performances": [
    "Day1",
    "Day2"
  ],
  "result_date_text": "当落発表日（例: '10/31当落発表'。不明なら'次回募集待ち'）"
}
【テキスト】
${text.substring(0, 5000)}`;
            
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
                    })
                });
                
                if (res.ok) {
                    const result = await res.json();
                    if (result.candidates && result.candidates.length > 0) {
                        const cleanJson = result.candidates[0].content.parts[0].text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
                        const gData = JSON.parse(cleanJson);
                        if (gData.live_name) data.live_name = gData.live_name;
                        if (gData.official_url) data.official_url = gData.official_url;
                        if (gData.venues) data.venues = gData.venues;
                        if (gData.schedules) data.schedules = gData.schedules;
                        if (gData.performances) data.performances = gData.performances;
                        if (gData.result_date_text) data.result_date_text = gData.result_date_text;
                        console.log(" ├─ ✨ Gemini抽出成功！");
                    }
                } else {
                    console.log(` ├─ ⚠️ Geminiエラー(${res.status})`);
                }
            } catch (e) {
                console.log(` ├─ ⚠️ Gemini通信失敗: ${e.message}`);
            }
            
            const existing = await notion.databases.query({
                database_id: process.env.NOTION_DB_ID,
                filter: { or: [{ property: "名前", title: { equals: data.live_name } }] }
            });
            
            const notionPayload = {
                "名前": { title: [{ text: { content: data.live_name } }] }
            };
            
            if (existing.results.length === 0) {
                const childrenBlocks = [
                    { 
                        object: "block", 
                        type: "paragraph", 
                        paragraph: { rich_text: [{ type: "text", text: { content: `🔗 ${data.live_name} (公式サイトへ)`, link: { url: data.official_url || article.url } } }] } 
                    },
                    { object: "block", type: "paragraph", paragraph: { rich_text: [] } },
                    { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📍 開催情報" } }] } },
                    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `会場: ${data.venues}` } }] } }
                ];

                if (data.schedules && data.schedules.length > 0) {
                    data.schedules.forEach(sched => {
                        childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: sched } }] } });
                    });
                }

                childrenBlocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [] } });

                childrenBlocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: `✅ 当落状況(${data.result_date_text})` } }] } });

                if (data.performances && data.performances.length > 0) {
                    data.performances.forEach(perf => {
                        childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `${perf}: ` } }] } });
                    });
                } else {
                    childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "参加者: " } }] } });
                }

                await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload, children: childrenBlocks });
                console.log(" ├─ ⭐ 成功: Notionに美麗フォーマットで新規登録しました！");
                processedCount++;
            } else {
                console.log(" ├─ 🆗 スキップ: 既に登録済みです");
            }
        }
        console.log(`\n完了！ 新規登録: ${processedCount}件`);
    } catch (error) {
        console.error("エラー:", error);
    } finally {
        await browser.close();
    }
}
run();
