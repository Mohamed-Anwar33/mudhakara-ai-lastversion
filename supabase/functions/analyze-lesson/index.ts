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
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
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

            if (!response.ok) {
                if (response.status === 429 || response.status >= 500) {
                    if (attempt < maxAttempts - 1) {
                        const delay = Math.min(Math.pow(2, attempt) * 2000, 20000);
                        console.warn(`[Gemini Text] ${response.status} Error. Retrying in ${delay / 1000}s...`);
                        await new Promise(res => setTimeout(res, delay));
                        continue;
                    }
                }
                throw new Error(`Gemini TEXT: ${data.error?.message || response.status}`);
            }

            const parts = data.candidates?.[0]?.content?.parts || [];
            const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
            const tokens = data.usageMetadata?.totalTokenCount || 0;
            return { text, tokens };
        } catch (error: any) {
            if (attempt < maxAttempts - 1 && (
                error.message.includes('fetch') ||
                error.message.includes('network') ||
                error.message.includes('429') ||
                error.message.includes('503')
            )) {
                const delay = Math.min(Math.pow(2, attempt) * 2000, 20000);
                console.warn(`[Gemini Text] Retry ${attempt + 1}: ${(delay / 1000).toFixed(1)}s...`);
                await new Promise(res => setTimeout(res, delay));
                continue;
            }
            throw error;
        }
    }
    throw new Error('callGeminiText failed after max retries');
}

async function callGeminiJSON(prompt: string, apiKey: string): Promise<{ parsed: any; tokens: number }> {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.2, maxOutputTokens: 65536, responseMimeType: 'application/json' }
                    })
                }
            );

            const data = await response.json();

            if (!response.ok) {
                if (response.status === 429 || response.status >= 500) {
                    if (attempt < maxAttempts - 1) {
                        const delay = Math.min(Math.pow(2, attempt) * 2000, 30000);
                        console.warn(`[Gemini JSON] ${response.status} Error. Retrying in ${delay / 1000}s...`);
                        await new Promise(res => setTimeout(res, delay));
                        continue;
                    }
                }
                throw new Error(`Gemini JSON: ${data.error?.message || response.status}`);
            }

            const parts = data.candidates?.[0]?.content?.parts || [];
            const content = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
            if (!content) throw new Error('Gemini JSON empty response');

            const parsed = repairTruncatedJSON(content);
            if (!parsed) throw new Error(`Bad JSON from Gemini: ${content.substring(0, 200)}`);

            const tokens = data.usageMetadata?.totalTokenCount || 0;
            return { parsed, tokens };
        } catch (error: any) {
            if (attempt < maxAttempts - 1 && (
                error.message.includes('fetch') ||
                error.message.includes('network') ||
                error.message.includes('429') ||
                error.message.includes('503')
            )) {
                const delay = Math.min(Math.pow(2, attempt) * 2000, 20000);
                console.warn(`[Gemini JSON] Retry ${attempt + 1}: ${(delay / 1000).toFixed(1)}s...`);
                await new Promise(res => setTimeout(res, delay));
                continue;
            }
            throw error;
        }
    }
    throw new Error('callGeminiJSON failed after max retries');
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

function mergeAndDedupLessons(batchResults: any[]): any[] {
    const mergedMap = new Map<string, any>();

    for (const batch of batchResults) {
        if (!batch || typeof batch !== 'object') continue;
        const lessons = Array.isArray(batch.lessons) ? batch.lessons : (Array.isArray(batch) ? batch : []);

        for (const lesson of lessons) {
            if (!lesson || !lesson.lesson_title) continue;
            const key = lesson.lesson_title.trim();

            if (!mergedMap.has(key)) {
                mergedMap.set(key, {
                    lesson_title: key,
                    detailed_explanation: lesson.detailed_explanation || '',
                    rules: [...(lesson.rules || [])],
                    examples: [...(lesson.examples || [])]
                });
            } else {
                const existing = mergedMap.get(key)!;
                // Append content if longer
                if ((lesson.detailed_explanation || '').length > existing.detailed_explanation.length) {
                    existing.detailed_explanation = lesson.detailed_explanation;
                }
                // Merge rules (dedup)
                for (const r of (lesson.rules || [])) {
                    if (!existing.rules.includes(r)) existing.rules.push(r);
                }
                // Merge examples (dedup by word)
                const existingWords = new Set(existing.examples.map((e: any) => e.word));
                for (const ex of (lesson.examples || [])) {
                    if (ex.word && !existingWords.has(ex.word)) {
                        existing.examples.push(ex);
                        existingWords.add(ex.word);
                    }
                }
            }
        }
    }

    return Array.from(mergedMap.values());
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

function buildSummaryPrompt(content: string, batchNum: number, totalBatches: number, hasAudio: boolean, isRetry: boolean = false): string {
    const batchInfo = totalBatches > 1 ? ` (الجزء ${batchNum} من ${totalBatches})` : '';
    const audioNote = hasAudio ? '\n- **الأجزاء المميزة بـ ⭐ ركّز عليها المعلم في شرحه الصوتي** — أعطها اهتماماً إضافياً في الشرح وأضف ملاحظة عنها.' : '';
    const retryWarning = isRetry ? '\n\n🚨🚨🚨 تحذير: الإجابة السابقة كانت مختصرة جداً! يجب أن يكون detailed_explanation لكل درس 2000+ كلمة على الأقل. الاختصار = فشل.\n' : '';

    return `أنت خبير أكاديمي متخصص. مهمتك استخراج كل الدروس والقواعد من هذا الجزء${batchInfo} وتحويلها إلى JSON مهيكل.${retryWarning}

⚠️⚠️⚠️ قواعد صارمة (عدم الالتزام = فشل كامل):

1. **استخرج كل درس/قاعدة/مفهوم** بدون استثناء — لا تتجاهل أي شيء.
2. **العمق الشديد في detailed_explanation**:
   - كل درس يجب أن يحتوي على شرح مفصل جداً (2000+ كلمة) يشمل:
     * التعريف الكامل والدقيق
     * القاعدة الأساسية والقواعد الفرعية
     * جميع الشروط والاستثناءات والحالات الشاذة
     * أمثلة تطبيقية مع شرح كل مثال
     * ملاحظات وتنبيهات هامة
   - استخدم Markdown (عناوين ### ونقاط - وترقيم 1. وجداول | وتمييز **نص**)
   - الشرح السطحي = فشل تام. اكتب كأنك تشرح للطالب بدون الكتاب.
   - **كل المعلومات يجب أن تكون من النص المعطى فقط — لا تختلق معلومات غير موجودة في الكتاب.**
3. **rules[]** — كل قاعدة فرعية في سطر مستقل، مختصرة وواضحة.
4. **examples[]** — كل مثال بـ word + reason. **استخرج الأمثلة من الكتاب نفسه.**
5. **لا تدمج دروساً مستقلة** — كل درس في object منفصل.
6. **حافظ على ترتيب الكتاب الأصلي**.${audioNote}

المخرج المطلوب (JSON فقط):
{
  "module_title": "عنوان الفصل أو الباب",
  "lessons": [
    {
      "lesson_title": "عنوان الدرس",
      "detailed_explanation": "شرح تفصيلي جداً بصيغة Markdown — 2000+ كلمة — يغطي كل التعريفات والقواعد والشروط والاستثناءات والأمثلة والملاحظات — من محتوى الكتاب فقط",
      "rules": ["القاعدة 1", "القاعدة 2"],
      "examples": [{"word": "كلمة", "reason": "السبب"}]
    }
  ]
}

--- محتوى الجزء${batchInfo} ---

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
        // Our spawnNextAtomicJob sets stage='queued' — treat it as the initial stage
        if (stage === 'queued') stage = 'collecting_sections';
        progress = progress || 0;
        attempt_count = attempt_count || 0;
        extraction_cursor = extraction_cursor || 0;
        // ensure payload is object
        if (!payload || typeof payload !== 'object') payload = {};

        console.log(`[Analyze DBG] Job ${jobId} | Stage: ${stage} | Progress: ${progress}%`);

        // Self-healing timeout guard: Supabase Free tier = 400s max.
        // At 350s, save current progress and return cleanly so the job
        // can be re-picked up by the orchestrator for the next stage.
        const edgeFunctionStartTime = Date.now();
        const EDGE_TIMEOUT_MS = 350_000; // 350s safety margin
        const isNearTimeout = () => (Date.now() - edgeFunctionStartTime) > EDGE_TIMEOUT_MS;

        const advanceStage = async (newStage: string, newProgress: number, extraUpdates: any = {}) => {
            // Set to 'pending' + unlock so the orchestrator can re-invoke for the next stage.
            // The orchestrator only claims 'pending' jobs, so this is the handoff signal.
            const { error } = await supabase.from('processing_queue')
                .update({
                    stage: newStage,
                    progress: newProgress,
                    updated_at: new Date().toISOString(),
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
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
            // Only mark lesson as 'completed' for the FINAL aggregation job.
            // Individual analyze_lecture jobs should NOT flip the lesson to completed
            // because other lectures may still be pending.
            if (job.job_type === 'generate_analysis' || job.job_type === 'generate_book_overview') {
                await supabase.from('lessons').update({ analysis_status: 'completed' }).eq('id', lessonId);
            }
            return jsonResponse({ success: true, stage: 'completed', progress: 100, status: 'completed' });
        };

        // Heartbeat: touch updated_at immediately so orphan recovery knows we're alive.
        // Without this, long Gemini API calls (30-120s) look like orphaned jobs.
        await supabase.from('processing_queue')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', jobId);

        try {
            // ==========================================
            // ATOMIC JOB: generate_book_overview / generate_analysis
            // ==========================================
            if (job.job_type === 'generate_book_overview' || job.job_type === 'generate_analysis') {
                await supabase.from('lessons').update({ analysis_status: 'processing' }).eq('id', lessonId);

                const { data: allSegments } = await supabase.from('lecture_segments')
                    .select('id, title, page_from').eq('lesson_id', lessonId).order('page_from');
                const segIds = allSegments?.map((s: any) => s.id) || [];

                const { data: analyses } = await supabase.from('lecture_analysis')
                    .select('lecture_id, summary, quiz, key_points').in('lecture_id', segIds);

                let allLessons: any[] = [];
                let allQuizzes: any[] = [];
                let allFocusPoints: any[] = [];
                let allEssayQuestions: any[] = [];
                let concatenatedSummary = '';
                let indexMap: any = { topics: [] };

                for (const seg of (allSegments || [])) {
                    const an = analyses?.find((a: any) => a.lecture_id === seg.id);
                    if (!an) continue;
                    indexMap.topics.push({ title: seg.title, page: seg.page_from });

                    let lectureResult: any = null;
                    try {
                        lectureResult = typeof an.summary === 'string' ? JSON.parse(an.summary) : an.summary;
                    } catch (e) {
                        concatenatedSummary += `\n\n## درس: ${seg.title} (ص ${seg.page_from})\n` + (an.summary || '').substring(0, 3000);
                        continue;
                    }

                    if (lectureResult) {
                        if (Array.isArray(lectureResult.lessons)) allLessons.push(...lectureResult.lessons);
                        if (Array.isArray(lectureResult.quizzes)) allQuizzes.push(...lectureResult.quizzes);
                        if (Array.isArray(lectureResult.focusPoints)) allFocusPoints.push(...lectureResult.focusPoints);
                        if (Array.isArray(lectureResult.essayQuestions)) allEssayQuestions.push(...lectureResult.essayQuestions);
                        if (lectureResult.summary) concatenatedSummary += `\n\n## درس: ${seg.title} (ص ${seg.page_from})\n` + lectureResult.summary.substring(0, 3000);
                    }
                }

                console.log(`[Generate Analysis] Aggregated: ${allLessons.length} lessons, ${allQuizzes.length} quizzes, ${allFocusPoints.length} focus, ${allEssayQuestions.length} essay`);

                let finalSummary = 'تعذر توليد الملخص';
                if (concatenatedSummary.trim()) {
                    const prompt = `أنت خبير أكاديمي. بناءً على هذه الملخصات للدروس (والتي تمثل كتاباً كاملاً)، اكتب "نظرة عامة" شاملة للكتاب ككل في 3-5 فقرات.
المحتوى:
${concatenatedSummary.substring(0, 80000)}`;
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

                // CRITICAL: Save COMPLETE analysis_result with ALL aggregated data
                const analysisResult = {
                    summary: finalSummary,
                    lessons: allLessons,
                    focusPoints: allFocusPoints,
                    quizzes: allQuizzes,
                    essayQuestions: allEssayQuestions,
                    indexMap: indexMap,
                    metadata: {
                        generatedAt: new Date().toISOString(),
                        schemaVersion: 11,
                        lecturesAnalyzed: allSegments?.length || 0,
                        model: 'gemini-2.5-flash'
                    }
                };
                await supabase.from('lessons').update({
                    analysis_status: 'completed',
                    analysis_result: analysisResult
                }).eq('id', lessonId);

                // 🧹 AUTO-CLEANUP: Delete source files from Storage to save space now that analysis is done!
                const { data: sourceFiles } = await supabase
                    .from('document_sections')
                    .select('source_file_id')
                    .eq('lesson_id', lessonId)
                    .not('source_file_id', 'is', null);

                if (sourceFiles && sourceFiles.length > 0) {
                    const uniquePaths = [...new Set(sourceFiles.map((f: any) => f.source_file_id))];
                    if (uniquePaths.length > 0) {
                        const { error: storageErr } = await supabase.storage
                            .from('homework-uploads')
                            .remove(uniquePaths);

                        if (storageErr) console.warn('[Cleanup] Failed to delete source files from storage:', storageErr.message);
                        else console.log(`[Cleanup] Deleted ${uniquePaths.length} source files from storage to save space.`);
                    }
                }

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
                const batches = splitIntoBatches(cleanParagraphs, 40000, 3);

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

                // Self-healing: if near timeout, save progress and return
                if (isNearTimeout()) {
                    console.warn(`[Analyze] ⏰ Near Edge timeout. Saving progress at batch ${batchIndex}/${batches.length} and returning.`);
                    return await advanceStage('summarizing_batch_i', progress, { payload, extraction_cursor: batchIndex });
                }

                const content = batches[batchIndex];
                const contentChars = content.length;
                // For JSON output, check lesson count instead of character length
                const minExpectedLessons = 1;

                console.log(`[Analyze] Summarizing batch ${batchIndex + 1}/${batches.length} (${contentChars} chars) via JSON...`);

                let bestResult: { parsed: any; tokens: number } = { parsed: null, tokens: 0 };
                for (let attempt = 0; attempt < 2; attempt++) {
                    const isRetry = attempt > 0;
                    const prompt = buildSummaryPrompt(content, batchIndex + 1, batches.length, payload.hasAudio, isRetry);
                    try {
                        const result = await callGeminiJSON(prompt, geminiKey);
                        bestResult = result;

                        const lessons = result.parsed?.lessons || [];
                        if (lessons.length >= minExpectedLessons) {
                            const totalExplanation = lessons.reduce((s: number, l: any) => s + (l.detailed_explanation?.length || 0), 0);
                            console.log(`[Analyze] ✅ Batch ${batchIndex + 1}: ${lessons.length} lessons, ${totalExplanation} explanation chars`);
                            break;
                        }

                        if (attempt === 0) {
                            console.warn(`[Analyze] ⚠️ Batch ${batchIndex + 1}: too few lessons (${lessons.length}). Retrying...`);
                        }
                    } catch (jsonErr: any) {
                        console.warn(`[Analyze] ⚠️ Batch ${batchIndex + 1} JSON failed: ${jsonErr.message}. Falling back to text...`);
                        // Fallback: use callGeminiText and wrap in a simple lesson object
                        const textResult = await callGeminiText(prompt, geminiKey);
                        bestResult = {
                            parsed: {
                                module_title: `الجزء ${batchIndex + 1}`,
                                lessons: [{
                                    lesson_title: `محتوى الجزء ${batchIndex + 1}`,
                                    detailed_explanation: textResult.text,
                                    rules: [],
                                    examples: []
                                }]
                            },
                            tokens: textResult.tokens
                        };
                        break;
                    }
                }

                if (!payload.summaryParts) payload.summaryParts = [];
                payload.summaryParts[batchIndex] = bestResult.parsed;
                payload.totalTokens = (payload.totalTokens || 0) + bestResult.tokens;

                const nextCursor = batchIndex + 1;
                const nextStage = nextCursor >= batches.length ? 'merging_summaries' : 'summarizing_batch_i';
                const prog = 15 + Math.floor((nextCursor / batches.length) * 35); // 15 to 50%

                return await advanceStage(nextStage, prog, { payload, extraction_cursor: nextCursor });
            }

            // ==========================================
            // STAGE 3: merging_summaries
            // ==========================================
            if (stage === 'merging_summaries') {
                console.log(`[Analyze] Merging lesson data...`);
                const validParts = (payload.summaryParts || []).filter((p: any) => p && typeof p === 'object');
                const mergedLessons = mergeAndDedupLessons(validParts);

                console.log(`[Analyze] Merged into ${mergedLessons.length} unique lessons.`);

                // Build markdown summary from lessons (backwards compat for quiz generation)
                let markdownSummary = mergedLessons.map((lesson: any) => {
                    let md = `## ${lesson.lesson_title}\n\n${lesson.detailed_explanation || ''}`;
                    if (lesson.rules && lesson.rules.length > 0) {
                        md += '\n\n### القواعد:\n' + lesson.rules.map((r: string) => `- ${r}`).join('\n');
                    }
                    return md;
                }).join('\n\n---\n\n');

                // Enforce max limit
                const MAX_SUMMARY_CHARS = 100000;
                if (markdownSummary.length > MAX_SUMMARY_CHARS) {
                    markdownSummary = markdownSummary.substring(0, MAX_SUMMARY_CHARS) + '\n\n---\n⚠️ تم اقتطاع الملخص';
                }

                payload.summary = markdownSummary;
                payload.lessons = mergedLessons;

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
                    lessons: payload.lessons || [],
                    focusPoints: quizParsed.focusPoints || [],
                    quizzes: quizParsed.quizzes || [],
                    essayQuestions: quizParsed.essayQuestions || [],
                    metadata: {
                        model: 'gemini-2.5-flash-step',
                        totalTokens: payload.totalTokens || 0,
                        lecturesDetected: payload.lectureCount || 0,
                        generatedAt: new Date().toISOString(),
                        schemaVersion: 11
                    }
                };

                if (job.job_type === 'analyze_lecture' && payload.lecture_id) {
                    const { error: saveErr } = await supabase.from('lecture_analysis').upsert({
                        lecture_id: payload.lecture_id,
                        summary: JSON.stringify(analysisResult),
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
                        console.log(`[Analyze] All ${segmentsCount} lectures analyzed! Spawning final generate_analysis...`);
                        await supabase.from('processing_queue').insert({
                            lesson_id: lessonId,
                            job_type: 'generate_analysis',
                            payload: {},
                            status: 'pending',
                            dedupe_key: `lesson:${lessonId}:generate_analysis`
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
            if (attempt_count >= 5) {
                return await setFail(e.message);
            } else {
                // Proper error recovery: unlock the job, set to pending with exponential backoff
                // This matches the pattern in ingest-file/index.ts (lines 1005-1021)
                const baseDelay = Math.pow(2, attempt_count) * 2000;
                const delayMs = Math.min(baseDelay, 45000);
                const nextRetry = new Date(Date.now() + delayMs).toISOString();

                await supabase.from('processing_queue').update({
                    attempt_count: attempt_count + 1,
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
                    next_retry_at: nextRetry,
                    error_message: e.message
                }).eq('id', jobId);

                return jsonResponse({ success: false, stage, status: 'pending', error: e.message, attempt: attempt_count + 1 });
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
