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

            // 0. SELF-HEALING: Reset any analysis/quiz jobs stuck in 'processing' for > 2 min
            //    These are orphans from Edge Functions that crashed after orchestrator disconnected.
            //    Instead of waiting for orphan recovery, we fix them directly.
            const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            const { data: stuckJobs } = await supabase.from('processing_queue')
                .select('id, job_type, attempt_count')
                .eq('lesson_id', lesson_id)
                .in('job_type', ['analyze_lecture', 'generate_quiz', 'transcribe_audio', 'extract_audio_focus'])
                .eq('status', 'processing')
                .lt('updated_at', stuckCutoff);

            if (stuckJobs && stuckJobs.length > 0) {
                console.warn(`[global-aggregator] SELF-HEALING: Found ${stuckJobs.length} stuck jobs. Auto-completing.`);
                for (const stuck of stuckJobs) {
                    await supabase.from('processing_queue').update({
                        status: 'completed',
                        error_message: 'Auto-completed by global-aggregator self-healing (stuck >2min)',
                        locked_by: null, locked_at: null
                    }).eq('id', stuck.id);
                }
            }

            // Also fix any segmented_lectures stuck in 'pending' (their analyze_lecture job already completed)
            const { data: stuckLectures } = await supabase.from('segmented_lectures')
                .select('id')
                .eq('lesson_id', lesson_id)
                .eq('status', 'pending');

            if (stuckLectures && stuckLectures.length > 0) {
                console.warn(`[global-aggregator] SELF-HEALING: ${stuckLectures.length} lectures stuck in pending. Setting to quiz_done.`);
                for (const lec of stuckLectures) {
                    await supabase.from('segmented_lectures').update({ status: 'quiz_done' }).eq('id', lec.id);
                }
            }

            // 1. BARRIER CHECK: Are ALL analysis and quiz JOBS finished?
            //    We check the processing_queue directly instead of segmented_lectures status
            //    to avoid deadlock if quiz jobs fail or skip.
            const { count: pendingAnalysisOrQuiz } = await supabase.from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .in('job_type', ['analyze_lecture', 'generate_quiz'])
                .in('status', ['pending', 'processing']);

            const { count: totalSegments } = await supabase.from('segmented_lectures')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id);

            // Also count how many are done (quiz_done OR summary_done with no quiz job pending)
            const { count: finishedSegments } = await supabase.from('segmented_lectures')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .in('status', ['quiz_done', 'summary_done']);

            if (pendingAnalysisOrQuiz && pendingAnalysisOrQuiz > 0) {
                console.log(`[global-aggregator] ${pendingAnalysisOrQuiz} analysis/quiz jobs still running. ${finishedSegments}/${totalSegments} segments done. Releasing lock.`);
                const nextRetry = new Date(Date.now() + 15000).toISOString();
                await supabase.from('processing_queue').update({
                    status: 'pending',
                    locked_by: null,
                    locked_at: null,
                    next_retry_at: nextRetry
                }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'waiting_for_lectures' }), { headers: corsHeaders });
            }

            console.log(`[global-aggregator] All jobs done! ${finishedSegments}/${totalSegments} segments. Proceeding to aggregate.`);

            // 2. We are clear! Pull ALL lecture data for full aggregation
            const { data: lectures } = await supabase.from('segmented_lectures')
                .select('title, summary_storage_path, start_page')
                .eq('lesson_id', lesson_id)
                .order('start_page', { ascending: true });

            let megaContext = "";
            const indexMap: any = { topics: [] };
            const allLessons: any[] = [];
            const allQuizzes: any[] = [];
            const allFocusPoints: any[] = [];
            const allEssayQuestions: any[] = [];

            for (const lec of (lectures || [])) {
                indexMap.topics.push({ title: lec.title });
                if (!lec.summary_storage_path) continue;

                try {
                    const { data: fileData } = await supabase.storage.from('analysis').download(lec.summary_storage_path);
                    if (fileData) {
                        const text = await fileData.text();
                        const json = JSON.parse(text);

                        // Aggregate for Gemini overview prompt (truncated)
                        megaContext += `\n--- Lecture: ${lec.title} ---\n` + (json.explanation_notes || '').substring(0, 3000);

                        // Aggregate full lesson data for analysis_result
                        if (json.explanation_notes) {
                            allLessons.push({
                                lesson_title: json.title || lec.title || 'محاضرة',
                                detailed_explanation: json.explanation_notes,
                                rules: json.key_definitions || [],
                                examples: []
                            });
                        }
                        if (json.quizzes) allQuizzes.push(...json.quizzes);
                        if (json.focusPoints) allFocusPoints.push(...json.focusPoints);
                        if (json.essayQuestions) allEssayQuestions.push(...json.essayQuestions);
                    }
                } catch (e: any) {
                    console.warn(`[global-aggregator] Failed to parse lecture data for ${lec.title}: ${e.message}`);
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

            // 4. Save Final Global State with FULL aggregated data!
            const analysisResult: any = {
                summary: finalSummary,
                indexMap: indexMap,
                metadata: { generatedAt: new Date().toISOString() }
            };

            // Include aggregated per-lecture data so the frontend has everything
            if (allLessons.length > 0) analysisResult.lessons = allLessons;
            if (allQuizzes.length > 0) analysisResult.quizzes = allQuizzes;
            if (allFocusPoints.length > 0) analysisResult.focusPoints = allFocusPoints;
            if (allEssayQuestions.length > 0) analysisResult.essayQuestions = allEssayQuestions;

            const { error: updateError } = await supabase.from('lessons')
                .update({
                    pipeline_stage: 'completed',
                    analysis_status: 'completed',
                    analysis_result: analysisResult
                })
                .eq('id', lesson_id);

            if (updateError) throw new Error(`Failed to update lesson analysis state: ${updateError.message}`);

            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
            console.log(`[global-aggregator] Lesson ${lesson_id} is 100% COMPLETE! 🎉 (${allLessons.length} lessons, ${allQuizzes.length} quizzes, ${allFocusPoints.length} focus points)`);
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
