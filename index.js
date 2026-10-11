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
  "official_url": "
