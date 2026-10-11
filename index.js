const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function run() {
    console.log("🚀 スナイパー起動（安定版・直接抽出モード）");
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
            await page.goto(article.url, { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);
            
            const text = await page.evaluate(() => document.body.innerText);
            const keywords = ["アソビストア", "先行", "抽選", "チケット", "spラウンジ", "SPラウンジ", "バルコニー席", "SPプロデューサーシート", "プロデューサーシート", "一般会員"];
            
            if (!keywords.some(kw => text.includes(kw))) {
                console.log(" ├─ スキップ: チケット関連のキーワードなし");
                continue;
            }
            
            console.log(" ├─ キーワード検出！ Notionに登録します...");
            const liveName = article.title;
            
            const existing = await notion.databases.query({
                database_id: process.env.NOTION_DB_ID,
                filter: { or: [{ property: "名前", title: { equals: liveName } }] }
            });
            
            const notionPayload = {
                "名前": { title: [{ text: { content: liveName } }] },
                "URL": { url: article.url }
            };
            
            if (existing.results.length === 0) {
                await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload });
                console.log(" ├─ ⭐ 成功: Notionに新規登録しました！");
                processedCount++;
            } else {
                console.log(" ├─ スキップ: 既に登録済みです");
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
