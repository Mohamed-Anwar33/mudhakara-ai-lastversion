import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function callGeminiText(prompt: string, apiKey: string): Promise<string> {
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
    if (!response.ok) throw new Error(`Gemini Text: ${data.error?.message || response.status}`);

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

        const { job_type, lesson_id } = job;

        if (job_type === 'finalize_global_summary') {
            console.log(`[global-aggregator] Checking global status for lesson ${lesson_id}...`);

            // 1. BARRIER CHECK: Are ALL lectures fully quizzed?
            const { count: totalSegments } = await supabase.from('segmented_lectures')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id);

            const { count: finishedSegments } = await supabase.from('segmented_lectures')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .eq('status', 'quiz_done');

            if (!totalSegments || finishedSegments !== totalSegments) {
                console.log(`[global-aggregator] Waiting on lectures... ${finishedSegments}/${totalSegments} done. Releasing lock.`);
                // Unlock so it retries later
                await supabase.from('processing_queue').update({ status: 'pending', locked_by: null, locked_at: null, attempt_count: 0 }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'waiting_for_lectures' }), { headers: corsHeaders });
            }

            // 2. We are clear! Pull all summaries for the Global Overview
            const { data: lectures } = await supabase.from('segmented_lectures')
                .select('title, summary_storage_path')
                .eq('lesson_id', lesson_id);

            let megaContext = "";
            let indexMap: any = { topics: [] };

            for (const lec of (lectures || [])) {
                indexMap.topics.push({ title: lec.title });
                if (!lec.summary_storage_path) continue;

                const { data: fileData } = await supabase.storage.from('analysis').download(lec.summary_storage_path);
                if (fileData) {
                    const text = await fileData.text();
                    try {
                        const json = JSON.parse(text);
                        megaContext += `\n--- Lecture: ${lec.title} ---\n` + (json.explanation_notes || '').substring(0, 3000); // Take snippets to avoid token overflow
                    } catch (e) { }
                }
            }

            // 3. Generate Global Overview
            const prompt = `أنت أكاديمي خبير. اكتب "نظرة عامة" شاملة للكتاب/الدورة التعليمية بأكملها في 3-5 فقرات، تلخص أهم ما تم تغطيته.
            استند على هذا الملخص للدروس:
            ${megaContext.substring(0, 80000)}`;

            let finalSummary = 'تعذر توليد المتلخص العام.';
            try {
                if (megaContext.trim().length > 50) {
                    finalSummary = await callGeminiText(prompt, geminiKey);
                }
            } catch (e: any) {
                console.warn(`[global-aggregator] Text Overview failed: ${e.message}`);
            }

            // 4. Save Final Global State!
            const { error: updateError } = await supabase.from('lessons')
                .update({
                    pipeline_stage: 'completed',
                    analysis_status: 'completed',
                    analysis_result: {
                        summary: finalSummary,
                        indexMap: indexMap,
                        metadata: { generatedAt: new Date().toISOString() }
                    }
                })
                .eq('id', lesson_id);

            if (updateError) throw new Error(`Failed to update lesson analysis state: ${updateError.message}`);

            // 🧹 Optional: Housekeeping - Delete intermediate raw OCR chunks if free tier space is a premium constraint
            // (Leaving disabled by default to allow users to view raw OCR if debugging, but structure is here)
            /*
            const { data: oldPages } = await supabase.from('lesson_pages').select('storage_path').eq('lesson_id', lesson_id);
            const toDelete = (oldPages || []).map(p => p.storage_path).filter(Boolean);
            if (toDelete.length > 0) await supabase.storage.from('ocr').remove(toDelete);
            */

            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
            console.log(`[global-aggregator] Lesson ${lesson_id} is 100% COMPLETE! 🎉`);
            return new Response(JSON.stringify({ status: 'completed' }), { headers: corsHeaders });
        }

        throw new Error(`Unhandled aggregator job type: ${job_type}`);

    } catch (error: any) {
        console.error('[global-aggregator] Error:', error);
        if (req.method !== 'OPTIONS') {
            try {
                if (jobId) {
                    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
                    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    await supabase.from('processing_queue').update({
                        status: 'failed',
                        error_message: error.message || 'Unknown Global Aggregator Error',
                        locked_by: null,
                        locked_at: null
                    }).eq('id', jobId);
                }
            } catch (_) { }
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
