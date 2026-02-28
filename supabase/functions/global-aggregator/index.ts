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

            // 0. SELF-HEALING: Reset any stuck jobs > 2 min
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

            // Fix stuck segmented_lectures
            const { data: stuckLectures } = await supabase.from('segmented_lectures')
                .select('id')
                .eq('lesson_id', lesson_id)
                .eq('status', 'pending');

            if (stuckLectures && stuckLectures.length > 0) {
                console.warn(`[global-aggregator] SELF-HEALING: ${stuckLectures.length} lectures stuck in pending.`);
                for (const lec of stuckLectures) {
                    await supabase.from('segmented_lectures').update({ status: 'quiz_done' }).eq('id', lec.id);
                }
            }

            // 1. BARRIER CHECK
            const { count: pendingAnalysisOrQuiz } = await supabase.from('processing_queue')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .in('job_type', ['analyze_lecture', 'generate_quiz'])
                .in('status', ['pending', 'processing']);

            if (pendingAnalysisOrQuiz && pendingAnalysisOrQuiz > 0) {
                const nextRetry = new Date(Date.now() + 15000).toISOString();
                await supabase.from('processing_queue').update({
                    status: 'pending', locked_by: null, locked_at: null, next_retry_at: nextRetry
                }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'waiting_for_lectures' }), { headers: corsHeaders });
            }

            console.log(`[global-aggregator] All jobs done! Proceeding to aggregate.`);

            // 2. Pull ALL lecture data
            const { data: lectures } = await supabase.from('segmented_lectures')
                .select('title, summary_storage_path, start_page')
                .eq('lesson_id', lesson_id)
                .order('start_page', { ascending: true });

            let megaContext = "";
            const indexMap: any = { topics: [] };

            // Map-based deduplication for ALL content types
            const lessonsMap = new Map<string, any>();
            const quizzesMap = new Map<string, any>();
            const focusPointsMap = new Map<string, any>();
            const essayQuestionsMap = new Map<string, any>();

            for (const lec of (lectures || [])) {
                indexMap.topics.push({ title: lec.title });
                if (!lec.summary_storage_path) continue;

                try {
                    const { data: fileData } = await supabase.storage.from('analysis').download(lec.summary_storage_path);
                    if (!fileData) continue;

                    const text = await fileData.text();
                    const json = JSON.parse(text);

                    // AGGRESSIVE SANITIZATION: Strip ALL garbage patterns
                    let cleanExplanation = (json.explanation_notes || '')
                        .replace(/no extraction possible/gi, '')
                        .replace(/\[no content found\]/gi, '')
                        .replace(/extraction failed/gi, '')
                        .replace(/unable to extract/gi, '')
                        .replace(/error reading[^\n]*/gi, '')
                        .replace(/could not process/gi, '')
                        .replace(/Error:?\s*[^\n]*/gi, '')
                        .replace(/فشل التحليل[^\n]*/gi, '')
                        .replace(/خطأ غير معروف[^\n]*/gi, '')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim();

                    // Skip empty/garbage content
                    if (!cleanExplanation || cleanExplanation.length < 50) {
                        console.warn(`[global-aggregator] Skipping lecture "${lec.title}" — empty after cleanup.`);
                        continue;
                    }

                    megaContext += `\n--- Lecture: ${lec.title} ---\n` + cleanExplanation.substring(0, 3000);

                    // DEDUP LESSONS by title using Map
                    const lecKey = (json.title || lec.title || 'محاضرة').trim();
                    if (!lessonsMap.has(lecKey)) {
                        lessonsMap.set(lecKey, {
                            lesson_title: lecKey,
                            detailed_explanation: cleanExplanation,
                            rules: json.key_definitions || [],
                            examples: []
                        });
                    }

                    // DEDUP QUIZZES + garbage filter
                    if (json.quizzes) {
                        for (const q of json.quizzes) {
                            const qText = (q.question || q.text || q.statement || '').trim();
                            if (!qText || qText.length < 10) continue;
                            if (/no extraction|extraction possible|error reading/i.test(qText)) continue;
                            if (/سؤال وهمي/i.test(qText)) continue;

                            const qKey = qText.substring(0, 80);
                            if (!quizzesMap.has(qKey)) {
                                quizzesMap.set(qKey, q);
                            }
                        }
                    }

                    // DEDUP FOCUS POINTS
                    if (json.focusPoints) {
                        for (const fp of json.focusPoints) {
                            const fpKey = (fp.title || '').trim();
                            if (fpKey && !focusPointsMap.has(fpKey)) {
                                focusPointsMap.set(fpKey, fp);
                            }
                        }
                    }

                    // DEDUP ESSAY QUESTIONS + garbage filter
                    if (json.essayQuestions) {
                        for (const eq of json.essayQuestions) {
                            const eqText = (eq.question || eq.title || '').trim();
                            if (!eqText || eqText.length < 10) continue;
                            if (/no extraction|extraction possible|error reading/i.test(eqText)) continue;

                            const eqKey = eqText.substring(0, 80);
                            if (!essayQuestionsMap.has(eqKey)) {
                                essayQuestionsMap.set(eqKey, eq);
                            }
                        }
                    }
                } catch (e: any) {
                    console.warn(`[global-aggregator] Failed to parse lecture data for ${lec.title}: ${e.message}`);
                }
            }

            // Convert Maps to Arrays
            const allLessons = Array.from(lessonsMap.values());
            const allQuizzes = Array.from(quizzesMap.values());
            const allFocusPoints = Array.from(focusPointsMap.values());
            const allEssayQuestions = Array.from(essayQuestionsMap.values());

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

            // 4. Build final result
            const analysisResult: any = {
                summary: finalSummary,
                indexMap: indexMap,
                metadata: { generatedAt: new Date().toISOString() }
            };

            if (allLessons.length > 0) analysisResult.lessons = allLessons;
            if (allQuizzes.length > 0) analysisResult.quizzes = allQuizzes;
            if (allFocusPoints.length > 0) analysisResult.focusPoints = allFocusPoints;
            if (allEssayQuestions.length > 0) analysisResult.essayQuestions = allEssayQuestions;

            console.log(`[global-aggregator] Final: ${allLessons.length} lessons, ${allQuizzes.length} quizzes, ${allFocusPoints.length} focus, ${allEssayQuestions.length} essay`);

            const { error: updateError } = await supabase.from('lessons')
                .update({
                    pipeline_stage: 'completed',
                    analysis_status: 'completed',
                    analysis_result: analysisResult
                })
                .eq('id', lesson_id);

            if (updateError) throw new Error(`Failed to update lesson: ${updateError.message}`);

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
