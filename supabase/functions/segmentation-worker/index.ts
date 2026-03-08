import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Utility to call Gemini JSON (borrowed from existing architecture principles)
async function callGeminiJSON(prompt: string, apiKey: string): Promise<any> {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
            })
        }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini: ${data.error?.message || response.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Failed to parse Gemini JSON: ${text.substring(0, 100)}...`);
    }
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
        console.log(`[segmentation-worker] Executing ${job_type} for lesson ${lesson_id}`);

        if (job_type === 'segment_lesson') {

            // 1. SELF-HEALING: Reset any OCR jobs stuck in 'processing' for > 2 min
            //    These are orphans from Edge Functions that crashed after orchestrator disconnected.
            //    Instead of waiting 3+ min for orphan recovery in process-queue, we fix them HERE.
            //    After 5+ attempts, mark as permanently failed so the barrier can proceed.
            const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            const { data: stuckJobs } = await supabase.from('processing_queue')
                .select('id, attempt_count')
                .eq('lesson_id', lesson_id)
                .in('job_type', ['extract_pdf_info', 'ocr_page_batch'])
                .eq('status', 'processing')
                .lt('updated_at', stuckCutoff);

            if (stuckJobs && stuckJobs.length > 0) {
                console.warn(`[segmentation-worker] SELF-HEALING: Found ${stuckJobs.length} stuck OCR jobs.`);
                for (const stuck of stuckJobs) {
                    const attempts = Number(stuck.attempt_count || 0);
                    if (attempts >= 5) {
                        // Permanently failed — don't retry, let barrier proceed
                        await supabase.from('processing_queue').update({
                            status: 'failed',
                            error_message: `OCR permanently failed after ${attempts} attempts`,
                            locked_by: null, locked_at: null
                        }).eq('id', stuck.id);
                        console.warn(`[segmentation-worker] OCR job ${stuck.id} marked FAILED (${attempts} attempts).`);
                    } else {
                        await supabase.from('processing_queue').update({
                            status: 'pending',
                            locked_by: null, locked_at: null
                        }).eq('id', stuck.id);
                        console.log(`[segmentation-worker] Reset OCR job ${stuck.id} to pending (attempt ${attempts}).`);
                    }
                }
            }

            // 1b. SAFETY NET: Mark any OCR/extract job with 5+ attempts as failed
            //     even if it's currently 'pending' — prevents infinite retry loops
            const { data: exhaustedJobs } = await supabase.from('processing_queue')
                .select('id, attempt_count, job_type')
                .eq('lesson_id', lesson_id)
                .in('job_type', ['extract_pdf_info', 'ocr_page_batch'])
                .in('status', ['pending', 'processing'])
                .gte('attempt_count', 5);

            if (exhaustedJobs && exhaustedJobs.length > 0) {
                console.warn(`[segmentation-worker] ${exhaustedJobs.length} OCR jobs exhausted retries. Marking as failed.`);
                for (const ex of exhaustedJobs) {
                    await supabase.from('processing_queue').update({
                        status: 'failed',
                        error_message: `Exceeded max attempts (${ex.attempt_count})`,
                        locked_by: null, locked_at: null
                    }).eq('id', ex.id);
                }
            }

            // 2. Barrier Check: Are ALL OCR jobs finished? (completed or failed — either is "done")
            const { count: pendingOcrJobs } = await supabase.from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .in('job_type', ['extract_pdf_info', 'ocr_page_batch'])
                .in('status', ['pending', 'processing']);

            if (pendingOcrJobs && pendingOcrJobs > 0) {
                console.log(`[segmentation-worker] ${pendingOcrJobs} OCR jobs still running. Re-queuing with 15s backoff.`);
                const nextRetry = new Date(Date.now() + 15 * 1000).toISOString();
                await supabase.from('processing_queue').update({ status: 'pending', locked_by: null, locked_at: null, next_retry_at: nextRetry }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'staged', message: 'waiting_for_ocr' }), { headers: corsHeaders });
            }

            // 2. Check how many pages actually have content (success with storage_path)
            const { count: successPages } = await supabase.from('lesson_pages')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .eq('status', 'success')
                .not('storage_path', 'is', null);

            const { count: totalPages } = await supabase.from('lesson_pages')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id);

            console.log(`[segmentation-worker] OCR complete. ${successPages}/${totalPages} pages have content.`);

            // Check if this lesson has audio (by looking for transcribe_audio jobs in the queue)
            const { count: audioJobCount } = await supabase.from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .eq('job_type', 'transcribe_audio');
            const hasAudio = (audioJobCount || 0) > 0;

            // If NO pages have any content at all, and NO audio exists, then we truly failed
            if ((!successPages || successPages === 0) && !hasAudio) {
                console.error(`[segmentation-worker] Zero pages extracted and no audio. Cannot proceed.`);
                await supabase.from('processing_queue').update({
                    status: 'failed',
                    error_message: 'لم يتم استخراج أي نص من الكتاب أو التسجيل الصوتي.',
                    locked_by: null, locked_at: null
                }).eq('id', jobId);
                await supabase.from('lessons').update({ pipeline_stage: 'failed' }).eq('id', lesson_id);
                return new Response(JSON.stringify({ status: 'aborted_no_content' }), { headers: corsHeaders });
            }

            if (hasAudio) {
                const { data: audioJobsList } = await supabase.from('processing_queue')
                    .select('id, status, updated_at, attempt_count, error_message, payload')
                    .eq('lesson_id', lesson_id)
                    .in('job_type', ['transcribe_audio', 'extract_audio_focus'])
                    .in('status', ['pending', 'processing']);

                const pendingAudio = audioJobsList?.length || 0;

                if (pendingAudio > 0) {
                    // ── Smart timeout: check both absolute age AND progress ──
                    const { data: segJob } = await supabase.from('processing_queue')
                        .select('created_at')
                        .eq('id', jobId)
                        .single();

                    const now = Date.now();
                    const createdAt = segJob?.created_at ? new Date(segJob.created_at).getTime() : now;
                    const waitingMinutes = (now - createdAt) / 60000;

                    // Check if audio jobs are making progress (updated recently)
                    const STALE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes of no updates = stuck
                    const allStuck = audioJobsList!.every((j: any) => {
                        const lastUpdate = j.updated_at ? new Date(j.updated_at).getTime() : 0;
                        return (now - lastUpdate) > STALE_THRESHOLD_MS;
                    });

                    const shouldTimeout = waitingMinutes >= 10 || allStuck;

                    if (!shouldTimeout) {
                        console.log(`[segmentation-worker] Audio processing not complete yet (${waitingMinutes.toFixed(1)} min, stale=${allStuck}). Re-queuing with 15s backoff.`);
                        const nextRetry = new Date(now + 15 * 1000).toISOString();
                        await supabase.from('processing_queue').update({ status: 'pending', locked_by: null, locked_at: null, next_retry_at: nextRetry }).eq('id', jobId);
                        return new Response(JSON.stringify({ status: 'staged', message: 'waiting_for_audio' }), { headers: corsHeaders });
                    }

                    // Timeout: audio stuck or exceeded 10 min absolute cap
                    const reason = allStuck
                        ? `Audio jobs not updated for 3+ min (stale)`
                        : `Absolute timeout after ${waitingMinutes.toFixed(1)} min`;
                    console.warn(`[segmentation-worker] AUDIO TIMEOUT: ${reason}. Proceeding WITHOUT audio transcription.`);

                    const audioErrors = audioJobsList!.map((j: any) => `[${j.status} a:${j.attempt_count}] ${j.error_message || 'no error'}`).join(' | ');
                    console.warn(`[segmentation-worker] Audio job details: ${audioErrors}`);

                    // Mark stuck audio jobs as failed so they stop cycling
                    const timeoutMsg = `تم تخطي معالجة الصوت — ${reason}. التفاصيل: ${audioErrors || 'غير معروف'}`;
                    await supabase.from('processing_queue')
                        .update({
                            status: 'failed',
                            error_message: timeoutMsg,
                            locked_by: null,
                            locked_at: null
                        })
                        .eq('lesson_id', lesson_id)
                        .in('job_type', ['transcribe_audio', 'extract_audio_focus'])
                        .in('status', ['pending', 'processing']);
                }
            }


            // 2. Fetch OCR pages text pointers to build TOC
            const { data: pages } = await supabase.from('lesson_pages')
                .select('page_number, storage_path')
                .eq('lesson_id', lesson_id)
                .order('page_number', { ascending: true })
                .limit(30); // First 30 pages to capture full TOC

            // ══ NEW LOGIC: Support Images and Audio correctly ══
            // If there are no lesson_pages (because it's an Image or Audio file injected directly into document_sections)
            let parsedToc: any = { lectures: [] };
            let hasTOC = false;

            if (!pages || pages.length === 0) {
                // Check if we have image/audio content directly in sections or if it has audio
                const { count: sectionCount } = await supabase.from('document_sections')
                    .select('*', { count: 'exact', head: true })
                    .eq('lesson_id', lesson_id);

                if ((sectionCount && sectionCount > 0) || hasAudio) {
                    console.log(`[segmentation-worker] No PDF pages found, but sections/audio exist.`);

                    let audioSegmented = false;
                    if (hasAudio) {
                        try {
                            const audioPath = `${lesson_id}/raw_transcript.txt`;
                            const { data: audioBlob } = await supabase.storage.from('audio_transcripts').download(audioPath);
                            if (audioBlob) {
                                const fullText = await audioBlob.text();
                                const words = fullText.split(/\s+/);
                                console.log(`[segmentation-worker] Audio transcript: ${words.length} words, ${fullText.length} chars`);

                                if (words.length > 200) {
                                    // ── SMART SEGMENTATION: Use Gemini to extract actual topics ──
                                    try {
                                        console.log(`[segmentation-worker] Using Gemini for smart topic-based segmentation...`);

                                        // Send first 15000 chars to fit in context (covers ~2500 words)
                                        const sampleText = fullText.substring(0, 15000);
                                        const topicPrompt = `أنت خبير في تحليل المحاضرات الجامعية العربية. لديك تفريغ صوتي لمحاضرة. قم باستخراج المواضيع الرئيسية التي تناولها المُحاضر.

قواعد:
- استخرج بين 2 و 8 مواضيع رئيسية
- كل موضوع يجب أن يكون له عنوان واضح ومختصر
- رتّب المواضيع حسب ترتيب ظهورها في المحاضرة
- لا تدمج مواضيع مختلفة في موضوع واحد

أرجع JSON فقط بهذا الشكل:
{
  "topics": [
    { "title": "عنوان الموضوع", "summary": "ملخص سطر واحد" }
  ]
}

النص:
${sampleText}${fullText.length > 15000 ? `\n\n... (يتبع ${words.length - 2500} كلمة إضافية)` : ''}`;

                                        const topicResult = await callGeminiJSON(topicPrompt, geminiKey);

                                        if (topicResult?.topics && Array.isArray(topicResult.topics) && topicResult.topics.length >= 2) {
                                            const topics = topicResult.topics;
                                            console.log(`[segmentation-worker] Gemini extracted ${topics.length} topics: ${topics.map((t: any) => t.title).join(', ')}`);

                                            // Distribute words evenly across topics
                                            const wordsPerTopic = Math.ceil(words.length / topics.length);

                                            for (let i = 0; i < topics.length; i++) {
                                                const startWord = i * wordsPerTopic;
                                                const endWord = Math.min((i + 1) * wordsPerTopic, words.length);
                                                const chunkText = words.slice(startWord, endWord).join(' ');

                                                // Save each topic's chunk to storage for analyze_lecture to use
                                                const chunkPath = `${lesson_id}/chunk_${i + 1}.txt`;
                                                await supabase.storage.from('audio_transcripts').upload(
                                                    chunkPath,
                                                    new Blob([chunkText], { type: 'text/plain' }),
                                                    { upsert: true }
                                                );

                                                parsedToc.lectures.push({
                                                    title: String(topics[i].title || `الجزء ${i + 1}`).trim(),
                                                    start_page: i + 1
                                                });
                                            }

                                            audioSegmented = true;
                                            hasTOC = true;
                                            console.log(`[segmentation-worker] Smart segmentation complete: ${topics.length} topic-based segments`);
                                        } else {
                                            console.warn(`[segmentation-worker] Gemini returned invalid topics, falling back to word-based chunking`);
                                        }
                                    } catch (topicErr: any) {
                                        console.warn(`[segmentation-worker] Smart segmentation failed: ${topicErr.message}. Falling back.`);
                                    }

                                    // ── FALLBACK: Word-based chunking ──
                                    if (!audioSegmented) {
                                        console.log(`[segmentation-worker] Using fallback word-based chunking (${words.length} words)...`);
                                        const chunkSize = 2000;
                                        for (let i = 0; i < words.length; i += chunkSize) {
                                            const chunkNumber = Math.floor(i / chunkSize) + 1;
                                            const chunkText = words.slice(i, i + chunkSize).join(' ');

                                            const chunkPath = `${lesson_id}/chunk_${chunkNumber}.txt`;
                                            await supabase.storage.from('audio_transcripts').upload(
                                                chunkPath,
                                                new Blob([chunkText], { type: 'text/plain' }),
                                                { upsert: true }
                                            );

                                            parsedToc.lectures.push({ title: `محتوى التسجيل الصوتي (الجزء ${chunkNumber})`, start_page: chunkNumber });
                                        }
                                        audioSegmented = true;
                                        hasTOC = true;
                                    }
                                } else {
                                    // Short transcript — single segment
                                    parsedToc.lectures.push({ title: "محتوى التسجيل الصوتي", start_page: 1 });
                                    audioSegmented = true;
                                    hasTOC = true;
                                }
                            }
                        } catch (e) {
                            console.warn(`[segmentation-worker] Failed to download/chunk audio transcript:`, e);
                        }
                    }

                    if (!audioSegmented) {
                        console.log(`[segmentation-worker] Creating a single segment for the entire file.`);
                        parsedToc.lectures.push({ title: "محتوى الملف بالكامل", start_page: 1 });
                        hasTOC = true;
                    }
                }
            }

            if (!hasTOC) {
                let tocContext = "";
                for (const p of (pages || [])) {
                    if (!p.storage_path) continue;
                    const { data: textData } = await supabase.storage.from('ocr').download(p.storage_path);
                    if (textData) {
                        tocContext += `\n\n--- Page ${p.page_number} ---\n` + await textData.text();
                    }
                    if (tocContext.length > 50000) break; // Don't overflow prompt
                }

                // 3. Intelligent LLM Segmentation
                const prompt = `[تعليمات صارمة — ممنوع تجاوزها]

أنت خبير أكاديمي في استخراج فهارس الكتب. مهمتك استخراج جميع عناوين المحاضرات/الفصول من النص التالي.

⛔ قواعد لا يمكن كسرها:
1. يجب استخراج كل عنصر في الفهرس بدون استثناء — لا تحذف أي عنصر
2. لا تدمج عناصر مع بعضها — كل عنوان في الفهرس = عنصر منفصل
3. إذا وجدت 13 عنصراً في الفهرس، يجب أن يكون الناتج 13 عنصراً بالضبط
4. رقم الصفحة يجب أن يكون من الفهرس نفسه — لا تخترع أرقام
5. تحقق من الناتج: هل عدد العناصر يطابق ما في الفهرس؟

المخرج: JSON حصراً:
{
  "lectures": [
    { "title": "عنوان", "start_page": رقم }
  ]
}

النص:
${tocContext}`;
                try {
                    if (tocContext.trim().length > 50) {
                        parsedToc = await callGeminiJSON(prompt, geminiKey);
                    } else {
                        // Fallback if no text found initially
                        parsedToc.lectures.push({ title: "المحاضرة الشاملة", start_page: 1 });
                    }
                } catch (e: any) {
                    console.warn(`[segmentation-worker] LLM TOC parsing failed, falling back to 1 chunk.`, e);
                    parsedToc.lectures.push({ title: "المحاضرة (افتراضي)", start_page: 1 });
                }
            }

            if (!parsedToc?.lectures || parsedToc.lectures.length === 0) {
                parsedToc = { lectures: [{ title: 'محتوى الدرس العام', start_page: 1 }] };
            }

            const lecturesToInsert = parsedToc.lectures.map((l: any, idx: number) => {
                // Ensure LLM hasn't hallucinated strings/dashes for page numbers
                let start_page = parseInt(String(l.start_page), 10);
                if (isNaN(start_page) || start_page < 1) start_page = 1;

                let next_start = 0;
                const next = parsedToc.lectures[idx + 1];
                if (next && next.start_page) {
                    next_start = parseInt(String(next.start_page), 10);
                }

                const end_page = (!isNaN(next_start) && next_start > start_page) ? next_start - 1 : start_page + 100; // max threshold

                return {
                    lesson_id: lesson_id,
                    title: String(l.title || 'بدون عنوان').trim(),
                    start_page: start_page,
                    end_page: end_page,
                    status: 'pending'
                };
            });

            // Clear any existing segments for this lesson (handles retry case)
            const { count: existingCount } = await supabase.from('segmented_lectures')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id);

            if (existingCount && existingCount > 0) {
                console.log(`[segmentation-worker] Found ${existingCount} existing segments. Removing for re-segmentation.`);
                await supabase.from('segmented_lectures').delete().eq('lesson_id', lesson_id);
            }

            const { data: insertedLectures, error: insertErr } = await supabase.from('segmented_lectures')
                .insert(lecturesToInsert)
                .select('id, title, start_page, end_page');

            if (insertErr) throw new Error(`Failed to save lecture segments: ${insertErr.message}`);

            // 4. Enqueue analyze_lecture for each newly created segment
            const jobsToInsert = (insertedLectures || []).map(lec => ({
                lesson_id: lesson_id,
                job_type: 'analyze_lecture',
                payload: { ...payload, lecture_id: lec.id, title: lec.title, start_page: lec.start_page, end_page: lec.end_page },
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:analyze_lecture:${lec.id}`
            }));

            // Final Aggregator Barrier Job
            jobsToInsert.push({
                lesson_id: lesson_id,
                job_type: 'finalize_global_summary',
                payload: { ...payload },
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:finalize_global_summary`
            });

            await supabase.from('processing_queue').upsert(jobsToInsert, { onConflict: 'dedupe_key', ignoreDuplicates: true });

            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
            return new Response(JSON.stringify({ status: 'completed', lectures_created: lecturesToInsert.length }), { headers: corsHeaders });
        }

        throw new Error(`Unhandled job type: ${job_type}`);

    } catch (error: any) {
        console.error('[segmentation-worker] Error:', error);
        if (req.method !== 'OPTIONS') {
            try {
                if (jobId) {
                    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
                    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    const { data: currentJob } = await supabase.from('processing_queue')
                        .select('attempt_count').eq('id', jobId).single();
                    const attempts = (currentJob?.attempt_count || 0);
                    if (attempts >= 5) {
                        await supabase.from('processing_queue').update({
                            status: 'failed',
                            error_message: error.message || 'Unknown Segmentation Error (max retries)',
                            locked_by: null,
                            locked_at: null
                        }).eq('id', jobId);
                    } else {
                        await supabase.from('processing_queue').update({
                            status: 'pending',
                            error_message: `Retry ${attempts}/5: ${error.message || 'Unknown Segmentation Error'}`,
                            locked_by: null,
                            locked_at: null
                        }).eq('id', jobId);
                    }
                }
            } catch (_) { }
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
