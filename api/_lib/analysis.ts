import type { SupabaseClient } from '@supabase/supabase-js';
import { buildFocusMap } from './focus';

/**
 * Analysis Module — v6 (No Hallucination)
 *
 * KEY FIX: ALWAYS sends ALL content to the AI. Never filters.
 * Focus extraction only MARKS which sections the teacher emphasized,
 * it does NOT remove the rest. This prevents hallucination.
 */

const MAX_CONTENT_CHARS = 2000000;  // 2 million chars — Gemini 2.5 Flash handles ~1M tokens (approx 3-4M chars)
const MAX_VALIDATION_RETRIES = 2;

// ─── Types ──────────────────────────────────────────────

export interface AnalysisResult {
    summary: string;
    focusPoints: Array<{
        title: string;
        details: string;
        evidence?: { pdf_section_ids: string[]; audio_section_ids: string[] };
    }>;
    quizzes: Array<{
        question: string;
        type: string;
        options: string[];
        correctAnswer: number;
        explanation: string;
    }>;
    essayQuestions?: Array<{
        question: string;
        idealAnswer: string;
    }>;
    metadata: {
        model: string;
        contentStats: {
            pdfChars: number;
            audioChars: number;
            imageChars: number;
            method: string;
            focusMatches?: number;
        };
        generatedAt: string;
        schemaVersion: number;
    };
}

// ─── Dynamic Prompt ─────────────────────────────────────

function buildSystemPrompt(totalChars: number): string {
    const isLarge = totalChars > 50000;
    const summaryWords = isLarge ? '2000-4000' : '800-1500';
    const focusCount = isLarge ? '8-15' : '5-8';
    const focusDetailWords = isLarge ? '150-300' : '80-150';
    const quizCount = isLarge ? '15-25' : '8-15';
    const essayCount = isLarge ? '4-6' : '3-4';

    return `أنت مساعد تعليمي خبير وعبقري. ستتلقى محتوى كتاب/ملزمة كاملة + شرح صوتي للمعلم (إن وُجد) + صور.

⚠️ قاعدة أساسية: استخدم المحتوى المقدم لك فقط. لا تخترع أو تضف أي معلومات من خارج النص.

المطلوب إخراجه بصيغة (JSON) حصراً:

1. **summary** (${summaryWords} كلمة): ملخص شامل يغطي الكتاب كاملاً من أول صفحة لآخر صفحة:
   - **قاعدة حاسمة**: قسّم الملخص إلى أقسام بعناوين الدروس/الفصول الموجودة في الكتاب.
   - كل قسم يبدأ بعنوان الدرس كـ ## (مثلاً: ## الدرس الأول: الهمزة)
   - لخّص محتوى كل درس بالتفصيل: المفاهيم، القواعد، الأمثلة، التعريفات.
   - إذا كان الكتاب كتاب حلول، استخلص القواعد والمفاهيم من الأسئلة والإجابات.
   - ادمج شرح المعلم الصوتي في الأقسام ذات الصلة.
   - استخدم تنسيق Markdown بعناوين وقوائم ونقاط.

2. **focusPoints** (${focusCount} نقطة) — **هذه النقاط تمثل ما ركّز عليه المعلم في شرحه الصوتي**:
   - title: عنوان النقطة التي ركّز عليها المعلم.
   - details: شرح تفصيلي (${focusDetailWords} كلمة) يجمع بين ما قاله المعلم في الصوت وما هو مكتوب في الكتاب.
   - **الأجزاء المميزة بـ ⭐ هي التي طابقت شرح المعلم — ركّز عليها في focus.**
   - إذا لم يوجد شرح صوتي، اجعل focusPoints = النقاط الأهم في الكتاب.

3. **quizzes** (${quizCount} سؤال):
   - question: سؤال من المحتوى الفعلي (ليس عام)
   - type: "mcq" أو "tf"
   - options: 4 خيارات دائماً (حتى صح/خطأ: ["صح", "خطأ", "-", "-"])
   - correctAnswer: رقم (0,1,2,3)
   - explanation: شرح الإجابة
   - **أعطِ أولوية لأسئلة من المحتوى الذي ركّز عليه المعلم (⭐)**

4. **essayQuestions** (${essayCount} سؤال مقالي):
   - question: سؤال يتطلب شرح
   - idealAnswer: الإجابة النموذجية (150-300 كلمة)

⚠️ قواعد صارمة:
- correctAnswer = رقم فقط (0,1,2,3)
- options = مصفوفة من 4 دائماً
- كل الأسئلة والملخص من المحتوى المقدم فقط
- الملخص يغطي الكتاب **كاملاً** مقسم بعناوين الدروس
- JSON نقي بالعربية بدون \`\`\`json`;
}

// ─── AI Calls ───────────────────────────────────────────

/** Try to repair truncated JSON (common with large outputs) */
function repairTruncatedJSON(raw: string): any | null {
    try { return JSON.parse(raw); } catch { }

    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m) try { return JSON.parse(m[1].trim()); } catch { }

    let fixed = raw.trim();
    fixed = fixed.replace(/,?\s*"[^"]*$/, '');
    // Remove unterminated string values at the end (even if they contain quotes)
    fixed = fixed.replace(/,?\s*"[^"]+"\s*:\s*"[^]*$/, '');
    fixed = fixed.replace(/,?\s*"[^"]*":\s*$/, '');
    fixed = fixed.replace(/,\s*$/, '');

    let openBraces = 0, openBrackets = 0, inString = false, escape = false;
    for (const ch of fixed) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
    }
    if (inString) fixed += '"';
    for (let i = 0; i < openBrackets; i++) fixed += ']';
    for (let i = 0; i < openBraces; i++) fixed += '}';

    try {
        const parsed = JSON.parse(fixed);
        console.log(`[Analysis] 🔧 Repaired truncated JSON`);
        return parsed;
    } catch { return null; }
}

/** Call Gemini for TEXT output (no JSON constraint — for summaries) */
async function callGeminiText(prompt: string): Promise<{ text: string; tokensUsed: number }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    console.log(`[Analysis] Calling Gemini TEXT (${prompt.length} chars)...`);

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 65536 }
            })
        }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
    const tokens = data.usageMetadata?.totalTokenCount || 0;
    console.log(`[Analysis] ✅ Gemini TEXT: ${text.length} chars, ${tokens} tokens`);
    return { text, tokensUsed: tokens };
}

/** Call Gemini for JSON output (for quizzes/focus points) */
async function callGeminiJSON(prompt: string): Promise<{ parsed: any; tokensUsed: number }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    console.log(`[Analysis] Calling Gemini JSON (${prompt.length} chars)...`);

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 16384, responseMimeType: 'application/json' }
            })
        }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
    if (!content) throw new Error('Gemini JSON empty');

    const parsed = repairTruncatedJSON(content);
    if (!parsed) throw new Error(`Bad JSON from Gemini: ${content.substring(0, 200)}`);

    const tokens = data.usageMetadata?.totalTokenCount || 0;
    console.log(`[Analysis] ✅ Gemini JSON: ${tokens} tokens`);
    return { parsed, tokensUsed: tokens };
}

/** GPT-4o fallback for JSON */
async function callGPT4oJSON(prompt: string): Promise<{ parsed: any; tokensUsed: number }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const MAX_CHARS = 100000;
    const truncated = prompt.length > MAX_CHARS ? prompt.substring(0, MAX_CHARS) + '\n...(اقتطاع)' : prompt;
    console.log(`[Analysis] Calling GPT-4o JSON (${truncated.length} chars)...`);

    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: truncated }],
                temperature: 0.2, max_tokens: 16384, response_format: { type: 'json_object' }
            })
        });

        if (response.status === 429 && attempt < 3) {
            console.log(`[Analysis] ⚠️ GPT-4o 429 (Too Many Requests), retrying in ${attempt * 3}s...`);
            await new Promise(r => setTimeout(r, attempt * 3000));
            continue;
        }
        break;
    }

    if (!response || !response.ok) throw new Error(`GPT-4o error (${response?.status})`);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('GPT-4o empty');
    return { parsed: JSON.parse(content), tokensUsed: result.usage?.total_tokens || 0 };
}

// ─── Normalize + Validate ───────────────────────────────

function normalizeResponse(parsed: any): any {
    if (parsed.focus_points && !parsed.focusPoints) { parsed.focusPoints = parsed.focus_points; delete parsed.focus_points; }
    if (parsed.quiz && !parsed.quizzes) { parsed.quizzes = parsed.quiz; delete parsed.quiz; }
    if (parsed.essay_questions && !parsed.essayQuestions) { parsed.essayQuestions = parsed.essay_questions; delete parsed.essay_questions; }

    if (Array.isArray(parsed.quizzes)) {
        parsed.quizzes = parsed.quizzes.map((q: any) => {
            if (!q.options || !Array.isArray(q.options)) q.options = ['أ', 'ب', 'ج', 'د'];
            while (q.options.length < 4) q.options.push('-');
            if (typeof q.correctAnswer === 'string') {
                const idx = q.options.findIndex((o: string) => o === q.correctAnswer || o.includes(q.correctAnswer));
                q.correctAnswer = idx >= 0 ? idx : 0;
            }
            if (!q.type) q.type = 'mcq';
            if (!q.explanation) q.explanation = '';
            return q;
        });
    }
    return parsed;
}

function validateAnalysis(parsed: any): string | null {
    if (typeof parsed.summary !== 'string' || parsed.summary.length < 50) return 'summary قصير';
    if (!Array.isArray(parsed.focusPoints) || parsed.focusPoints.length === 0) return 'focusPoints فارغ';
    if (!Array.isArray(parsed.quizzes) || parsed.quizzes.length < 3) return 'quizzes < 3';
    for (const q of parsed.quizzes) {
        if (!q.question || !q.options) return 'سؤال ناقص';
        if (typeof q.correctAnswer !== 'number') return `correctAnswer not number`;
    }
    return null;
}

// ─── Main ───────────────────────────────────────────────

export async function generateLessonAnalysis(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string,
    onProgress?: (step: string, message: string, percent: number) => void
): Promise<AnalysisResult> {

    const progress = onProgress || (() => { });
    progress('starting', 'جاري تجهيز محرك التحليل...', 5);
    await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);

    try {
        // ═══ Step 1: ALWAYS fetch ALL content ═══════════════════
        progress('fetching', 'جاري جلب كل محتوى الدرس (PDF + صوت + صور)...', 10);
        console.log(`[Analysis] Fetching all content for lesson ${lessonId}`);
        const { data: allSections, error: fetchErr } = await supabase
            .from('document_sections')
            .select('id, content, chunk_index, source_type, source_file_id')
            .eq('lesson_id', lessonId)
            .order('source_type')
            .order('source_file_id')
            .order('chunk_index');

        if (fetchErr) throw new Error(`Fetch: ${fetchErr.message}`);

        const sections = {
            pdf: (allSections || []).filter((s: any) => s.source_type === 'pdf'),
            audio: (allSections || []).filter((s: any) => s.source_type === 'audio'),
            image: (allSections || []).filter((s: any) => s.source_type === 'image'),
        };

        const pdfChars = sections.pdf.reduce((s: number, r: any) => s + (r.content?.length || 0), 0);
        const audioChars = sections.audio.reduce((s: number, r: any) => s + (r.content?.length || 0), 0);
        const imageChars = sections.image.reduce((s: number, r: any) => s + (r.content?.length || 0), 0);
        const totalChars = pdfChars + audioChars + imageChars;

        console.log(`[Analysis] Content: ${pdfChars} PDF + ${audioChars} audio + ${imageChars} image = ${totalChars} chars`);
        if (totalChars < 50) throw new Error('لا يوجد محتوى كافٍ');

        // ═══ Step 2: Try focus extraction (markers only) ════════
        let focusedIds = new Set<string>();
        let focusMatches = 0;

        if (audioChars > 3000) {
            try {
                progress('focus', 'جاري مطابقة شرح المعلم مع محتوى الكتاب...', 25);
                console.log(`[Analysis] 🔍 Building focus map...`);
                const focus = await buildFocusMap(supabase, lessonId);
                focusMatches = focus.stats.matchedPdfChunks;
                console.log(`[Analysis] Focus: ${focusMatches}/${focus.stats.totalPdfChunks} matched`);
                for (const sec of focus.focusPdfSections) focusedIds.add(sec.id);
            } catch (e: any) {
                console.warn(`[Analysis] ⚠️ Focus: ${e.message}`);
            }
        } else {
            console.log(`[Analysis] ⚠️ Audio too short (${audioChars}), skipping focus`);
        }

        // ═══ Step 3: Build prompts — full lesson coverage (PDF + images + audio) ═══
        let method = 'all-content';

        // Build summary source content from all lesson sources.
        let summarySourceContent = '';
        if (sections.pdf.length > 0) {
            for (const sec of sections.pdf) {
                if (focusedIds.has(sec.id)) {
                    summarySourceContent += `⭐ [ركّز عليه المعلم في شرحه] ${sec.content}\n\n`;
                    method = 'all-content+focus';
                } else {
                    summarySourceContent += sec.content + '\n\n';
                }
            }
        }

        // Add image OCR text.
        if (sections.image.length > 0) {
            summarySourceContent += '\n=== ملاحظات / صور ===\n\n';
            for (const sec of sections.image) summarySourceContent += sec.content + '\n\n';
        }

        // Add audio transcription to guarantee lecture coverage in summary.
        if (sections.audio.length > 0) {
            summarySourceContent += '\n=== شرح المعلم (تفريغ صوتي) ===\n\n';
            for (const sec of sections.audio) summarySourceContent += sec.content + '\n\n';
        }

        const finalMethod = focusMatches > 0 ? method + '+focus' : method;
        console.log(`[Analysis] Summary source content: ${summarySourceContent.length} chars, method: ${finalMethod}`);

        // ═══ Step 4A: Generate SUMMARY in BATCHES (book + images + lectures) ════
        progress('analyzing', 'الذكاء الاصطناعي يولّد ملخصاً شاملاً للكتاب والمحاضرات...', 30);

        let summary = '';
        let totalTokens = 0;

        // ─── Noise filter: remove repetitive/boilerplate paragraphs ───
        const paragraphs = summarySourceContent.split('\n\n').filter((p: string) => p.trim().length > 30);
        const seen = new Map<string, number>();
        const cleanParagraphs: string[] = [];

        for (const p of paragraphs) {
            // Create a fingerprint: first 80 chars normalized
            const fingerprint = p.trim().substring(0, 80).replace(/\s+/g, ' ');
            const count = (seen.get(fingerprint) || 0) + 1;
            seen.set(fingerprint, count);

            // Skip if this fingerprint appeared more than twice
            if (count > 2) continue;

            // Skip common boilerplate patterns
            if (p.includes('حُلَّ هذا الكتاب ورُتِّب') ||
                p.includes('الملف مدعوم') ||
                (p.includes('تسهيلاً وتيسيرًا') && p.length < 200)) continue;

            cleanParagraphs.push(p);
        }

        const cleanContent = cleanParagraphs.join('\n\n');
        const noiseRemoved = summarySourceContent.length - cleanContent.length;
        if (noiseRemoved > 1000) {
            console.log(`[Analysis] 🧹 Noise filter: removed ${noiseRemoved} chars of repetitive content`);
        }

        // ─── Split clean full content into batches with OVERLAP ───
        const BATCH_SIZE = 40000;
        const OVERLAP_PARAGRAPHS = 3; // Keep last 3 paragraphs in next chunk to prevent cutting rules
        const batches: string[] = [];
        let currentBatch: string[] = [];
        let currentLen = 0;

        for (let i = 0; i < cleanParagraphs.length; i++) {
            const part = cleanParagraphs[i];
            if (currentLen + part.length > BATCH_SIZE && currentLen > 5000) {
                batches.push(currentBatch.join('\n\n'));
                // Start new batch with overlap from previous
                const startIndex = Math.max(0, i - OVERLAP_PARAGRAPHS);
                currentBatch = cleanParagraphs.slice(startIndex, i + 1);
                currentLen = currentBatch.reduce((sum, p) => sum + p.length + 2, 0); // +2 for '\n\n'
            } else {
                currentBatch.push(part);
                currentLen += part.length + 2;
            }
        }
        // Don't push the last batch if it's completely redundant (just the overlap)
        if (currentBatch.length > Math.min(OVERLAP_PARAGRAPHS + 1, cleanParagraphs.length)) {
            batches.push(currentBatch.join('\n\n'));
        }

        console.log(`[Analysis] Splitting into ${batches.length} summary batches (${batches.map(b => b.length).join(', ')} chars)`);

        const summaryParts: string[] = [];
        for (let i = 0; i < batches.length; i++) {
            const batchNum = i + 1;
            const totalBatches = batches.length;
            progress('analyzing', `يلخّص الجزء ${batchNum} من ${totalBatches}...`, 30 + Math.round((i / totalBatches) * 30));

            const batchPrompt = `أنت الخبير الأكاديمي المسؤول عن استخراج القواعد من هذا الجزء (الجزء ${batchNum} من ${totalBatches}).
استخرج الدروس والقواعد الموجودة *في هذا النص فقط*.

⚠️⚠️⚠️ قواعد حاسمة:
1. **استخرج القواعد العلمية والنحوية والإملائية.**
2. **تجاهل تماماً نصوص القراءة الحرة، القصص (مثل قصة الناسك وابن عرس)، وتدريبات الاستيعاب القرائي.**
3. **مهم جداً:** إذا انقطعت قاعدة في آخر النص، لخّص ما هو موجود أمامك فقط واجعل partial=true، ولا تؤلف الباقي من عندك!
4. **لا تشتكي من نقص مواضيع الفهرس.** هذا مجرد جزء من الكتاب.
5. **احذر من دمج الدروس:** افصل تماماً بين الدروس المستقلة (مثل فصل "المقال" عن "التقرير").
6. **لا تتوقف قبل النهاية:** تأكد من استخراج وتلخيص الدروس الموجودة في آخر سطر من هذا الجزء.
7. **العمق والتفصيل الشديد (أهم قاعدة):** إياك أن تختصر شرح أي محاضرة! اكتب كل نقطة، كل تعريف، كل شرط، وكل مثال. الشرح السطحي ممنوع قطعاً.

المخرجات المطلوبة (نص Markdown منسق بدقة وبأقصى تفصيل):
- استخدم عنوان من المستوى الثاني (\`##\`) لكل درس جديد (مثل: \`## الجملة الفعلية\` أو \`## كتابة التقرير\`).
- تحت كل عنوان درس، اكتب القواعد والمفاهيم والشرح بالتفصيل الممل في شكل نقاط (علامة \`-\` في بداية السطر).
- لا تترك أي تفصيلة علمية أو لغوية أو إملائية إلا وذكرتها.
- لا تكتب مقدمات أو استنتاجات، ادخل في سرد الدروس وقواعدها مباشرة.

--- محتوى الجزء ${batchNum}/${totalBatches} ---

${batches[i]}`;

            let batchResult = '';
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const result = await callGeminiText(batchPrompt);
                    batchResult = result.text;
                    totalTokens += result.tokensUsed;
                    console.log(`[Analysis] Batch ${batchNum}/${totalBatches}: ${batchResult.length} chars (attempt ${attempt})`);
                    break;
                } catch (e: any) {
                    console.warn(`[Analysis] ⚠️ Batch ${batchNum} attempt ${attempt} failed: ${e.message}`);
                    if (attempt === 3) batchResult = `[فشل تلخيص الجزء ${batchNum}]`;
                    else await new Promise(r => setTimeout(r, 2000));
                }
            }
            if (batchResult && batchResult.length > 50) {
                summaryParts.push(batchResult);
            }
        }

        // ─── Phase 4: Merge and Deduplicate Chunks via Markdown Parsing ───
        console.log(`[Analysis] 🔄 Merging and deduplicating ${summaryParts.length} Text chunks...`);
        const mergedLectures = new Map<string, { title: string; content: string[] }>();

        for (const chunkText of summaryParts) {
            if (typeof chunkText !== 'string') continue;

            const lines = chunkText.split('\n');
            let currentTitle = '';

            for (let line of lines) {
                line = line.trimEnd();
                if (!line.trim()) continue;

                if (line.trim().startsWith('## ')) {
                    const rawTitle = line.trim().substring(3).trim();
                    if (rawTitle.length < 2) continue;

                    // Normalize title
                    currentTitle = rawTitle.replace(/^[\d\.\-\s]+/, '').trim();

                    if (!mergedLectures.has(currentTitle)) {
                        mergedLectures.set(currentTitle, { title: currentTitle, content: [] });
                    }
                } else if (currentTitle && line.trim().length > 5) {
                    // Keep ALL content lines: bullets, paragraphs, sub-headers, etc.
                    const contentArr = mergedLectures.get(currentTitle)!.content;
                    const trimmed = line.trim();
                    // Dedup: skip exact duplicates
                    if (!contentArr.some(existing => existing.trim() === trimmed)) {
                        contentArr.push(line);
                    }
                }
            }
        }

        // Format final summary as Markdown
        const finalSummaryParts: string[] = [];
        let totalContentLines = 0;
        let emptyLecturesFound = 0;

        for (const [_, lecture] of mergedLectures) {
            if (lecture.content.length === 0) {
                console.warn(`[Analysis] ⚠️ Sanity Check: Lecture "${lecture.title}" has no content!`);
                emptyLecturesFound++;
                continue;
            }

            let md = `## ${lecture.title}\n\n`;
            md += lecture.content.join('\n');
            totalContentLines += lecture.content.length;
            finalSummaryParts.push(md);
        }

        summary = finalSummaryParts.join('\n\n---\n\n');
        console.log(`[Analysis] Final summary length: ${summary.length} chars from ${mergedLectures.size} unique lectures, ${totalContentLines} content lines.`);

        // ─── Phase 4.5: Final Sanity Check ───
        if (mergedLectures.size < (totalChars / 50000)) {
            console.warn(`[Analysis] ⚠️ Sanity Check: Extremely low lecture count (${mergedLectures.size}) relative to content size (${totalChars} chars).`);
        }
        if (totalContentLines < mergedLectures.size * 2) {
            console.warn(`[Analysis] ⚠️ Sanity Check: Very few content lines (${totalContentLines}) for ${mergedLectures.size} lectures. Output may be sparse.`);
        }
        if (emptyLecturesFound > 0) {
            console.warn(`[Analysis] ⚠️ Sanity Check: Dropped ${emptyLecturesFound} lectures because they had empty content.`);
        }

        // ═══ Step 4B: Generate QUIZZES + FOCUS + ESSAYS (as JSON) ════
        progress('analyzing', 'يولّد الأسئلة ونقاط التركيز...', 65);

        // Dynamic counts based on detected lectures
        const lectureCount = mergedLectures.size;
        const focusCount = Math.max(10, Math.min(20, lectureCount * 2));
        const quizCount = Math.max(15, Math.min(30, lectureCount * 3));
        const essayCount = Math.max(3, Math.min(8, lectureCount));
        console.log(`[Analysis] ${lectureCount} lectures → ${focusCount} focus, ${quizCount} quiz, ${essayCount} essay`);

        // Build quiz content from FULL merged summary (covers entire book)
        // + audio content for focus extraction
        let quizContent = `=== ملخص الكتاب الشامل (يغطي كل المحاضرات) ===\n\n${summary}`;

        if (sections.audio.length > 0) {
            quizContent += '\n\n=== شرح المعلم ===\n\n';
            const audioText = sections.audio.map((s: any) => s.content).join('\n\n');
            if (audioText.length <= 80000) {
                quizContent += audioText;
            } else {
                const halfWindow = 40000;
                quizContent += `${audioText.slice(0, halfWindow)}\n\n...[اقتطاع]...\n\n${audioText.slice(-halfWindow)}`;
            }
        }

        // Cap total to stay within context
        if (quizContent.length > 200000) {
            quizContent = quizContent.substring(0, 200000) + '\n...(اقتطاع)';
        }

        const quizPrompt = `بناءً على المحتوى التالي (ملخص كتاب كامل + شرح صوتي)، أخرج JSON يحتوي على:

1. **focusPoints** (${focusCount} نقطة) — النقاط المحورية الأهم في الكتاب:
   - title: عنوان النقطة
   - details: شرح تفصيلي (150-300 كلمة)

2. **quizzes** (${quizCount} سؤال متنوع يغطي كل محاضرات الكتاب):
   - question: سؤال محدد من المحتوى
   - type: "mcq" أو "tf"
   - options: 4 خيارات دائماً (حتى صح/خطأ: ["صح", "خطأ", "-", "-"])
   - correctAnswer: رقم (0,1,2,3)
   - explanation: شرح الإجابة

3. **essayQuestions** (${essayCount} سؤال مقالي):
   - question, idealAnswer (150-300 كلمة)

⚠️ وزّع الأسئلة على كل المحاضرات بالتساوي. correctAnswer = رقم فقط. JSON نقي.

--- المحتوى ---

${quizContent}`;

        let quizParsed: any = null;

        try {
            const quizResult = await callGeminiJSON(quizPrompt);
            quizParsed = normalizeResponse(quizResult.parsed);
            totalTokens += quizResult.tokensUsed;
        } catch (e: any) {
            console.warn(`[Analysis] ⚠️ Gemini quizzes failed: ${e.message}. Trying GPT-4o...`);
            try {
                const gptResult = await callGPT4oJSON(quizPrompt);
                quizParsed = normalizeResponse(gptResult.parsed);
                totalTokens += gptResult.tokensUsed;
            } catch (e2: any) {
                console.warn(`[Analysis] ⚠️ GPT-4o quizzes failed: ${e2.message}`);
                quizParsed = { focusPoints: [], quizzes: [], essayQuestions: [] };
            }
        }

        // ═══ Step 5: Save ══════════════════════════════════════
        progress('saving', 'جاري حفظ النتائج في قاعدة البيانات...', 90);
        const analysisResult: AnalysisResult = {
            summary,
            focusPoints: quizParsed.focusPoints || [],
            quizzes: quizParsed.quizzes || [],
            essayQuestions: quizParsed.essayQuestions || [],
            metadata: {
                model: 'gemini-2.5-flash-split',
                contentStats: { pdfChars, audioChars, imageChars, method: finalMethod, focusMatches },
                generatedAt: new Date().toISOString(),
                schemaVersion: 7
            }
        };

        await supabase.from('lessons')
            .update({ analysis_result: analysisResult, analysis_status: 'completed' })
            .eq('id', lessonId);

        console.log(`[Analysis] ✅ Done: ${totalTokens} tokens, summary=${summary.length} chars, ${quizParsed.focusPoints?.length || 0} focus, ${quizParsed.quizzes?.length || 0} quiz, ${quizParsed.essayQuestions?.length || 0} essay`);
        return analysisResult;

    } catch (err: any) {
        console.error(`[Analysis] ❌ ${lessonId}: ${err.message}`);
        await supabase.from('lessons')
            .update({ analysis_status: 'failed', analysis_result: { error: err.message } })
            .eq('id', lessonId);
        throw err;
    }
}

export async function rerunLessonAnalysis(
    supabase: SupabaseClient<any, any, any>,
    lessonId: string
): Promise<AnalysisResult> {
    return generateLessonAnalysis(supabase, lessonId);
}
