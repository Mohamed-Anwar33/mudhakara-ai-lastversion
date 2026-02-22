import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { jsonrepair } from 'https://esm.sh/jsonrepair@3.4.0';
import { corsHeaders, jsonResponse, errorResponse } from '../_shared/utils.ts';

/**
 * Edge Function: analyze-lesson (v9 — Optimized for 150s timeout)
 * 
 * ⏱️ Time budget (150s total):
 *   - DB + Focus: ~5-10s
 *   - Summary batches (PARALLEL): ~15-25s
 *   - Quiz generation: ~15-20s
 *   - Save: ~2s
 *   - Safety margin: ~90s
 * 
 * Strategy:
 *   1. Small content (<120K chars): Single Gemini call → full summary
 *   2. Large content (>120K chars): Split into ~100K-char batches, run in PARALLEL
 *   3. Quiz/focus generated from merged summary (covers entire book)
 */

// ─── JSON Repair ────────────────────────────────────────

function repairTruncatedJSON(raw: string): any | null {
    try { return JSON.parse(raw); } catch { }

    let text = raw.trim();
    const m = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
    if (m) text = m[1].trim();

    try {
        const repaired = jsonrepair(text);
        return JSON.parse(repaired);
    } catch (e: any) {
        console.warn(`[JSONRepair] Failed: ${e.message}`);
    }

    // Manual repair for deeply truncated JSON
    let fixed = text;
    fixed = fixed.replace(/,?\s*"[^"]*$/, '');
    fixed = fixed.replace(/,?\s*"[^"]+":\s*"[^]*$/, '');
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

    try { return JSON.parse(fixed); } catch { return null; }
}

// ─── AI Calls ───────────────────────────────────────────

/** Call Gemini for TEXT output (summaries) — no JSON constraint */
async function callGeminiText(prompt: string, apiKey: string): Promise<{ text: string; tokens: number }> {
    console.log(`[Gemini-TEXT] Sending ${prompt.length} chars...`);
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
    if (!response.ok) throw new Error(`Gemini TEXT: ${data.error?.message || response.status}`);

    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
    const tokens = data.usageMetadata?.totalTokenCount || 0;
    console.log(`[Gemini-TEXT] ✅ Got ${text.length} chars, ${tokens} tokens`);
    return { text, tokens };
}

/** Call Gemini for JSON output (quizzes, focus points) */
async function callGeminiJSON(prompt: string, apiKey: string): Promise<{ parsed: any; tokens: number }> {
    console.log(`[Gemini-JSON] Sending ${prompt.length} chars...`);
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
    if (!response.ok) throw new Error(`Gemini JSON: ${data.error?.message || response.status}`);

    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
    if (!content) throw new Error('Gemini JSON empty response');

    const parsed = repairTruncatedJSON(content);
    if (!parsed) throw new Error(`Bad JSON from Gemini: ${content.substring(0, 200)}`);

    const tokens = data.usageMetadata?.totalTokenCount || 0;
    console.log(`[Gemini-JSON] ✅ Parsed OK, ${tokens} tokens`);
    return { parsed, tokens };
}

// ─── Focus Extraction ───────────────────────────────────

async function buildFocusMap(supabase: any, lessonId: string): Promise<Set<string>> {
    const { data: sections } = await supabase.from('document_sections')
        .select('id, content, source_type, embedding, chunk_index')
        .eq('lesson_id', lessonId);

    if (!sections) return new Set();

    const audio = sections.filter((s: any) => s.source_type === 'audio' && s.embedding);
    const pdf = sections.filter((s: any) => s.source_type === 'pdf');

    if (audio.length === 0) return new Set(pdf.map((s: any) => s.id));

    const focusedIds = new Set<string>();
    const CONCURRENCY = 5;

    for (let i = 0; i < audio.length; i += CONCURRENCY) {
        const batch = audio.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map(async (audioSec: any) => {
            const embedding = typeof audioSec.embedding === 'string'
                ? audioSec.embedding : JSON.stringify(audioSec.embedding);

            const { data: matches } = await supabase.rpc('match_sections', {
                query_embedding: embedding,
                match_threshold: 0.4,
                match_count: 10,
                filter_lesson_id: lessonId,
                filter_source: 'pdf'
            });

            for (const m of (matches || [])) {
                if (m.similarity > 0.45) focusedIds.add(m.id);
            }
        }));
    }

    console.log(`[Focus] ${focusedIds.size} sections matched`);
    return focusedIds;
}

// ─── Batch Splitting ────────────────────────────────────

function splitIntoBatches(paragraphs: string[], batchSize: number, overlapCount: number): string[] {
    const batches: string[] = [];
    let currentBatch: string[] = [];
    let currentLen = 0;

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        if (currentLen + p.length > batchSize && currentLen > 5000) {
            batches.push(currentBatch.join('\n\n'));
            const startIdx = Math.max(0, i - overlapCount);
            currentBatch = paragraphs.slice(startIdx, i + 1);
            currentLen = currentBatch.reduce((sum, part) => sum + part.length + 2, 0);
        } else {
            currentBatch.push(p);
            currentLen += p.length + 2;
        }
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch.join('\n\n'));
    }

    return batches;
}

// ─── Summary Merge & Dedup ──────────────────────────────

function mergeAndDedup(summaryParts: string[]): string {
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

                currentTitle = rawTitle.replace(/^[\d\.\-\s]+/, '').trim();

                if (!mergedLectures.has(currentTitle)) {
                    mergedLectures.set(currentTitle, { title: currentTitle, content: [] });
                }
            } else if (currentTitle && line.trim().length > 5) {
                const contentArr = mergedLectures.get(currentTitle)!.content;
                const trimmed = line.trim();
                if (!contentArr.some(existing => existing.trim() === trimmed)) {
                    contentArr.push(line);
                }
            }
        }
    }

    const finalParts: string[] = [];
    for (const [_, lecture] of mergedLectures) {
        if (lecture.content.length === 0) continue;
        let md = `## ${lecture.title}\n\n`;
        md += lecture.content.join('\n');
        finalParts.push(md);
    }

    console.log(`[Merge] ${mergedLectures.size} unique lectures, ${finalParts.length} with content`);
    return finalParts.join('\n\n---\n\n');
}

// ─── Normalize Quiz Response ────────────────────────────

function normalizeQuizResponse(parsed: any): any {
    if (parsed.focus_points && !parsed.focusPoints) parsed.focusPoints = parsed.focus_points;
    if (parsed.essay_questions && !parsed.essayQuestions) parsed.essayQuestions = parsed.essay_questions;
    if (!parsed.focusPoints) parsed.focusPoints = [];
    if (!parsed.quizzes) parsed.quizzes = [];
    if (!parsed.essayQuestions) parsed.essayQuestions = [];

    for (const q of parsed.quizzes) {
        if (!q.options || !Array.isArray(q.options)) q.options = ['أ', 'ب', 'ج', 'د'];
        while (q.options.length < 4) q.options.push('-');
        if (typeof q.correctAnswer === 'string') {
            const idx = (q.options || []).indexOf(q.correctAnswer);
            q.correctAnswer = idx >= 0 ? idx : 0;
        }
        if (!q.type) q.type = 'mcq';
        if (!q.explanation) q.explanation = '';
    }
    return parsed;
}

// ─── Build Summary Prompt ───────────────────────────────

function buildSummaryPrompt(content: string, batchNum: number, totalBatches: number, hasAudio: boolean): string {
    const batchInfo = totalBatches > 1 ? ` (الجزء ${batchNum} من ${totalBatches})` : '';
    const audioNote = hasAudio ? '\n6. **الأجزاء المميزة بـ ⭐ ركّز عليها المعلم في شرحه الصوتي** — أعطها اهتماماً إضافياً.' : '';

    return `أنت خبير أكاديمي متخصص. مطلوب منك استخراج وتلخيص كل الدروس والمحاضرات الموجودة في هذا النص${batchInfo} من الكتاب/الملزمة.

⚠️⚠️⚠️ قواعد حاسمة:
1. **استخرج كل درس/محاضرة/فصل** موجود في هذا النص. لا تتجاهل أي محاضرة أبداً.
2. **اكتب تحت كل محاضرة** شرحاً تفصيلياً شاملاً: كل المفاهيم، التعريفات، القواعد، الأمثلة، الملاحظات. الاختصار ممنوع.
3. **حافظ على الترتيب** الموجود في الكتاب الأصلي.
4. إذا انقطعت محاضرة في آخر النص، لخّص الموجود فقط ولا تختلق باقيه.
5. **لا تكتب مقدمات أو خاتمات**. ادخل مباشرة في المحتوى.${audioNote}

المخرجات (نص Markdown — ليس JSON):
- عنوان كل محاضرة/درس بـ \`## عنوان المحاضرة\`
- تحت كل عنوان: شرح تفصيلي بنقاط (\`- \`) وفقرات
- كل التعريفات والقواعد والأمثلة والشروط

--- المحتوى${batchInfo} ---

${content}`;
}

// ─── Main Handler ───────────────────────────────────────

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '86400' }
        });
    }

    try {
        if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

        const body = await req.json();
        const { lessonId } = body;
        if (!lessonId) return errorResponse('Missing lessonId', 400);

        const supabaseUrl = Deno.env.get('APP_SUPABASE_URL') || Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('APP_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';

        if (!supabaseUrl || !supabaseKey) return errorResponse('Missing Supabase config', 500);
        if (!geminiKey) return errorResponse('Missing GEMINI_API_KEY', 500);

        const supabase = createClient(supabaseUrl, supabaseKey);
        const startTime = Date.now();
        const elapsed = () => ((Date.now() - startTime) / 1000);

        // 1. Update status
        await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);

        // 2. Fetch ALL content
        const { data: allSections } = await supabase.from('document_sections')
            .select('id, content, source_type, embedding, chunk_index')
            .eq('lesson_id', lessonId).order('chunk_index');

        if (!allSections || allSections.length === 0) {
            return errorResponse('No content found for this lesson', 400);
        }

        const pdf = allSections.filter((s: any) => s.source_type === 'pdf');
        const audio = allSections.filter((s: any) => s.source_type === 'audio');
        const image = allSections.filter((s: any) => s.source_type === 'image');

        const pdfChars = pdf.reduce((s: number, x: any) => s + (x.content?.length || 0), 0);
        const audioChars = audio.reduce((s: number, x: any) => s + (x.content?.length || 0), 0);
        const imageChars = image.reduce((s: number, x: any) => s + (x.content?.length || 0), 0);
        const totalChars = pdfChars + audioChars + imageChars;

        console.log(`[Analysis] ⏱️ ${elapsed().toFixed(1)}s | Content: ${pdf.length} PDF (${pdfChars}), ${audio.length} audio (${audioChars}), ${image.length} image (${imageChars}). Total: ${totalChars}`);

        // 3. Build focus map (only if audio exists & has embeddings)
        let focusedIds = new Set<string>();
        if (audioChars > 3000) {
            try {
                focusedIds = await buildFocusMap(supabase, lessonId);
            } catch (e: any) {
                console.warn(`[Analysis] Focus failed: ${e.message}`);
            }
        }
        console.log(`[Analysis] ⏱️ ${elapsed().toFixed(1)}s | Focus done: ${focusedIds.size} matches`);

        // 4. Build full content text with focus markers
        let fullContent = '';
        for (const s of pdf) {
            const marker = focusedIds.has(s.id) ? '⭐ [ركّز عليه المعلم] ' : '';
            fullContent += marker + s.content + '\n\n';
        }
        if (image.length > 0) {
            fullContent += '\n=== ملاحظات / صور ===\n\n';
            for (const s of image) fullContent += s.content + '\n\n';
        }

        // Add audio transcription to the content for comprehensive analysis
        let audioText = '';
        if (audio.length > 0) {
            audioText = audio.map((s: any) => s.content).join('\n\n');
            fullContent += '\n=== شرح المعلم (تفريغ صوتي) ===\n\n' + audioText + '\n\n';
        }

        // 5. Noise filter: remove repetitive paragraphs
        const paragraphs = fullContent.split('\n\n').filter((p: string) => p.trim().length > 30);
        const seen = new Map<string, number>();
        const cleanParagraphs: string[] = [];

        for (const p of paragraphs) {
            const fingerprint = p.trim().substring(0, 80).replace(/\s+/g, ' ');
            const count = (seen.get(fingerprint) || 0) + 1;
            seen.set(fingerprint, count);
            if (count > 2) continue;
            cleanParagraphs.push(p);
        }

        const cleanContent = cleanParagraphs.join('\n\n');
        console.log(`[Analysis] ⏱️ ${elapsed().toFixed(1)}s | Clean content: ${cleanContent.length} chars (removed ${fullContent.length - cleanContent.length} noise)`);

        // ═══════════════════════════════════════════════════════════
        // PHASE A: Generate SUMMARY
        //   - Small (<120K): Single call → ~15-20s
        //   - Large (>120K): Split into ~100K batches → PARALLEL → ~15-25s
        // ═══════════════════════════════════════════════════════════

        let totalTokens = 0;
        let summary = '';
        const hasAudio = audio.length > 0;

        if (cleanContent.length <= 120000) {
            // ──── SMALL/MEDIUM: Single Gemini call ────
            console.log(`[Analysis] 📝 Single-call mode (${cleanContent.length} chars)`);

            const prompt = buildSummaryPrompt(cleanContent, 1, 1, hasAudio);

            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const result = await callGeminiText(prompt, geminiKey);
                    summary = result.text;
                    totalTokens += result.tokens;
                    break;
                } catch (e: any) {
                    console.warn(`[Analysis] Single-call attempt ${attempt} failed: ${e.message}`);
                    if (attempt === 2) throw new Error(`Summary generation failed: ${e.message}`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

        } else {
            // ──── LARGE: Batch + Parallel ────
            // Gemini 2.5 Flash: 1M token context ≈ 3-4M chars input
            // Each batch ~100K chars → Gemini handles it easily
            // Run up to 3 batches in PARALLEL to save time
            const BATCH_SIZE = 100000;
            const OVERLAP = 3;
            const batches = splitIntoBatches(cleanParagraphs, BATCH_SIZE, OVERLAP);
            console.log(`[Analysis] 📝 Batch mode: ${batches.length} batches (${batches.map(b => b.length).join(', ')} chars)`);

            // Run batches in parallel groups of 3
            const PARALLEL_LIMIT = 3;
            const summaryParts: string[] = new Array(batches.length).fill('');

            for (let groupStart = 0; groupStart < batches.length; groupStart += PARALLEL_LIMIT) {
                // Check time: need at least 30s for quiz generation
                if (elapsed() > 110 && summaryParts.some(p => p.length > 0)) {
                    console.warn(`[Analysis] ⏱️ Time pressure (${elapsed().toFixed(0)}s), stopping batches at group ${groupStart}`);
                    break;
                }

                const groupEnd = Math.min(groupStart + PARALLEL_LIMIT, batches.length);
                const groupIndices = Array.from({ length: groupEnd - groupStart }, (_, i) => groupStart + i);

                console.log(`[Analysis] ⏱️ ${elapsed().toFixed(1)}s | Sending batch group [${groupIndices.map(i => i + 1).join(',')}] in PARALLEL...`);

                const promises = groupIndices.map(i => {
                    const prompt = buildSummaryPrompt(batches[i], i + 1, batches.length, hasAudio);
                    return callGeminiText(prompt, geminiKey)
                        .then(result => {
                            summaryParts[i] = result.text;
                            totalTokens += result.tokens;
                            console.log(`[Analysis] Batch ${i + 1}: ${result.text.length} chars ✅`);
                        })
                        .catch(e => {
                            console.warn(`[Analysis] Batch ${i + 1} failed: ${e.message}`);
                            summaryParts[i] = '';
                        });
                });

                await Promise.allSettled(promises);
            }

            // Merge and deduplicate
            const validParts = summaryParts.filter(p => p.length > 50);
            summary = mergeAndDedup(validParts);
        }

        console.log(`[Analysis] ⏱️ ${elapsed().toFixed(1)}s | Summary: ${summary.length} chars`);

        // ═══════════════════════════════════════════════════════════
        // PHASE B: Generate QUIZZES + FOCUS + ESSAYS (JSON)
        // Uses the FULL merged summary so questions cover the ENTIRE book
        // ═══════════════════════════════════════════════════════════

        const lectureCount = (summary.match(/^## /gm) || []).length;
        const focusCount = Math.max(8, Math.min(20, lectureCount * 2));
        const quizCount = Math.max(12, Math.min(30, lectureCount * 3));
        const essayCount = Math.max(3, Math.min(8, lectureCount));

        console.log(`[Analysis] ${lectureCount} lectures → ${focusCount} focus, ${quizCount} quiz, ${essayCount} essay`);

        // For quiz generation: send the summary (already covers entire book)
        // + audio for teacher emphasis
        let quizSourceContent = summary;

        if (audioText && audioText.length > 100) {
            // Add condensed audio: important for focus points and teacher emphasis
            const audioForQuiz = audioText.length > 40000 ? audioText.substring(0, 40000) + '\n...(اقتطاع)' : audioText;
            quizSourceContent += '\n\n=== شرح المعلم الصوتي ===\n\n' + audioForQuiz;
        }

        // Cap to stay safe within Gemini context
        if (quizSourceContent.length > 180000) {
            quizSourceContent = quizSourceContent.substring(0, 180000) + '\n...(اقتطاع)';
        }

        const quizPrompt = `بناءً على المحتوى التالي (ملخص كتاب كامل + شرح صوتي إن وُجد)، أخرج JSON يحتوي على:

1. **focusPoints** (${focusCount} نقطة) — النقاط المحورية الأهم في الكتاب:
   - title: عنوان النقطة
   - details: شرح تفصيلي (150-300 كلمة) يجمع بين محتوى الكتاب وشرح المعلم

2. **quizzes** (${quizCount} سؤال متنوع يغطي كل محاضرات الكتاب):
   - question: سؤال من المحتوى (محدد وليس عام)
   - type: "mcq" أو "tf"
   - options: 4 خيارات دائماً (حتى صح/خطأ: ["صح", "خطأ", "-", "-"])
   - correctAnswer: رقم (0,1,2,3)
   - explanation: شرح الإجابة

3. **essayQuestions** (${essayCount} سؤال مقالي):
   - question: سؤال يتطلب شرح
   - idealAnswer: الإجابة النموذجية (150-300 كلمة)

⚠️ قواعد:
- وزّع الأسئلة على كل محاضرات الكتاب بالتساوي، لا تركّز على محاضرة واحدة فقط
- correctAnswer = رقم فقط (0,1,2,3)
- options = مصفوفة من 4 دائماً
- JSON نقي بدون \`\`\`json

--- المحتوى ---

${quizSourceContent}`;

        let quizParsed: any = { focusPoints: [], quizzes: [], essayQuestions: [] };

        // Check time: only generate quizzes if we have time
        if (elapsed() < 130) {
            try {
                const quizResult = await callGeminiJSON(quizPrompt, geminiKey);
                quizParsed = normalizeQuizResponse(quizResult.parsed);
                totalTokens += quizResult.tokens;
            } catch (e: any) {
                console.warn(`[Analysis] ⚠️ Quiz generation failed: ${e.message}`);
                // Retry with smaller content if time allows
                if (elapsed() < 135) {
                    try {
                        const smallerPrompt = quizPrompt.substring(0, 80000);
                        const retry = await callGeminiJSON(smallerPrompt, geminiKey);
                        quizParsed = normalizeQuizResponse(retry.parsed);
                        totalTokens += retry.tokens;
                    } catch (e2: any) {
                        console.warn(`[Analysis] ⚠️ Quiz retry failed: ${e2.message}`);
                    }
                }
            }
        } else {
            console.warn(`[Analysis] ⏱️ Skipping quiz generation (${elapsed().toFixed(0)}s elapsed, too close to timeout)`);
        }

        // ═══════════════════════════════════════════════════════════
        // PHASE C: Save Results
        // ═══════════════════════════════════════════════════════════

        const analysisResult = {
            summary,
            focusPoints: quizParsed.focusPoints || [],
            quizzes: quizParsed.quizzes || [],
            essayQuestions: quizParsed.essayQuestions || [],
            metadata: {
                model: 'gemini-2.5-flash-v9',
                contentStats: {
                    pdfChars,
                    audioChars,
                    imageChars,
                    totalSections: allSections.length,
                    lecturesDetected: lectureCount,
                    focusMatches: focusedIds.size,
                    processingTime: elapsed().toFixed(1) + 's'
                },
                generatedAt: new Date().toISOString(),
                schemaVersion: 9
            }
        };

        await supabase.from('lessons').update({
            analysis_result: analysisResult,
            analysis_status: 'completed'
        }).eq('id', lessonId);

        console.log(`[Analysis] ✅ Done in ${elapsed().toFixed(1)}s: ${totalTokens} tokens, ${summary.length} chars summary, ${lectureCount} lectures, ${quizParsed.focusPoints?.length || 0} focus, ${quizParsed.quizzes?.length || 0} quiz, ${quizParsed.essayQuestions?.length || 0} essay`);

        return jsonResponse({ success: true, data: analysisResult });

    } catch (error: any) {
        console.error('Analysis Fatal Error:', error);
        return new Response(
            JSON.stringify({ error: error.message || 'Analysis failed', stack: error.stack }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
