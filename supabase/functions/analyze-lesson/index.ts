import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function callGeminiJSON(prompt: string, apiKey: string): Promise<any> {
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
    if (!response.ok) throw new Error(`Gemini JSON: ${data.error?.message || response.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
}

// ─── Data Sanitization ────────────────────────────────────
// Filters out garbage OCR text BEFORE it reaches the AI model.
// This is the primary defense against hallucination from bad input.
const GARBAGE_PATTERNS = [
    /no extraction possible/i,
    /extraction failed/i,
    /unable to extract/i,
    /error reading/i,
    /could not process/i,
    /failed to parse/i,
    /سؤال وهمي/,
    /^\s*\[?page\s*\d+\]?\s*$/i,
];

function sanitizeOcrText(text: string): string | null {
    if (!text || typeof text !== 'string') return null;

    const trimmed = text.trim();

    // Too short = no useful content
    if (trimmed.length < 50) {
        console.log(`[sanitize] Skipping chunk: too short (${trimmed.length} chars)`);
        return null;
    }

    // Check for garbage patterns
    for (const pattern of GARBAGE_PATTERNS) {
        if (pattern.test(trimmed)) {
            console.log(`[sanitize] Skipping chunk: matches garbage pattern ${pattern}`);
            return null;
        }
    }

    // Count meaningful words (not just symbols/numbers)
    const words = trimmed.split(/\s+/).filter(w => w.length > 1);
    if (words.length < 15) {
        console.log(`[sanitize] Skipping chunk: too few words (${words.length})`);
        return null;
    }

    return trimmed;
}

// Split into Map-Reduce batches safely (with deduplication)
function splitIntoBatches(textChunks: string[], batchSizeChars = 30000): string[] {
    const batches: string[] = [];
    let currentBatch = "";
    const seenFingerprints = new Set<string>();

    for (const chunk of textChunks) {
        // Deduplication: skip chunks we've already seen
        const fingerprint = chunk.trim().substring(0, 100).replace(/\s+/g, ' ');
        if (seenFingerprints.has(fingerprint)) {
            console.log(`[splitIntoBatches] Skipping duplicate chunk: "${fingerprint.substring(0, 50)}..."`);
            continue;
        }
        seenFingerprints.add(fingerprint);

        if (currentBatch.length + chunk.length > batchSizeChars && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = chunk;
        } else {
            currentBatch += "\n" + chunk;
        }
    }
    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    let jobId: string | undefined;
    try {
        const body = await req.json();
        jobId = body.jobId;
        if (!jobId) throw new Error('Missing jobId');

        const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';

        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: job, error: jobError } = await supabase
            .from('processing_queue')
            .select('*')
            .eq('id', jobId)
            .single();

        if (jobError || !job) throw new Error('Job not found');

        const { job_type, payload, lesson_id } = job;

        // Use stage-based progression for Map-Reduce logic
        const stage = job.stage || 'collecting_sections';

        console.log(`[analyze-lesson] Executing ${job_type} | Stage: ${stage} for lesson ${lesson_id}`);

        if (job_type === 'analyze_lecture') {
            const lecture_id = payload.lecture_id;
            const start_page = payload.start_page;
            const end_page = payload.end_page;

            // ==========================================
            // STAGE 1: collecting_sections
            // ==========================================
            if (stage === 'collecting_sections' || stage === 'pending_upload' || stage === 'queued') {

                // 1. Fetch ALL text for these pages from Storage
                //    CRITICAL FIX: Track already-read storage paths to prevent
                //    duplicate reads (multiple pages share the same batch file)
                const { data: pages } = await supabase.from('lesson_pages')
                    .select('page_number, storage_path')
                    .eq('lesson_id', lesson_id)
                    .gte('page_number', start_page)
                    .lte('page_number', end_page);

                let rawTextChunks: string[] = [];
                const alreadyReadPaths = new Set<string>(); // Prevents reading same batch file multiple times

                for (const p of (pages || [])) {
                    if (!p.storage_path) continue;

                    // DEDUP: Skip if we already read this storage path
                    // (OCR batches cover 5 pages but share 1 storage_path)
                    if (alreadyReadPaths.has(p.storage_path)) {
                        console.log(`[analyze-lesson] Skipping duplicate storage path: ${p.storage_path}`);
                        continue;
                    }
                    alreadyReadPaths.add(p.storage_path);

                    // Look for Focus points matching this page in the DB
                    const { data: focusPoints } = await supabase.from('document_embeddings')
                        .select('is_focus_point, storage_path')
                        .eq('lesson_id', lesson_id)
                        .eq('page_number', p.page_number)
                        .eq('is_focus_point', true);

                    let prefix = "\n\n";
                    if (focusPoints && focusPoints.length > 0) {
                        prefix = "\n\n[🎤 ما ذكره المعلم في التسجيل]\n";
                    }

                    const { data: textData } = await supabase.storage.from('ocr').download(p.storage_path);
                    if (textData) {
                        const rawText = await textData.text();
                        // SANITIZATION: Filter garbage before it reaches the AI
                        const cleanText = sanitizeOcrText(rawText);
                        if (cleanText) {
                            rawTextChunks.push(prefix + cleanText);
                        } else {
                            console.warn(`[analyze-lesson] Filtered out garbage OCR for path ${p.storage_path}`);
                        }
                    }
                }

                // --- NEW LOGIC: Intelligent LLM Audio Matcher ---
                let audioContext = "";
                try {
                    const audioPath = `audio_transcripts/${lesson_id}/raw_transcript.txt`;
                    const { data: audioBlob } = await supabase.storage.from('audio_transcripts').download(audioPath);
                    if (audioBlob) {
                        audioContext = await audioBlob.text();
                        console.log(`[analyze-lesson] Found Audio Transcript (${audioContext.length} chars). Injecting for Semantic Focus Matching.`);
                    }
                } catch (e) {
                    // It's perfectly fine if there is no audio file uploaded for this lesson.
                    console.log(`[analyze-lesson] No Audio Transcript found for lesson ${lesson_id}. Proceeding as Text-Only.`);
                }
                payload.audio_context = audioContext; // Save into payload to pass it to the Map stage
                // ------------------------------------------------

                if (rawTextChunks.length === 0) {
                    // Empty section, skip
                    await supabase.from('segmented_lectures').update({ status: 'quiz_done' }).eq('id', payload.lecture_id);
                    await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);

                    // We also need to check if this was the last lecture holding up the global aggregator!
                    const { count: totalSegments } = await supabase.from('segmented_lectures').select('*', { count: 'exact', head: true }).eq('lesson_id', lesson_id);
                    const { count: finishedSegments } = await supabase.from('segmented_lectures').select('*', { count: 'exact', head: true }).eq('lesson_id', lesson_id).eq('status', 'quiz_done');

                    if (totalSegments && finishedSegments && totalSegments === finishedSegments) {
                        console.log(`[analyze-lesson] All quizzes done for lesson ${lesson_id} (Skipped Empty)!`);
                    }

                    return new Response(JSON.stringify({ status: 'skipped_empty' }), { headers: corsHeaders });
                }

                const batches = splitIntoBatches(rawTextChunks, 60000);
                payload.batches = batches;
                payload.summaries = [];

                // Only advance stage, keep lock open if we process immediately, 
                // but orchestrator needs to free it, let's just queue the next stage atomic.
                await supabase.from('processing_queue')
                    .update({
                        stage: 'summarizing_batches',
                        payload,
                        extraction_cursor: 0,
                        status: 'pending', locked_by: null, locked_at: null // unlock for next cycle
                    })
                    .eq('id', jobId);

                return new Response(JSON.stringify({ status: 'advancing', next_stage: 'summarizing_batches' }), { headers: corsHeaders });
            }


            // ==========================================
            // STAGE 2: summarizing_batches (Map)
            // ==========================================
            if (stage === 'summarizing_batches') {
                const batches = payload.batches || [];
                const cursor = job.extraction_cursor || 0;

                if (cursor >= batches.length) {
                    // Move to merging stage
                    await supabase.from('processing_queue')
                        .update({ stage: 'merging_summaries', status: 'pending', locked_by: null, locked_at: null })
                        .eq('id', jobId);
                    return new Response(JSON.stringify({ status: 'advancing', next_stage: 'merging_summaries' }), { headers: corsHeaders });
                }

                const content = batches[cursor];
                const audioContext = payload.audio_context || "";

                let focusPromptInjection = "";
                if (audioContext.length > 50) {
                    focusPromptInjection = `\n--- الشرح الصوتي للمعلم (Transcript) ---\n${audioContext}\n
                    عليك كأستاذ تحليل هذا النص الصوتي. كلما رأيت أن المعلم ركز على نقطة معينة في صوته وموجودة أيضاً في "نص المحاضرة" (الكتاب)،
                    قم باستخراج هذه النقطة بدقة وضعها داخل المصفوفة \`focusPoints\`. اشرح في \`details\` لماذا ركز عليها المعلم وكيف ترتبط بالكتاب.`;
                }

                const prompt = `[تعليمات النظام — ممنوع تجاوزها]
أنت أستاذ جامعي متخصص في تحليل الكتب الدراسية الجامعية العربية.
أنت الآن تحلل جزءاً من كتاب دراسي أكاديمي.

⛔ حدود صارمة مطلقة (انتهاكها = رفض فوري):
1. استخدم المحتوى المقدم لك فقط. لا تؤلف، لا تخترع، لا تضف أي معلومة غير موجودة حرفياً في النص.
2. إذا كان النص المقدم فارغاً أو غير مفهوم أو لا يحتوي على محتوى أكاديمي حقيقي، أرجع JSON فارغ هكذا بالضبط:
   {"explanation_notes": "", "key_definitions": [], "focusPoints": []}
3. ممنوع منعاً باتاً الحديث عن مواضيع غير موجودة في النص (مثل: علم البيئة، الاحتباس الحراري، التنوع البيولوجي، الفيزياء، أو أي موضوع خارجي).
4. ممنوع كتابة "سؤال وهمي" أو أي عبارة تشير لعدم وجود محتوى.
5. إذا رأيت عبارات مثل "No extraction possible" أو "Error" أو رسائل نظام، تجاهلها تماماً ولا تذكرها.
6. لا تكرر نفس المحتوى أكثر من مرة.

ملاحظة: النصوص المظللة بعلامة [🎤 ما ذكره المعلم في التسجيل] تمثل مقاطع ركّز عليها المعلم في تسجيله الصوتي.
${focusPromptInjection}

المطلوب: شرح تفصيلي وعميق جداً لهذا الجزء بصيغة Markdown، مع دمج الكتاب وشرح المعلم.

قواعد الجودة:
1. الطول: يجب ألا يقل الشرح (explanation_notes) عن 3000 حرف. اشرح كل مفهوم وكل تعريف بالتفصيل.
2. تمييز ما ذكره المعلم: ضعه داخل blockquote:
   > 🎤 **ما ذكره المعلم:** النقطة هنا
3. إخراج بصيغة Markdown منسقة (عناوين، قوائم، نصوص غامقة).

المخرج: JSON فقط بالضبط هكذا:
{
  "explanation_notes": "الشرح التفصيلي العميق هنا بصيغة ماركداون (لا يقل عن 3000 حرف)...",
  "key_definitions": ["تعريف 1", "تعريف 2"],
  "focusPoints": [
     {"title": "عنوان نقطة التركيز", "details": "شرح مفصل"}
  ]
}

--- نص المحاضرة ---
${content}`;

                console.log(`[analyze-lesson] Map Phase: Processing batch ${cursor + 1}/${batches.length}...`);

                let jsonResult: any = { explanation_notes: '', key_definitions: [] };
                try {
                    jsonResult = await callGeminiJSON(prompt, geminiKey);
                } catch (e: any) {
                    console.warn(`[analyze-lesson] JSON parsing failed: ${e.message}`);
                    // Continue even if fail (resilience)
                }

                if (!payload.summaries) payload.summaries = [];
                payload.summaries.push(jsonResult);

                const nextCursor = cursor + 1;

                // SPEED OPTIMIZATION: Process up to 3 batches per invocation
                // Supabase Edge Functions have 150s timeout — plenty for multiple Gemini calls
                if (nextCursor < batches.length && (nextCursor - (job.extraction_cursor || 0)) < 3) {
                    // Process next batch immediately in same invocation
                    const nextContent = batches[nextCursor];
                    const nextPrompt = prompt.replace(content, nextContent);
                    console.log(`[analyze-lesson] Map Phase: Processing batch ${nextCursor + 1}/${batches.length} (same invocation)...`);
                    let nextResult: any = { explanation_notes: '', key_definitions: [] };
                    try {
                        nextResult = await callGeminiJSON(nextPrompt, geminiKey);
                    } catch (e: any) {
                        console.warn(`[analyze-lesson] Batch ${nextCursor + 1} JSON parsing failed: ${e.message}`);
                    }
                    payload.summaries.push(nextResult);

                    const thirdCursor = nextCursor + 1;
                    if (thirdCursor < batches.length && (thirdCursor - (job.extraction_cursor || 0)) < 3) {
                        const thirdContent = batches[thirdCursor];
                        const thirdPrompt = prompt.replace(content, thirdContent);
                        console.log(`[analyze-lesson] Map Phase: Processing batch ${thirdCursor + 1}/${batches.length} (same invocation)...`);
                        let thirdResult: any = { explanation_notes: '', key_definitions: [] };
                        try {
                            thirdResult = await callGeminiJSON(thirdPrompt, geminiKey);
                        } catch (e: any) {
                            console.warn(`[analyze-lesson] Batch ${thirdCursor + 1} JSON parsing failed: ${e.message}`);
                        }
                        payload.summaries.push(thirdResult);

                        // Advance cursor by 3
                        await supabase.from('processing_queue')
                            .update({
                                stage: 'summarizing_batches',
                                payload,
                                extraction_cursor: thirdCursor + 1,
                                status: 'pending', locked_by: null, locked_at: null
                            })
                            .eq('id', jobId);
                        return new Response(JSON.stringify({ status: 'advancing_batch', cursor: thirdCursor + 1 }), { headers: corsHeaders });
                    }

                    // Advance cursor by 2
                    await supabase.from('processing_queue')
                        .update({
                            stage: 'summarizing_batches',
                            payload,
                            extraction_cursor: nextCursor + 1,
                            status: 'pending', locked_by: null, locked_at: null
                        })
                        .eq('id', jobId);
                    return new Response(JSON.stringify({ status: 'advancing_batch', cursor: nextCursor + 1 }), { headers: corsHeaders });
                }

                // Advance cursor by 1 (last batch or single)
                await supabase.from('processing_queue')
                    .update({
                        stage: 'summarizing_batches',
                        payload,
                        extraction_cursor: nextCursor,
                        status: 'pending', locked_by: null, locked_at: null
                    })
                    .eq('id', jobId);

                return new Response(JSON.stringify({ status: 'advancing_batch', cursor: cursor + 1 }), { headers: corsHeaders });
            }

            // ==========================================
            // STAGE 3: merging_summaries (Reduce + Save)
            // ==========================================
            if (stage === 'merging_summaries') {
                const summaries = payload.summaries || [];

                let totalExplanation = '';
                const allDefinitions: string[] = [];

                for (const s of summaries) {
                    if (s.explanation_notes) totalExplanation += s.explanation_notes + '\n\n';
                    if (s.key_definitions) allDefinitions.push(...s.key_definitions);
                }

                // If content is too short, skip quiz generation entirely to avoid garbage questions
                if (totalExplanation.length < 500) {
                    console.warn(`[analyze-lesson] Lecture ${lecture_id} has insufficient content (${totalExplanation.length} chars). Skipping quiz generation.`);
                    await supabase.from('segmented_lectures')
                        .update({ status: 'quiz_done', char_count: totalExplanation.length })
                        .eq('id', lecture_id);
                    await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
                    return new Response(JSON.stringify({ status: 'skipped_insufficient_content' }), { headers: corsHeaders });
                }

                const finalJsonStruct = {
                    title: payload.title,
                    explanation_notes: totalExplanation,
                    key_definitions: allDefinitions,
                    metadata: { generated_at: new Date().toISOString() }
                };

                // CRITICAL: Prevent DB blowout, SAVE TO STORAGE!
                const storagePath = `${lesson_id}/lecture_${lecture_id}.json`;

                const { error: storageErr } = await supabase.storage.from('analysis')
                    .upload(storagePath, JSON.stringify(finalJsonStruct, null, 2), { upsert: true, contentType: 'application/json' });

                if (storageErr) throw new Error(`Analysis upload failed: ${storageErr.message}`);

                // Update Segment Lecture row pointer AND Character Count
                await supabase.from('segmented_lectures')
                    .update({
                        summary_storage_path: storagePath,
                        char_count: totalExplanation.length,
                        status: 'summary_done'
                    })
                    .eq('id', lecture_id);

                // Start the Quiz Generator for this completed lecture
                await supabase.from('processing_queue').insert({
                    lesson_id: lesson_id,
                    job_type: 'generate_quiz',
                    payload: { lecture_id, summary_storage_path: storagePath },
                    status: 'pending',
                    dedupe_key: `lesson:${lesson_id}:generate_quiz:${lecture_id}`
                });

                // Completed this analyze_lecture branch!
                await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'completed' }), { headers: corsHeaders });
            }
        }

        throw new Error(`Unhandled analyze job type or stage: ${job_type} / ${stage}`);

    } catch (error: any) {
        console.error('[analyze-lesson] Error:', error);
        if (req.method !== 'OPTIONS') {
            try {
                if (jobId) {
                    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
                    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    await supabase.from('processing_queue').update({
                        status: 'failed',
                        error_message: error.message || 'Unknown Analyze Lesson Error',
                        locked_by: null,
                        locked_at: null
                    }).eq('id', jobId);
                }
            } catch (_) { }
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
