const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function run() {
    console.log("🚀 スナイパー起動（オケコン対応＆締切日・自動追跡版）");
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
            let data = null;

            // ▼ ここがオーケストラコンサートを含めるように修正した新しい命令です ▼
            const prompt = `以下のテキストからイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【抽出フォーマット】
{
  "is_target_live": true, 
  "base_live_name": "ライブの基本名称（【】や『』、日付、「〜先行開始！」などの宣伝文句を完全に除外した、純粋なライブの正式名称）",
  "official_url": "特設サイトのURL（不明なら空文字）",
  "venues": "会場名（不明なら未定）",
  "schedules": ["Day1: 2月27日(土) 開場15:30 / 開演17:00"],
  "performances": ["Day1", "Day2"],
  "ticket_tier": "今回の記事で募集している受付名称（例: アソビストアプレミアム会員先行。不明なら空文字）",
  "apply_period": "受付期間（例: 10/12(月)〜10/20(火)23:59。不明なら空文字）",
  "deadline_date": "受付の最終締切日（YYYY-MM-DD形式。例: 2026-10-20）。記載がない場合は空文字",
  "result_date": "当落発表日時（例: 10/24(木)13:00。不明なら空文字）"
}

【厳格な判定ルール】
・is_target_live: 現地開催のアイマス単独音楽ライブ、コンサート、ファンミ、および「オーケストラコンサート」であれば true。「遊園地等のコラボ」「同時視聴などの上映会」「オンライン限定」「外部フェスへの出展」は必ず false にすること。
・base_live_name: ニュースタイトルが違っても同一ライブとして紐付けられるよう、一切の装飾を排除した共通のライブ名だけにすること。
【テキスト】
${text.substring(0, 5000)}`;
            
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
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
                        data = JSON.parse(cleanJson);
                    }
                } else {
                    console.log(` ├─ ⚠️ Geminiエラー(${res.status})`);
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
                "名前": { title: [{ text: { content: data.base_live_name } }] }
            };

            if (data.deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(data.deadline_date)) {
                notionPayload["締切日"] = { date: { start: data.deadline_date } };
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
                console.log(" ├─ ⭐ 成功: Notionに新規登録し、締切日をセットしました！");
                processedCount++;
            } else {
                const pageId = existing.results[0].id;
                const blocks = await notion.blocks.children.list({ block_id: pageId });
                const blocksText = JSON.stringify(blocks.results);
                
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
                    
                    const updatePayload = {};
                    if (data.deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(data.deadline_date)) {
                        updatePayload["締切日"] = { date: { start: data.deadline_date } };
                        await notion.pages.update({ page_id: pageId, properties: updatePayload });
                    }
                    
                    console.log(` ├─ 🔄 更新: 新しい受付情報（${data.ticket_tier}）を追記し、締切日を更新しました！`);
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
