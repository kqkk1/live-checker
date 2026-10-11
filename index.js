const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function run() {
    console.log("🚀 チェッカー起動（AI＋厳格フィルター完全版）");
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
            
            // 【強化フィルター1】タイトルでグッズや円盤情報をシャットアウト
            const title = article.title || "";
            if (title.includes("グッズ") || title.includes("Blu-ray") || title.includes("CD") || title.includes("放送") || title.includes("配信") || title.includes("受注")) {
                console.log(" ├─ ⏩ スキップ: タイトルからグッズ・配信情報と判定");
                continue;
            }

            await page.goto(article.url, { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);
            
            const text = await page.evaluate(() => document.body.innerText);
            
            // 【強化フィルター2】本文にチケットと申込の両方のキーワードがあるか
            const hasTicket = text.includes("チケット") || text.includes("入場券") || text.includes("プロデューサーシート");
            const hasApply = text.includes("先行") || text.includes("抽選") || text.includes("一般発売") || text.includes("一般会員") || text.includes("受付");
            
            if (!(hasTicket && hasApply)) {
                console.log(" ├─ ⏩ スキップ: チケット申込の決定的なキーワードがありません");
                continue;
            }
            
            console.log(" ├─ 🎯 ライブ情報検知！ Geminiに詳細抽出を依頼します...");
            
            let data = {
                live_name: title,
                official_url: article.url,
                apply_start: "",
                result_date: "",
                venues: "",
                schedule: ""
            };

            const prompt = `以下のテキストから、ライブやイベントの「チケット先行抽選」に関する情報を抽出し、必ず指定されたJSONフォーマットのみを出力してください。Markdownのコードブロックは含めず、純粋なJSON文字列だけを返してください。\n\n【抽出フォーマット】\n{\n  "live_name": "イベントの正式名称",\n  "official_url": "特設サイトのURL（不明なら空文字）",\n  "apply_start": "受付開始日（YYYY-MM-DD形式、不明なら空文字）",\n  "result_date": "当落発表日（YYYY-MM-DD形式、不明なら空文字）",\n  "venues": "会場名（不明なら空文字）",\n  "schedule": "開場・開演時間など（不明なら空文字）"\n}\n\n【テキスト】\n${text.substring(0, 5000)}`;
            
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
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
                        if (gData.apply_start) data.apply_start = gData.apply_start;
                        if (gData.result_date) data.result_date = gData.result_date;
                        if (gData.venues) data.venues = gData.venues;
                        if (gData.schedule) data.schedule = gData.schedule;
                        console.log(" ├─ ✨ Gemini抽出成功！");
                    }
                } else {
                    const errText = await res.text();
                    console.log(` ├─ ⚠️ Geminiエラー(${res.status}): ${errText}`);
                    console.log(" ├─ ⚠️ 詳細抽出をスキップし、名前とURLだけで登録します");
                }
            } catch (e) {
                console.log(` ├─ ⚠️ Gemini通信失敗: ${e.message}`);
                console.log(" ├─ ⚠️ 詳細抽出をスキップし、名前とURLだけで登録します");
            }
            
            // Notionへ登録処理
            const existing = await notion.databases.query({
                database_id: process.env.NOTION_DB_ID,
                filter: { or: [{ property: "名前", title: { equals: data.live_name } }] }
            });
            
            const notionPayload = {
                "名前": { title: [{ text: { content: data.live_name } }] },
                "URL": { url: data.official_url || article.url }
            };
            
            if (data.venues) notionPayload["会場"] = { rich_text: [{ text: { content: data.venues } }] };
            if (data.schedule) notionPayload["開場・開演"] = { rich_text: [{ text: { content: data.schedule } }] };
            if (data.apply_start && /^\d{4}-\d{2}-\d{2}$/.test(data.apply_start)) notionPayload["応募開始日"] = { date: { start: data.apply_start } };
            if (data.result_date && /^\d{4}-\d{2}-\d{2}$/.test(data.result_date)) notionPayload["当落発表日"] = { date: { start: data.result_date } };
            
            if (existing.results.length === 0) {
                await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload });
                console.log(" ├─ ⭐ 成功: Notionに新規登録しました！");
                processedCount++;
            } else {
                const page = existing.results[0];
                const prop = page.properties["開場・開演"];
                const hasSchedule = prop && prop.rich_text && prop.rich_text.length > 0 && prop.rich_text[0].plain_text.trim() !== "";
                
                if (!hasSchedule && data.schedule) {
                    await notion.pages.update({ page_id: page.id, properties: notionPayload });
                    console.log(" ├─ 🔄 更新: Notionのスケジュール等を上書き追加しました");
                    processedCount++;
                } else {
                    console.log(" ├─ 🆗 スキップ: 既に登録済みです");
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
