const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function run() {
    console.log("🚀 チェッカー起動（GitHub Actions直結版）");
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    try {
        console.log("ニュース一覧（ライブカテゴリ）にアクセス中...");
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
            await page.goto(article.url, { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);
            
            const text = await page.evaluate(() => document.body.innerText);
            const keywords = ["アソビストア", "先行", "抽選", "チケット", "spラウンジ", "SPラウンジ", "バルコニー席", "SPプロデューサーシート", "プロデューサーシート", "一般会員"];
            
            if (!keywords.some(kw => text.includes(kw))) {
                console.log(" ├─ スキップ: チケット関連のキーワードなし");
                continue;
            }
            
            console.log(" ├─ キーワード検出！ Geminiに直接解析を依頼します...");
            const prompt = `以下のテキストから、ライブやイベントの「チケット先行抽選」に関する情報を抽出し、必ず指定されたJSONフォーマットのみを出力してください。Markdownのコードブロックは含めず、純粋なJSON文字列だけを返してください。\n\n【抽出フォーマット】\n{\n  "live_name": "イベントの正式名称",\n  "official_url": "特設サイトのURL（不明なら空文字）",\n  "apply_start": "受付開始日（YYYY-MM-DD形式、不明なら空文字）",\n  "result_date": "当落発表日（YYYY-MM-DD形式、不明なら空文字）",\n  "venues": "会場名（不明なら空文字）",\n  "schedule": "開場・開演時間など（不明なら空文字）"\n}\n\n【テキスト】\n${text.substring(0, 5000)}`;
            
            // ツールに頼らず、直接GeminiのAPIを叩く（100%確実な方法）
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
            const payload = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
            };
            
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            
            if (!res.ok) {
                console.log(` ├─ Gemini通信エラー: ${res.status}`);
                continue;
            }
            
            const result = await res.json();
            if (!result.candidates || result.candidates.length === 0) {
                console.log(" ├─ Geminiエラー: 解析結果が空です");
                continue;
            }
            
            const cleanJson = result.candidates[0].content.parts[0].text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
            
            let data;
            try { data = JSON.parse(cleanJson); } catch (e) { 
                console.log(" ├─ JSON変換エラー"); 
                continue; 
            }
            
            if (!data.apply_start && !data.result_date && !data.schedule) {
                console.log(" ├─ スキップ: 日付・時間情報がありません");
                continue;
            }
            
            const liveName = data.live_name || article.title;
            const existing = await notion.databases.query({
                database_id: process.env.NOTION_DB_ID,
                filter: { or: [{ property: "名前", title: { equals: liveName } }] }
            });
            
            const notionPayload = {
                "名前": { title: [{ text: { content: liveName } }] },
                "URL": { url: data.official_url || article.url },
                "会場": { rich_text: [{ text: { content: data.venues || "" } }] },
                "開場・開演": { rich_text: [{ text: { content: data.schedule || "" } }] }
            };
            if (data.apply_start && /^\d{4}-\d{2}-\d{2}$/.test(data.apply_start)) notionPayload["応募開始日"] = { date: { start: data.apply_start } };
            if (data.result_date && /^\d{4}-\d{2}-\d{2}$/.test(data.result_date)) notionPayload["当落発表日"] = { date: { start: data.result_date } };
            
            if (existing.results.length > 0) {
                const page = existing.results[0];
                const prop = page.properties["開場・開演"];
                const hasSchedule = prop && prop.rich_text.length > 0 && prop.rich_text[0].plain_text.trim() !== "";
                
                if (!hasSchedule && data.schedule) {
                    await notion.pages.update({ page_id: page.id, properties: notionPayload });
                    console.log(" ├─ 更新: スケジュールを追加しました");
                    processedCount++;
                } else {
                    console.log(" ├─ スキップ: 既に登録済みです");
                }
            } else {
                await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload });
                console.log(" ├─ ⭐ 成功: 新規登録しました！");
                processedCount++;
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
