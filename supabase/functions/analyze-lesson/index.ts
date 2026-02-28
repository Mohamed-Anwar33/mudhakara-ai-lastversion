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

// Split into Map-Reduce batches safely
function splitIntoBatches(textChunks: string[], batchSizeChars = 30000): string[] {
    const batches: string[] = [];
    let currentBatch = "";

    for (const chunk of textChunks) {
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
                const { data: pages } = await supabase.from('lesson_pages')
                    .select('page_number, storage_path')
                    .eq('lesson_id', lesson_id)
                    .gte('page_number', start_page)
                    .lte('page_number', end_page);

                let rawTextChunks: string[] = [];
                for (const p of (pages || [])) {
                    if (!p.storage_path) continue;

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
                        rawTextChunks.push(prefix + await textData.text());
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

                const batches = splitIntoBatches(rawTextChunks, 35000);
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

                const prompt = `أنت أستاذ جامعي ومحلل أكاديمي خبير. لديك الان جزء من كتاب دراسي (محاضرة).
                 ملاحظة هامة جداً: النصوص المظللة بعلامة [🎤 ما ذكره المعلم في التسجيل] تمثل مقاطع ذكرها المعلم وركّز عليها في تسجيله الصوتي.
                 ${focusPromptInjection}
                 
                 المطلوب منك كتابة شرح تفصيلي وعميق جداً لهذا الجزء، مع دمج معلومات الكتاب مع ما ذكره المعلم.
                 
                 قواعد صارمة جداً (سيتم رفض إجابتك إن لم تتبعها):
                 1. *الطول*: يجب ألا يقل الشرح (explanation_notes) بأي حال من الأحوال عن 3000 حرف. اشرح كل مفهوم، كل معادلة، كل تعريف بالتفصيل الممل كما لو كنت تشرح لطالب مبتدئ. استخدم الأمثلة.
                 2. *تمييز ما ذكره المعلم*: كلما ذكرت نقطة ركّز عليها المعلم في التسجيل، يجب أن تضعها داخل blockquote ماركداون بهذا الشكل:
                    > 🎤 **ما ذكره المعلم:** النقطة التي ركّز عليها المعلم هنا مع الشرح
                    هذا سيميزها بصرياً عن باقي النص بخلفية صفراء.
                 3. *إخراج الكتروني*: يجب أن يكون الشرح بصيغة Markdown منسقة (عناوين، قوائم، نصوص غامقة).

                 يجب أن يكون المخرج النهائي بصيغة JSON فقط، بالضبط هكذا:
                 {
                   "explanation_notes": "الشرح التفصيلي العميق جداً هنا بصيغة ماركداون (لا يقل أبداً عن 3000 حرف)...",
                   "key_definitions": ["تعريف 1 تفصيلي", "تعريف 2 تفصيلي", "..."],
                   "focusPoints": [
                      {"title": "عنوان لنقطة التركيز 1", "details": "شرح مفصل لهذه النقطة التي ذكرها المعلم"},
                      {"title": "عنوان لنقطة التركيز 2", "details": "شرح مفصل للنقطة الثانية"}
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

                // Advance cursor and unlock
                await supabase.from('processing_queue')
                    .update({
                        stage: 'summarizing_batches',
                        payload,
                        extraction_cursor: cursor + 1,
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
