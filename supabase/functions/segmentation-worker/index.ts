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

            // 1. Barrier Check: Are ALL OCR jobs finished? (completed or failed — either is "done")
            const { count: pendingOcrJobs } = await supabase.from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .in('job_type', ['extract_pdf_info', 'ocr_page_batch'])
                .in('status', ['pending', 'processing']);

            if (pendingOcrJobs && pendingOcrJobs > 0) {
                console.log(`[segmentation-worker] ${pendingOcrJobs} OCR jobs still running. Releasing lock to retry later.`);
                await supabase.from('processing_queue').update({ status: 'pending', locked_by: null, locked_at: null }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'waiting_for_ocr' }), { headers: corsHeaders });
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

            // If NO pages have any content at all, then we truly failed
            if (!successPages || successPages === 0) {
                console.error(`[segmentation-worker] Zero pages extracted. Cannot proceed.`);
                await supabase.from('processing_queue').update({
                    status: 'failed',
                    error_message: 'لم يتم استخراج أي نص من الكتاب.',
                    locked_by: null, locked_at: null
                }).eq('id', jobId);
                await supabase.from('lessons').update({ pipeline_stage: 'failed' }).eq('id', lesson_id);
                return new Response(JSON.stringify({ status: 'aborted_no_content' }), { headers: corsHeaders });
            }

            // Also check Audio Track if Audio exists
            const { data: lessonData } = await supabase.from('lessons').select('audio_url').eq('id', lesson_id).single();
            if (lessonData?.audio_url) {
                const { count: pendingAudio } = await supabase.from('processing_queue')
                    .select('*', { count: 'exact', head: true })
                    .eq('lesson_id', lesson_id)
                    .in('job_type', ['transcribe_audio', 'extract_audio_focus'])
                    .in('status', ['pending', 'processing']);

                if (pendingAudio && pendingAudio > 0) {
                    console.log(`[segmentation-worker] Audio processing not complete yet. Waiting...`);
                    await supabase.from('processing_queue').update({ status: 'pending', locked_by: null, locked_at: null, attempt_count: 0 }).eq('id', jobId);
                    return new Response(JSON.stringify({ status: 'waiting_for_audio' }), { headers: corsHeaders });
                }
            }


            // 2. Fetch OCR pages text pointers to build TOC
            const { data: pages } = await supabase.from('lesson_pages')
                .select('page_number, storage_path')
                .eq('lesson_id', lesson_id)
                .order('page_number', { ascending: true })
                .limit(20); // First 20 pages usually contain the TOC

            // ══ NEW LOGIC: Support Images and Audio correctly ══
            // If there are no lesson_pages (because it's an Image or Audio file injected directly into document_sections)
            let parsedToc: any = { lectures: [] };
            let hasTOC = false;

            if (!pages || pages.length === 0) {
                // Check if we have image/audio content directly in sections
                const { count: sectionCount } = await supabase.from('document_sections')
                    .select('*', { count: 'exact', head: true })
                    .eq('lesson_id', lesson_id);

                if (sectionCount && sectionCount > 0) {
                    console.log(`[segmentation-worker] No PDF pages found, but ${sectionCount} sections exist (Image/Audio). Bypassing TOC extraction.`);
                    parsedToc.lectures.push({ title: "محتوى الملف بالكامل", start_page: 1 });
                    hasTOC = true;
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
                const prompt = `أنت خبير أكاديمي محترف في استخراج فهارس الكتب وتقسيمها إلى محاضرات (Lectures).
                بناءً على هذا النص المستخرج من بداية الكتاب، استخرج عناوين المحاضرات أو الفصول الرئيسية مع رقم الصفحة التقريبي لبدايتها.
                
                يجب أن يكون الناتج JSON حصراً بالشكل التالي:
                {
                  "lectures": [
                    { "title": "الفصل الأول: كذا", "start_page": 5 },
                    { "title": "الفصل الثاني: كذا", "start_page": 22 }
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
                const start_page = l.start_page || 1;
                const next = parsedToc.lectures[idx + 1];
                const end_page = next && next.start_page ? next.start_page - 1 : start_page + 100; // max threshold
                return {
                    lesson_id: lesson_id,
                    title: l.title,
                    start_page: start_page,
                    end_page: end_page,
                    status: 'pending'
                };
            });

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
                    await supabase.from('processing_queue').update({
                        status: 'failed',
                        error_message: error.message || 'Unknown Segmentation Error',
                        locked_by: null,
                        locked_at: null
                    }).eq('id', jobId);
                }
            } catch (_) { }
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
