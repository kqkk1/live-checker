const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// 429/503エラー時のリトライ処理（待機時間を30秒ずつ増やす安全設計）
async function fetchWithRetry(url, options, maxRetries = 4) {
    for (let i = 0; i < maxRetries; i++) {
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
    }
    console.log(` ├─ ❌ リトライ上限（${maxRetries}回）に到達しました。次の記事へ進みます。`);
    return null;
}

async function run() {
    console.log("🚀 スナイパー起動（API節約・完全安定版）");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        console.log("ニュース一覧にアクセス中...");
        await page.goto('https://idolmaster-official.jp/news?category=live-event', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        
        // ★ 最適化1: Invalid URLエラーを絶対に起こさない安全なリンク抽出
        const links = await page.$$eval('a', anchors => {
            return anchors
                .map(a => ({ url: a.href ? a.href.trim() : "", title: a.innerText ? a.innerText.trim() : "" }))
                .filter(a => 
                    a.url.startsWith('https://idolmaster-official.jp/news/') && 
                    !a.url.includes('category') && 
                    !a.url.includes('tag') &&
                    a.url.length > 38 // トップページ単体を除外し、個別記事のみを対象にする
                );
        });
        
        // 重複URLの排除
        const uniqueUrls = new Map();
        for (const link of links) {
            if (!uniqueUrls.has(link.url)) {
                uniqueUrls.set(link.url, link);
            }
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

            try {
                await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(2000);
            } catch (pageErr) {
                console.log(` ├─ ⚠️ ページ読み込みスキップ: ${pageErr.message}`);
                continue;
            }
            
            const text = await page.evaluate(() => document.body ? document.body.innerText : "");
            const hasTicket = text.includes("チケット") || text.includes("入場券") || text.includes("プロデューサーシート");
            const hasApply = text.includes("先行") || text.includes("抽選") || text.includes("一般発売") || text.includes("一般会員") || text.includes("受付");
            
            if (!(hasTicket && hasApply)) {
                console.log(" ├─ ⏩ スキップ: チケット申込の決定的なキーワードなし");
                continue;
            }
            
            console.log(" ├─ 🎯 情報検知！ Geminiに詳細解析を依頼します...");
            
            const prompt = `以下のテキストからイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【抽出フォーマット】
{
  "is_target_live": true, 
  "base_live_name": "ライブの基本名称（装飾を除外した正式名称）",
  "short_name": "カレンダー表示用の短い略称（例: デレ15周年オケコンなど15文字以内）",
  "live_date": "ライブ開催初日の日付（YYYY-MM-DD形式。不明なら空文字）",
  "live_end_date": "ライブ最終日の日付（YYYY-MM-DD形式。1日限りの場合はlive_dateと同じ日付。不明なら空文字）",
  "official_url": "特設サイトのURL（不明なら空文字）",
  "venues": "会場名（不明なら未定）",
  "schedules": ["Day1: 2月27日(土) 開場15:30 / 開演17:00"],
  "ticket_tier": "今回の記事で募集している受付名称（例: アソビストアプレミアム先行。不明なら空文字）",
  "deadline_date": "受付の最終締切日（YYYY-MM-DD形式。不明なら空文字）",
  "result_date_notion": "当落発表日の日付（YYYY-MM-DD形式。不明なら空文字）"
}

【厳格な判定ルール】
・is_target_live: 現地開催のアイマス単独音楽ライブ、コンサート、ファンミ、オーケストラコンサートであれば true。「遊園地等のコラボ」「上映会」「オンライン限定」「外部フェスへの出展」は必ず false。
【テキスト】
${text.substring(0, 3000)}`;
            
            let data = null;
            try {
                // ★ 確実に動く最新モデル（gemini-flash-latest）を使用（gemini-3.8-flash に書き換えてもOKです）
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

            if (!data || data.is_target_live === false || !data.base_live_name) {
                console.log(` ├─ ⏩ スキップ: AI判定により非対象`);
                // 非対象でもAPIは消費したため、少し待機して次へ
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            
            // Notionデータベースの照会
            const existing = await notion.databases.query({
                database_id: process.env.NOTION_DB_ID,
                filter: { property: "名前", title: { equals: data.base_live_name } }
            });
            
            const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

            if (existing.results.length === 0) {
                // 新規登録用のデータ構築
                const notionPayload = {
                    "名前": { title: [{ text: { content: data.base_live_name } }] },
                    "略称": { rich_text: [{ text: { content: data.short_name || "" } }] }
                };

                if (data.ticket_tier) notionPayload["受付枠"] = { rich_text: [{ text: { content: data.ticket_tier } }] };
                if (isValidDate(data.deadline_date)) notionPayload["締切日"] = { date: { start: data.deadline_date } };
                if (isValidDate(data.result_date_notion)) notionPayload["当落発表日"] = { date: { start: data.result_date_notion } };
                
                if (isValidDate(data.live_date)) {
                    const dateObj = { start: data.live_date };
                    if (isValidDate(data.live_end_date) && data.live_date !== data.live_end_date) {
                        dateObj.end = data.live_end_date;
                    }
                    notionPayload["ライブ開催日"] = { date: dateObj };
                }

                const linkUrl = (data.official_url && data.official_url.startsWith('http')) ? data.official_url : article.url;
                const childrenBlocks = [
                    { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `🔗 ${data.base_live_name}`, link: { url: linkUrl } } }] } },
                    { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📍 開催情報" } }] } },
                    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: `会場: ${data.venues || "未定"}` } }] } }
                ];
                
                if (Array.isArray(data.schedules)) {
                    data.schedules.forEach(sched => {
                        childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: String(sched) } }] } });
                    });
                }

                await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload, children: childrenBlocks });
                console.log(" ├─ ⭐ 成功: Notionに新規登録！");
                processedCount++;
            } else {
                // ★ 最適化2: 既存データと内容が同じなら、Notionへの無駄な更新通信を行わない
                const pageObj = existing.results[0];
                const props = pageObj.properties;
                const updatePayload = {};
                let needsUpdate = false;

                const currentDeadline = props["締切日"]?.date?.start || "";
                if (isValidDate(data.deadline_date) && data.deadline_date !== currentDeadline) {
                    updatePayload["締切日"] = { date: { start: data.deadline_date } };
                    needsUpdate = true;
                }

                const currentResultDate = props["当落発表日"]?.date?.start || "";
                if (isValidDate(data.result_date_notion) && data.result_date_notion !== currentResultDate) {
                    updatePayload["当落発表日"] = { date: { start: data.result_date_notion } };
                    needsUpdate = true;
                }

                const currentTier = props["受付枠"]?.rich_text?.[0]?.plain_text || "";
                if (data.ticket_tier && data.ticket_tier !== currentTier) {
                    updatePayload["受付枠"] = { rich_text: [{ text: { content: data.ticket_tier } }] };
                    needsUpdate = true;
                }

                const currentLiveDate = props["ライブ開催日"]?.date?.start || "";
                if (isValidDate(data.live_date) && data.live_date !== currentLiveDate) {
                    const dateObj = { start: data.live_date };
                    if (isValidDate(data.live_end_date) && data.live_date !== data.live_end_date) {
                        dateObj.end = data.live_end_date;
                    }
                    updatePayload["ライブ開催日"] = { date: dateObj };
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    await notion.pages.update({ page_id: pageObj.id, properties: updatePayload });
                    console.log(` ├─ 🔄 更新: 新しい受付情報を反映しました！`);
                    processedCount++;
                } else {
                    console.log(" ├─ 🆗 スキップ: 既に最新情報が登録済みです");
                }
            }
            
            console.log(" ├─ ⏳ APIレート制限回避のため12秒待機します...");
            await new Promise(resolve => setTimeout(resolve, 12000));
        }
        console.log(`\n🎉 全処理完了！ 新規・更新: ${processedCount}件`);
    } catch (error) {
        console.error("致命的なエラー:", error);
    } finally {
        await browser.close();
    }
}
run();
