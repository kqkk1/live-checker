const { chromium } = require('playwright');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// API制限(429)やサーバー混雑(503)時の自動リトライ関数
async function fetchWithRetry(url, options, maxRetries = 4) {
    for (let i = 0; i < maxRetries; i++) {
        try {
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
        } catch (err) {
            console.log(` ├─ ⚠️ 通信エラー: ${err.message}。再試行します...(${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 15000));
        }
    }
    console.log(` ├─ ❌ リトライ上限（${maxRetries}回）に到達しました。次の記事へ進みます。`);
    return null;
}

// 処理済みURLを安全に追記・整形する関数（Notionの2000文字制限対策済み）
function appendUrlToListString(currentUrlsText, newUrl) {
    const urlList = currentUrlsText ? currentUrlsText.split(',').map(u => u.trim()).filter(Boolean) : [];
    if (!urlList.includes(newUrl)) {
        urlList.push(newUrl);
    }
    return urlList.slice(-20).join(', ');
}

// AIが万が一長い略称を出した場合でも、確実に短く整える安全フィルター
function enforceShortName(shortName, fullName) {
    let target = (shortName && shortName.trim() !== "") ? shortName.trim() : fullName;
    
    // もしフルネームにある「PRODUCER MEETING」や「PM」が略称から抜け落ちていた場合は補完する
    const isPM = /PRODUCER\s*MEETING|プロデューサーミーティング|\bPM\b/i.test(fullName);
    
    target = target
        .replace(/THE IDOLM@STER\s*/gi, '')
        .replace(/アイドルマスター\s*/g, '')
        .replace(/CINDERELLA GIRLS/gi, 'デレ')
        .replace(/シンデレラガールズ/g, 'デレ')
        .replace(/MILLION LIVE!/gi, 'ミリオン')
        .replace(/ミリオンライブ！?/g, 'ミリオン')
        .replace(/SHINY COLORS/gi, 'シャニ')
        .replace(/シャイニーカラーズ/g, 'シャニ')
        .replace(/SideM/gi, 'SideM')
        .replace(/学園アイドルマスター/g, '学マス')
        .replace(/PRODUCER MEETING/gi, 'PM')
        .replace(/プロデューサーミーティング/g, 'PM')
        .replace(/Anniversary/gi, '周年')
        .replace(/Memorial/gi, '')
        .replace(/Orchestra Concert/gi, 'オケコン')
        .replace(/\s+/g, ' ')
        .trim();

    if (isPM && !target.includes('PM') && !target.includes('ファンミ')) {
        target = target.replace(/^(ミリオン|デレ|シャニ|SideM|学マス|765)/, '$1PM ');
    }
    return target;
}

async function run() {
    console.log("🚀 スナイパー起動（最終完成版：略称プロパティ廃止・ツアー公演自動分割・PM表記保証）");
    
    console.log("Notionの既存データを読み込み中...");
    let existingPages = [];
    let processedUrls = new Set();
    let existingListForAI = [];

    try {
        // ページ数が増えても全件確実に取得するページネーション対応
        let hasMore = true;
        let startCursor = undefined;
        while (hasMore) {
            const dbQuery = await notion.databases.query({ 
                database_id: process.env.NOTION_DB_ID,
                start_cursor: startCursor
            });
            existingPages.push(...dbQuery.results);
            hasMore = dbQuery.has_more;
            startCursor = dbQuery.next_cursor;
        }

        for (let i = 0; i < existingPages.length; i++) {
            const page = existingPages[i];
            const titleText = page.properties["名前"]?.title?.[0]?.plain_text || "";
            const startDate = page.properties["ライブ開催日"]?.date?.start || "";
            
            // もし既存カード（手打ち以外）の「名前」に30文字以上の長い正式名称が残っていたら、自動で短縮修復する
            if (titleText.length > 28 && /IDOLM@STER|アイドルマスター/i.test(titleText)) {
                const autoShort = enforceShortName("", titleText);
                if (autoShort !== titleText) {
                    console.log(` ├─ 🔧 自動短縮: 既存カード『${titleText}』を『${autoShort}』へ修復します...`);
                    try {
                        const fixedPage = await notion.pages.update({
                            page_id: page.id,
                            properties: { "名前": { title: [{ text: { content: autoShort } }] } }
                        });
                        existingPages[i] = fixedPage;
                    } catch (e) {}
                }
            }

            const currentTitle = existingPages[i].properties["名前"]?.title?.[0]?.plain_text || "";
            if (currentTitle) {
                existingListForAI.push(`・略称: "${currentTitle}" (開催初日: ${startDate || "未定"})`);
            }

            const urlsText = existingPages[i].properties["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
            if (urlsText) {
                urlsText.split(',').map(u => u.trim()).filter(Boolean).forEach(u => processedUrls.add(u));
            }
        }
        console.log(` ├─ 登録済みライブ枠: ${existingPages.length}件 / 記憶済み記事URL: ${processedUrls.size}件`);
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
        // 古い記事から順（下から上）に処理することで、Notionの「作成日時（降順）」ソート時に新しい記事が一番上に来るように最適化
        const articles = Array.from(uniqueUrls.values()).reverse();
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
            
            const existingNamesListStr = existingListForAI.length > 0 
                ? existingListForAI.join('\n') 
                : "（まだ登録なし）";

            // ★ 複数日程（名古屋公演・東京公演など）を自動的に別々のオブジェクトとして分割抽出させるプロンプト
            const prompt = `以下のテキストおよびページ内リンク一覧からイベント情報を抽出し、指定されたJSONフォーマットのみを出力してください。Markdownブロックは不要です。

【最重要①：複数公演（ツアーや別日程）の分割ルール】
もし1つの記事内に「名古屋公演（1/30〜1/31）」と「東京公演（3/21〜3/22）」のように、**日程が離れた複数の公演（別会場・別週末）が含まれている場合は、カレンダー上で期間が繋がってしまうのを防ぐため、必ず公演（日程ブロック）ごとに別々の要素として "events" 配列に分割**して出力してください。
（※連続する土日のDay1・Day2は1つの要素にまとめ、日程が数日以上離れている公演同士は必ず別要素に分けてください）

【最重要②：略称（short_name）の命名ルールと既存ライブとの名寄せ】
現在データベースには以下のライブが登録されています。
${existingNamesListStr}
・もし今回の記事が上記リスト内のライブと同じ公演（続報や別先行）である場合は、表記揺れを防ぐため、"short_name" には**上記リストにある略称と一字一句まったく同じ名称**を出力してください。
・新規登録となる場合の "short_name" は、カレンダーの一番上に表示するため15文字以内で作成してください。
・**PRODUCER MEETING（プロデューサーミーティング）の場合は、どの公演であっても絶対に「PM」という文字を略称から省かないでください**（例：「ミリオンPM名古屋」「ミリオンPM東京」のように、すべての分割公演に「PM」と「都市名」を入れること）。

【抽出フォーマット】
{
  "is_target_live": true,
  "events": [
    {
      "full_official_name": "イベントの正式フルタイトル（サイドピーク内の公式サイトリンク文字に使用します。複数公演ある場合は『正式名称 名古屋公演』のように公演名も補完してください）",
      "short_name": "カレンダー表示用の略称（例: ミリオンPM名古屋、ミリオンPM東京、デレ15周年オケコン、Apple of my アイ など15文字以内）",
      "live_date": "その公演の開催初日の日付（YYYY-MM-DD形式。不明なら空文字）",
      "live_end_date": "その公演の最終日の日付（YYYY-MM-DD形式。1日限りの場合はlive_dateと同じ日付。3ヶ月先の別公演の日付と繋げるのは厳禁）",
      "official_url": "イベント公式・特設サイトのURL（下の【ページ内の主なリンク一覧】から最も該当イベントの特設サイトらしいURLを選択。無ければ空文字）",
      "venues": "その公演の会場名のみを簡潔に（例: 愛知県芸術劇場 大ホール、Kアリーナ横浜 など。不明なら未定）",
      "nearest_station": "会場の最寄り駅と所要時間（記事内に記載がなくても一般知識から『栄駅（徒歩約3分）』のように具体的に補完。会場未定なら『未定』）",
      "schedules": [
        "Day1: 1月30日(土) 開場16:00 / 開演17:00",
        "Day2: 1月31日(日) ①開場12:00/開演13:00 ②開場16:30/開演17:30"
      ],
      "ticket_tier": "この公演に対して今回の記事で現在募集している現地チケットの受付名称（例: アソビストアプレミアム会員先行）",
      "deadline_date": "上記受付の最終締切日（YYYY-MM-DD形式。今回の記事でこの公演の募集がない場合は空文字）",
      "result_date_notion": "上記受付の当落発表日（YYYY-MM-DD形式。『当落発表』『抽選結果確認』などを記事の最後まで探して抽出。不明なら空文字）"
    }
  ]
}

【厳格な判定ルール】
・is_target_live: 現地開催（リアル会場）があるアイマス関連の単独音楽ライブ、xRライブ、コンサート、PM（プロデューサーミーティング）、ファンミ、オーケストラであれば true。「遊園地等のコラボ」「上映会」「配信（オンライン）のみのイベント」「外部フェスへの出展」は必ず false。

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

            const eventsList = (data && Array.isArray(data.events)) ? data.events : [];

            if (!data || data.is_target_live === false || eventsList.length === 0) {
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
                    } catch (e) {}
                }
                await new Promise(resolve => setTimeout(resolve, 6000));
                continue;
            }
            
            const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

            // ★ 分割された各公演（例: 名古屋公演、東京公演）ごとにループしてNotionへ登録・更新
            for (const ev of eventsList) {
                const fullOfficialName = ev.full_official_name || ev.base_live_name || article.title || "アイマスイベント";
                const displayShortName = enforceShortName(ev.short_name, fullOfficialName);

                // 名寄せ検索: ①開催初日の一致（最優先・確実） または ②名前（略称・正式名）の一致
                let targetPage = null;
                if (isValidDate(ev.live_date)) {
                    targetPage = existingPages.find(p => {
                        const startDate = p.properties["ライブ開催日"]?.date?.start || "";
                        return startDate === ev.live_date;
                    });
                }
                if (!targetPage) {
                    targetPage = existingPages.find(p => {
                        const titleText = p.properties["名前"]?.title?.[0]?.plain_text || "";
                        return titleText !== "" && (titleText === displayShortName || titleText === fullOfficialName);
                    });
                }

                if (!targetPage) {
                    // 新規登録（「略称」プロパティは完全に廃止し、「名前」に略称のみを入れる）
                    const notionPayload = {
                        "名前": { title: [{ text: { content: displayShortName } }] },
                        "処理済みURL": { rich_text: [{ text: { content: article.url } }] }
                    };

                    if (ev.ticket_tier) notionPayload["受付枠"] = { rich_text: [{ text: { content: ev.ticket_tier } }] };
                    if (isValidDate(ev.deadline_date)) notionPayload["締切日"] = { date: { start: ev.deadline_date } };
                    if (isValidDate(ev.result_date_notion)) notionPayload["当落発表日"] = { date: { start: ev.result_date_notion } };
                    
                    if (isValidDate(ev.live_date)) {
                        const dateObj = { start: ev.live_date };
                        if (isValidDate(ev.live_end_date) && ev.live_date !== ev.live_end_date) {
                            dateObj.end = ev.live_end_date;
                        }
                        notionPayload["ライブ開催日"] = { date: dateObj };
                    }

                    const linkUrl = (ev.official_url && ev.official_url.startsWith('http')) ? ev.official_url : article.url;
                    const venueName = ev.venues || "未定";
                    const stationInfo = ev.nearest_station || "情報なし";

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

                    // ★ サイドピーク内の公式サイトリンクには「フルタイトル（fullOfficialName）」を表示
                    const childrenBlocks = [
                        { 
                            object: "block", 
                            type: "callout", 
                            callout: { 
                                icon: { type: "emoji", emoji: "🔗" },
                                color: "blue_background",
                                rich_text: [{ type: "text", text: { content: `${fullOfficialName} (イベント公式サイトへ)`, link: { url: linkUrl } }, annotations: { bold: true } }] 
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
                    
                    if (Array.isArray(ev.schedules)) {
                        ev.schedules.forEach(sched => {
                            childrenBlocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: String(sched) } }] } });
                        });
                    }

                    const newPage = await notion.pages.create({ parent: { database_id: process.env.NOTION_DB_ID }, properties: notionPayload, children: childrenBlocks });
                    console.log(` ├─ ⭐ 新規登録: 『${displayShortName}』（期間: ${ev.live_date}〜${ev.live_end_date || ev.live_date}）`);
                    
                    existingPages.push(newPage);
                    existingListForAI.push(`・略称: "${displayShortName}" (開催初日: ${ev.live_date || "未定"})`);
                    processedCount++;
                } else {
                    // 既存ページの更新
                    const props = targetPage.properties;
                    const updatePayload = {
                        "名前": { title: [{ text: { content: displayShortName } }] }
                    };

                    const currentUrlsText = props["処理済みURL"]?.rich_text?.[0]?.plain_text || "";
                    const updatedUrlsText = appendUrlToListString(currentUrlsText, article.url);
                    updatePayload["処理済みURL"] = { rich_text: [{ text: { content: updatedUrlsText } }] };

                    if (isValidDate(ev.deadline_date)) {
                        updatePayload["締切日"] = { date: { start: ev.deadline_date } };
                    }
                    if (isValidDate(ev.result_date_notion)) {
                        updatePayload["当落発表日"] = { date: { start: ev.result_date_notion } };
                    }
                    if (ev.ticket_tier) {
                        updatePayload["受付枠"] = { rich_text: [{ text: { content: ev.ticket_tier } }] };
                    }
                    if (isValidDate(ev.live_date)) {
                        const dateObj = { start: ev.live_date };
                        if (isValidDate(ev.live_end_date) && ev.live_date !== ev.live_end_date) {
                            dateObj.end = ev.live_end_date;
                        }
                        updatePayload["ライブ開催日"] = { date: dateObj };
                    }

                    const updatedPage = await notion.pages.update({ page_id: targetPage.id, properties: updatePayload });
                    console.log(` ├─ 🔄 既存更新: 『${displayShortName}』（期間: ${ev.live_date}〜${ev.live_end_date || ev.live_date}）`);
                    
                    const idx = existingPages.findIndex(p => p.id === targetPage.id);
                    if (idx !== -1) existingPages[idx] = updatedPage;
                    processedCount++;
                }
            }

            processedUrls.add(article.url);
            console.log(" ├─ ⏳ APIレート制限回避のため12秒待機します...");
            await new Promise(resolve => setTimeout(resolve, 12000));
        }
        console.log(`\n🎉 全処理完了！ 新規・更新枠: ${processedCount}件`);
    } catch (error) {
        console.error("致命的なエラー:", error);
    } finally {
        await browser.close();
    }
}
run();
