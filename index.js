const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

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

// ★ 最適化: 処理済みURLを安全に追記・整形する共通関数
function appendUrlToListString(currentUrlsText, newUrl) {
    const urlList = currentUrlsText ? currentUrlsText.split(',').map(u => u.trim()).filter(Boolean) : [];
    if (!urlList.includes(newUrl)) {
        urlList.push(newUrl);
    }
    // Notionの2000文字制限を超えないよう最新20件を保持
    return urlList.slice(-20).join(', ');
}

async function run() {
    console.log("🚀 スナイパー起動（タイトル略称化・全文解析・アクセス強化・完全最適化版）");
    
    console.log("Notionの既存データを読み込み中...");
    let existingPages = [];
    let processedUrls = new Set();
    let existingLiveNames = [];

    try {
        const dbQuery = await notion.databases.query({ database_id: process.env.NOTION_DB_ID });
        existingPages = dbQuery.results;

        for (const page of existingPages) {
            // ★ 方法B対応: 「名前(タイトル)」には略称、「略称(テキスト)」には正式名称が入るため、両方から正式名称を回収して名寄せリストを作る
            const titleText = page.properties["名前"]?.title?.[0]?.plain_text || "";
            const subText = page.properties["略称"]?.rich_text?.[0]?.plain_text || "";
            
            // 文字数が長い方を「正式名称」としてAIのカンニングリストに登録（旧データとの互換性も維持）
            const officialName = subText.length > titleText.length ? subText : titleText;
            if (officialName) existingLiveNames.push(officialName);

            const urlsText = page.properties["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
            if (urlsText) {
                urlsText.split(',').map(u => u.trim()).filter(Boolean).forEach(u => processedUrls.add(u));
            }
        }
        console.log(` ├─ 登録済みライブ: ${existingPages.length}件 / 記憶済み記事URL: ${processedUrls.size}件`);
    } catch (err) {
        console.error("⚠️ Notionの初期読み込みに失敗しました:", err.message);
        return;
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
        const articles = Array.from(uniqueUrls.values());
        console.log(`抽出対象: ${articles.length}件`);
        
        let processedCount = 0;
        
        for (const article of articles) {
            console.log(`\n▶ 対象: ${article.title || article.url}`);
            
            if (processedUrls.has(article.url)) {
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
            
            // ★ 最適化: ヘッダー等のノイズを減らし、記事のメイン領域から優先的にテキストと特設サイトURLを抽出
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
            
            if (!(hasTicket && hasApply)) {
                console.log(" ├─ ⏩ スキップ: チケット申込の決定的なキーワードなし");
                continue;
            }
            
            console.log(" ├─ 🎯 新着のチケット情報を検知！ Geminiに全文解析を依頼します...");
            
            const existingNamesListStr = existingLiveNames.length > 0 
                ? existingLiveNames.map(n => `・${n}`).join('\n') 
                : "（まだ登録なし）";

            const prompt = `以下のテキストおよびページ内リンク一覧からイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【重要：既存ライブとの名寄せルール】
現在データベースには以下のライブが登録されています。
${existingNamesListStr}
もし今回の記事が上記リスト内のライブと同じイベント（続報や別先行など）である場合は、表記揺れを防ぐため、"base_live_name" には**上記リストにある文字列と一字一句まったく同じ名称**を出力してください。新規イベントの場合は新しく正式名称を作成してください。

【抽出フォーマット】
{
  "is_target_live": true, 
  "base_live_name": "ライブの基本名称（既存リストにあればその名称、なければ装飾を除外した正式名称）",
  "short_name": "カレンダーの一番上に表示するための分かりやすい略称（例: デレ15周年オケコン、シャニ7th愛知、Apple of my アイ など15文字以内。絶対に空欄にしないこと）",
  "live_date": "ライブ開催初日の日付（YYYY-MM-DD形式。不明なら空文字）",
  "live_end_date": "ライブ最終日の日付（YYYY-MM-DD形式。1日限りの場合はlive_dateと同じ日付。不明なら空文字）",
  "official_url": "イベント公式・特設サイトのURL（下の【ページ内の主なリンク一覧】や本文から、最も該当イベントの特設サイトらしいURLを選んで出力。どうしても無ければ空文字）",
  "venues": "会場名のみを簡潔に（例: Kアリーナ横浜、幕張メッセ 国際展示場 展示ホール9-11など。不明なら未定）",
  "nearest_station": "会場の最寄り駅と所要時間（記事内に記載がなくても、あなたの一般知識から『〇〇駅（徒歩約〇分）』のように具体的に補完してください。会場未定なら『未定』）",
  "schedules": ["Day1: 2月27日(土) 開場15:30 / 開演17:00"],
  "ticket_tier": "今回の記事で現在募集している現地チケットの受付名称（例: アソビストアプレミアム会員先行。複数ある場合は現在受付中または直近のもの）",
  "deadline_date": "上記受付の最終締切日（YYYY-MM-DD形式。不明なら空文字）",
  "result_date_notion": "上記受付の当落発表日（YYYY-MM-DD形式。『当落発表』『抽選結果発表』などの項目を記事の最後まで隅々まで探して抽出してください。不明なら空文字）"
}

【厳格な判定ルール】
・is_target_live: 現地開催（リアル会場）があるアイマス関連の単独音楽ライブ、xRライブ、コンサート、ファンミ、オーケストラであれば true。「遊園地等のコラボ」「上映会」「配信（オンライン）のみのイベント」「外部フェスへの出展」は必ず false。

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

            // ★ 最適化: AIが「非対象」と判定した記事も、次回からAPIを消費しないよう既存カードの「処理済みURL」に相乗り記憶させる
            if (!data || data.is_target_live === false || !data.base_live_name) {
                console.log(` ├─ ⏩ スキップ: AI判定により非対象`);
                if (existingPages.length > 0) {
                    const memoPage = existingPages[0];
                    const currentUrls = memoPage.properties["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
                    const updatedUrls = appendUrlToListString(currentUrls, article.url);
                    try {
                        const updatedMemoPage = await notion.pages.update({
                            page_id: memoPage.id,
                            properties: { "処理済みURL": { rich_text: [{ text: { content: updatedUrls } }] } }
                        });
                        existingPages[0] = updatedMemoPage;
                        processedUrls.add(article.url);
                        console.log(` ├─ 📝 非対象URLを記憶しました（次回から0秒スキップされます）`);
                    } catch (e) {
                        // 記憶失敗時は無視して続行
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 6000));
                continue;
            }
            
            const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
            const displayShortName = data.short_name || data.base_live_name;

            // ★ 名寄せ検索: 「名前(タイトル)」と「略称(テキスト)」のどちらかに正式名称または略称が入っていれば一致とみなす
            let targetPage = existingPages.find(p => {
                const titleText = p.properties["名前"]?.title?.[0]?.plain_text || "";
                const subText = p.properties["略称"]?.rich_text?.[0]?.plain_text || "";
                return (
                    titleText === data.base_live_name || 
                    subText === data.base_live_name || 
                    titleText === displayShortName
                );
            });

            // 予備の名寄せ: 開催初日が一致していれば同一ライブとみなす
            if (!targetPage && isValidDate(data.live_date)) {
                targetPage = existingPages.find(p => {
                    const startDate = p.properties["ライブ開催日"]?.date?.start || "";
                    return startDate === data.live_date;
                });
                if (targetPage) {
                    console.log(` ├─ 💡 開催日(${data.live_date})の一致により、既存ライブと同定しました！`);
                }
            }

            if (!targetPage) {
                // ★ 新規登録: 一番上のタイトル（「名前」）に『略称』を入れ、「略称」欄に『正式名称』を保存する
                const notionPayload = {
                    "名前": { title: [{ text: { content: displayShortName } }] },
                    "略称": { rich_text: [{ text: { content: data.base_live_name } }] },
                    "処理済みURL": { rich_text: [{ text: { content: article.url } }] }
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
                const venueName = data.venues || "未定";
                const stationInfo = data.nearest_station || "情報なし";

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

                // サイドピーク内の青いコールアウトには、分かりやすく「正式名称」を表示
                const childrenBlocks = [
                    { 
                        object: "block", 
                        type: "callout", 
                        callout: { 
                            icon: { type: "emoji", emoji: "🔗" },
                            color: "blue_background",
                            rich_text: [{ type: "text", text: { content: `${data.base_live_name} (イベント公式サイトへ)`, link: { url: linkUrl } }, annotations: { bold: true } }] 
                        } 
                    },
                    { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📍 開催・アクセス情報" } }] } },
                    { 
                        object: "block", 
                        type: "callout", 
                        callout: { 
                            icon: { type: "emoji", emoji: "🏟️" },
                            color: "gray_background",
                            rich_text: venueRichText
                        } 
                    }
                ];
                
                if (Array.isArray(data.schedules)) {
                    data.schedules.forEach(sched => {
                        childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: String(sched) } }] } });
                    });
                }

                const newPage = await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload, children: childrenBlocks });
                console.log(` ├─ ⭐ 成功: 『${displayShortName}』としてNotionに新規登録しました！`);
                
                existingPages.push(newPage);
                existingLiveNames.push(data.base_live_name);
                processedUrls.add(article.url);
                processedCount++;
            } else {
                // 既存ページの上書き更新 ＆ 処理済みURLの追記
                const props = targetPage.properties;
                const updatePayload = {};

                const currentUrlsText = props["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
                const updatedUrlsText = appendUrlToListString(currentUrlsText, article.url);
                updatePayload["処理済みURL"] = { rich_text: [{ text: { content: updatedUrlsText } }] };

                // もし既存カードのタイトルがまだ長い正式名称のままなら、自動的に略称へスイッチさせる
                const currentTitle = props["名前"]?.title?.[0]?.plain_text || "";
                if (currentTitle === data.base_live_name && displayShortName !== data.base_live_name) {
                    updatePayload["名前"] = { title: [{ text: { content: displayShortName } }] };
                    updatePayload["略称"] = { rich_text: [{ text: { content: data.base_live_name } }] };
                }

                if (isValidDate(data.deadline_date)) {
                    updatePayload["締切日"] = { date: { start: data.deadline_date } };
                }
                if (isValidDate(data.result_date_notion)) {
                    updatePayload["当落発表日"] = { date: { start: data.result_date_notion } };
                }
                if (data.ticket_tier) {
                    updatePayload["受付枠"] = { rich_text: [{ text: { content: data.ticket_tier } }] };
                }
                if (isValidDate(data.live_date)) {
                    const dateObj = { start: data.live_date };
                    if (isValidDate(data.live_end_date) && data.live_date !== data.live_end_date) {
                        dateObj.end = data.live_end_date;
                    }
                    updatePayload["ライブ開催日"] = { date: dateObj };
                }

                const updatedPage = await notion.pages.update({ page_id: targetPage.id, properties: updatePayload });
                console.log(` ├─ 🔄 更新: 既存ライブ『${displayShortName}』に最新情報を上書き＆URLを記憶しました！`);
                
                const idx = existingPages.findIndex(p => p.id === targetPage.id);
                if (idx !== -1) existingPages[idx] = updatedPage;
                processedUrls.add(article.url);
                processedCount++;
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
