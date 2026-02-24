import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { jsonrepair } from 'https://esm.sh/jsonrepair@3.4.0';
import { corsHeaders, jsonResponse, errorResponse } from '../_shared/utils.ts';

/**
 * Edge Function: analyze-lesson (Step-based execution)
 * Stages:
 * 1. collecting_sections (also builds focus map)
 * 2. summarizing_batch_i (where payload contains progress cursor)
 * 3. merging_summaries
 * 4. generating_quiz_focus
 * 5. saving_analysis
 * 6. completed | failed
 */

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

async function callGeminiText(prompt: string, apiKey: string): Promise<{ text: string; tokens: number }> {
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
    return { text, tokens };
}

async function callGeminiJSON(prompt: string, apiKey: string): Promise<{ parsed: any; tokens: number }> {
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
    return { parsed, tokens };
}

async function buildFocusMap(supabase: any, lessonId: string): Promise<Set<string>> {
    const { data: sections } = await supabase.from('document_sections')
        .select('id, content, source_type, embedding')
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
    return focusedIds;
}

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

    if (currentBatch.length > 0) batches.push(currentBatch.join('\n\n'));
    return batches;
}

function mergeAndDedup(summaryParts: string[]): string {
    const mergedLectures = new Map<string, { title: string; content: string[] }>();

    for (const chunkText of summaryParts) {
        if (typeof chunkText !== 'string' || !chunkText.trim()) continue;

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
        let md = `## ${lecture.title}\n\n${lecture.content.join('\n')}`;
        finalParts.push(md);
    }

    return finalParts.join('\n\n---\n\n');
}

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

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '86400' }
        });
    }

    try {
        if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

        const body = await req.json();
        const { jobId } = body;

        if (!jobId) {
            return errorResponse('Missing jobId', 400);
        }

        const supabaseUrl = Deno.env.get('APP_SUPABASE_URL') || Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('APP_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';

        if (!supabaseUrl || !supabaseKey || !geminiKey) return errorResponse('Missing Config', 500);

        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: job, error: jobError } = await supabase
            .from('processing_queue')
            .select('*')
            .eq('id', jobId)
            .single();

        if (jobError || !job) return errorResponse('Job not found', 404);

        const lessonId = job.lesson_id;
        let { stage, progress, attempt_count, extraction_cursor, payload } = job;

        stage = stage || 'collecting_sections';
        progress = progress || 0;
        attempt_count = attempt_count || 0;
        extraction_cursor = extraction_cursor || 0;
        // ensure payload is object
        if (!payload || typeof payload !== 'object') payload = {};

        console.log(`[Analyze DBG] Job ${jobId} | Stage: ${stage} | Progress: ${progress}%`);

        const advanceStage = async (newStage: string, newProgress: number, extraUpdates: any = {}) => {
            const { error } = await supabase.from('processing_queue')
                .update({
                    stage: newStage,
                    progress: newProgress,
                    updated_at: new Date().toISOString(),
                    status: 'pending',     // unlock for next step
                    locked_by: null,       // unlock for next step
                    locked_at: null,       // unlock for next step
                    ...extraUpdates
                })
                .eq('id', jobId);
            if (error) throw new Error(`Failed to advance stage: ${error.message}`);
            return jsonResponse({ success: true, stage: newStage, progress: newProgress, status: 'pending' });
        };

        const setFail = async (errMsg: string) => {
            await supabase.from('processing_queue').update({
                status: 'failed',
                stage: 'failed',
                error_message: errMsg,
                updated_at: new Date().toISOString()
            }).eq('id', jobId);

            await supabase.from('lessons')
                .update({ analysis_status: 'failed' })
                .eq('id', lessonId);

            return jsonResponse({ success: false, stage: 'failed', status: 'failed', error: errMsg });
        };

        const setComplete = async () => {
            await supabase.from('processing_queue').update({
                status: 'completed', stage: 'completed', progress: 100, completed_at: new Date().toISOString()
            }).eq('id', jobId);
            await supabase.from('lessons').update({ analysis_status: 'completed' }).eq('id', lessonId);
            return jsonResponse({ success: true, stage: 'completed', progress: 100, status: 'completed' });
        };

        try {
            // ==========================================
            // ATOMIC JOB: generate_book_overview
            // ==========================================
            if (job.job_type === 'generate_book_overview') {
                await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);

                const { data: allSegments } = await supabase.from('lecture_segments')
                    .select('id, title, page_from').eq('lesson_id', lessonId).order('page_from');
                const segIds = allSegments?.map((s: any) => s.id) || [];

                const { data: analyses } = await supabase.from('lecture_analysis')
                    .select('lecture_id, summary').in('lecture_id', segIds);

                let concatenated = '';
                let indexMap: any = { topics: [] };

                for (const seg of (allSegments || [])) {
                    const an = analyses?.find((a: any) => a.lecture_id === seg.id);
                    if (an) {
                        concatenated += `\n\n## درس: ${seg.title} (ص ${seg.page_from})\n`;
                        concatenated += an.summary ? an.summary.substring(0, 3000) : '';
                        indexMap.topics.push({ title: seg.title, page: seg.page_from });
                    }
                }

                let finalSummary = 'تعذر توليد الملخص';
                if (concatenated.trim()) {
                    const prompt = `أنت خبير أكاديمي. بناءً على هذه الملخصات للدروس (والتي تمثل كتاباً كاملاً)، اكتب "نظرة عامة" أو "خلاصة" قصيرة وشاملة للكتاب ككل (Book Overview) في فقرتين إلى 4 فقرات.
المحتوى:
${concatenated.substring(0, 80000)}`;
                    const overviewResult = await callGeminiText(prompt, geminiKey);
                    finalSummary = overviewResult.text;
                }

                await supabase.from('book_analysis').upsert({
                    lesson_id: lessonId,
                    overall_summary: finalSummary,
                    index_map: indexMap,
                    status: 'completed',
                    updated_at: new Date().toISOString()
                }, { onConflict: 'lesson_id' });

                await supabase.from('lessons').update({ analysis_status: 'completed' }).eq('id', lessonId);

                return await setComplete();
            }

            // ==========================================
            // STAGE 1: collecting_sections
            // ==========================================
            if (stage === 'collecting_sections' || stage === 'pending_upload') {
                await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);

                let query = supabase.from('document_sections')
                    .select('id, content, source_type, chunk_index')
                    .eq('lesson_id', lessonId).order('chunk_index');

                if (job.job_type === 'analyze_lecture' && payload.lecture_id) {
                    query = query.eq('lecture_id', payload.lecture_id);
                }

                const { data: allSections } = await query;

                if (!allSections || allSections.length === 0) {
                    if (job.job_type === 'analyze_lecture') {
                        console.warn(`[Analyze] No content for lecture ${payload.lecture_id}, returning early.`);
                        payload.summary = 'لا يوجد محتوى مستخرج كافٍ لهذه المحاضرة.';
                        return await advanceStage('saving_analysis', 85, { payload });
                    }
                    throw new Error('No content found for this lesson to analyze');
                }

                const pdf = allSections.filter((s: any) => s.source_type === 'pdf');
                const audio = allSections.filter((s: any) => s.source_type === 'audio');
                const image = allSections.filter((s: any) => s.source_type === 'image');

                const audioChars = audio.reduce((s: number, x: any) => s + (x.content?.length || 0), 0);

                let focusedIds = new Set<string>();
                if (audioChars > 3000) {
                    try { focusedIds = await buildFocusMap(supabase, lessonId); } catch (e) { }
                }

                let fullContent = '';
                for (const s of pdf) {
                    const marker = focusedIds.has(s.id) ? '⭐ [ركّز عليه المعلم] ' : '';
                    fullContent += marker + s.content + '\n\n';
                }
                if (image.length > 0) {
                    fullContent += '\n=== ملاحظات / صور ===\n\n';
                    for (const s of image) fullContent += s.content + '\n\n';
                }

                let audioText = '';
                if (audio.length > 0) {
                    audioText = audio.map((s: any) => s.content).join('\n\n');
                    fullContent += '\n=== شرح المعلم (تفريغ صوتي) ===\n\n' + audioText + '\n\n';
                }

                // Filtering noise
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

                // Prepare batches
                const batches = splitIntoBatches(cleanParagraphs, 100000, 3);

                // Save to payload
                payload.batches = batches;
                payload.hasAudio = audio.length > 0;
                payload.audioText = audioText;
                payload.summaryParts = [];
                payload.totalTokens = 0;

                return await advanceStage('summarizing_batch_i', 15, { payload, extraction_cursor: 0 });
            }

            // ==========================================
            // STAGE 2: summarizing_batch_i
            // ==========================================
            if (stage === 'summarizing_batch_i') {
                const batches = payload.batches || [];
                const batchIndex = extraction_cursor || 0;

                if (batchIndex >= batches.length) {
                    return await advanceStage('merging_summaries', 50);
                }

                const content = batches[batchIndex];
                const prompt = buildSummaryPrompt(content, batchIndex + 1, batches.length, payload.hasAudio);

                console.log(`[Analyze] Summarizing batch ${batchIndex + 1}/${batches.length}...`);

                const result = await callGeminiText(prompt, geminiKey);

                if (!payload.summaryParts) payload.summaryParts = [];
                payload.summaryParts[batchIndex] = result.text;
                payload.totalTokens = (payload.totalTokens || 0) + result.tokens;

                const nextCursor = batchIndex + 1;
                const nextStage = nextCursor >= batches.length ? 'merging_summaries' : 'summarizing_batch_i';
                const prog = 15 + Math.floor((nextCursor / batches.length) * 35); // 15 to 50%

                return await advanceStage(nextStage, prog, { payload, extraction_cursor: nextCursor });
            }

            // ==========================================
            // STAGE 3: merging_summaries
            // ==========================================
            if (stage === 'merging_summaries') {
                console.log(`[Analyze] Merging summaries...`);
                const validParts = (payload.summaryParts || []).filter((p: string) => p && p.length > 50);
                payload.summary = mergeAndDedup(validParts);

                return await advanceStage('generating_quiz_focus', 60, { payload });
            }

            // ==========================================
            // STAGE 4: generating_quiz_focus
            // ==========================================
            if (stage === 'generating_quiz_focus') {
                console.log(`[Analyze] Generating quizzes and focus points...`);
                let summary = payload.summary || '';
                let lectureCount = (summary.match(/^## /gm) || []).length || 1;
                let focusCount = Math.max(8, Math.min(20, lectureCount * 2));
                let quizCount = Math.max(12, Math.min(30, lectureCount * 3));
                let essayCount = Math.max(3, Math.min(8, lectureCount));

                if (job.job_type === 'analyze_lecture') {
                    lectureCount = 1;
                    focusCount = 5;
                    quizCount = 4;
                    essayCount = 2;
                }

                let quizSourceContent = summary;
                const audioText = payload.audioText || '';

                if (audioText && audioText.length > 100) {
                    const audioForQuiz = audioText.length > 40000 ? audioText.substring(0, 40000) + '\n...(اقتطاع)' : audioText;
                    quizSourceContent += '\n\n=== شرح المعلم الصوتي ===\n\n' + audioForQuiz;
                }

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

                const retryText = quizSourceContent.substring(0, 60000); // For failure retry
                let parsed: any;
                try {
                    const quizResult = await callGeminiJSON(quizPrompt, geminiKey);
                    parsed = normalizeQuizResponse(quizResult.parsed);
                    payload.totalTokens = (payload.totalTokens || 0) + quizResult.tokens;
                } catch (e: any) {
                    console.warn(`[Analyze] Quiz full failed: ${e.message}. Retrying truncated...`);
                    const fall = await callGeminiJSON(quizPrompt.replace(quizSourceContent, retryText), geminiKey);
                    parsed = normalizeQuizResponse(fall.parsed);
                    payload.totalTokens = (payload.totalTokens || 0) + fall.tokens;
                }

                payload.quizParsed = parsed;
                payload.lectureCount = lectureCount;

                return await advanceStage('saving_analysis', 85, { payload });
            }

            // ==========================================
            // STAGE 5: saving_analysis
            // ==========================================
            if (stage === 'saving_analysis') {
                console.log(`[Analyze] Saving result to DB...`);

                const summary = payload.summary || '';
                const quizParsed = payload.quizParsed || { focusPoints: [], quizzes: [], essayQuestions: [] };

                const analysisResult = {
                    summary,
                    focusPoints: quizParsed.focusPoints || [],
                    quizzes: quizParsed.quizzes || [],
                    essayQuestions: quizParsed.essayQuestions || [],
                    metadata: {
                        model: 'gemini-2.5-flash-step',
                        totalTokens: payload.totalTokens || 0,
                        lecturesDetected: payload.lectureCount || 0,
                        generatedAt: new Date().toISOString(),
                        schemaVersion: 10
                    }
                };

                if (job.job_type === 'analyze_lecture' && payload.lecture_id) {
                    const { error: saveErr } = await supabase.from('lecture_analysis').upsert({
                        lecture_id: payload.lecture_id,
                        summary: summary,
                        detailed_explanation: payload.audioText || '',
                        key_points: quizParsed.focusPoints || [],
                        examples: [],
                        quiz: quizParsed.quizzes || [],
                        status: 'completed',
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'lecture_id' });

                    if (saveErr) throw new Error(`Failed to save lecture analysis: ${saveErr.message}`);

                    // Check if all lectures are done
                    const { count: segmentsCount } = await supabase.from('lecture_segments')
                        .select('id', { count: 'exact', head: true }).eq('lesson_id', lessonId);

                    const { data: allSegments } = await supabase.from('lecture_segments').select('id').eq('lesson_id', lessonId);
                    const segIds = allSegments?.map((s: any) => s.id) || [];

                    const { count: analysisCount } = await supabase.from('lecture_analysis')
                        .select('id', { count: 'exact', head: true }).in('lecture_id', segIds);

                    if (segmentsCount && segmentsCount === analysisCount) {
                        console.log(`[Analyze] All ${segmentsCount} lectures analyzed! Spawning book overview...`);
                        await supabase.from('processing_queue').insert({
                            lesson_id: lessonId,
                            job_type: 'generate_book_overview',
                            payload: {},
                            status: 'pending',
                            dedupe_key: `lesson:${lessonId}:generate_book_overview`
                        });
                    }
                } else {
                    const { error: saveErr } = await supabase.from('lessons').update({
                        analysis_result: analysisResult,
                        analysis_status: 'completed'
                    }).eq('id', lessonId);
                    if (saveErr) throw new Error(`Failed to save legacy analysis: ${saveErr.message}`);
                }

                return await setComplete();
            }

            if (stage === 'completed' || stage === 'failed') {
                return jsonResponse({ success: true, stage, status: stage });
            }

            throw new Error(`Unknown stage: ${stage}`);

        } catch (e: any) {
            console.error(`[Analyze DBG] Error in ${stage}: ${e.message}`);
            if (attempt_count >= 3) {
                return await setFail(e.message);
            } else {
                await supabase.from('processing_queue').update({ attempt_count: attempt_count + 1 }).eq('id', jobId);
                return jsonResponse({ success: false, stage, status: 'processing', error: e.message, attempt: attempt_count + 1 });
            }
        }

    } catch (error: any) {
        console.error('Analyze Edge Fatal Error:', error);
        return new Response(
            JSON.stringify({ error: error.message || 'Analysis handler crashed', stack: error.stack }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
