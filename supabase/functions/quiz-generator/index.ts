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
                generationConfig: { temperature: 0.3, maxOutputTokens: 65536, responseMimeType: 'application/json' }
            })
        }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini JSON: ${data.error?.message || response.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
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

        if (job_type === 'generate_quiz') {
            const { lecture_id, summary_storage_path } = payload;

            if (!summary_storage_path) throw new Error("Missing summary_storage_path to base quizzes on.");

            console.log(`[quiz-generator] Generating quizzes for lecture ${lecture_id}`);

            // Download summary from Storage
            const { data: fileData, error: dlErr } = await supabase.storage.from('analysis').download(summary_storage_path);
            if (dlErr || !fileData) throw new Error("Failed to download analysis JSON from storage");

            const analysisJsonString = await fileData.text();
            let analysisData;
            try {
                analysisData = JSON.parse(analysisJsonString);
            } catch (e) {
                throw new Error("Analysis JSON is malformed, cannot read text for quiz gen.");
            }

            const lectureContent = String(analysisData.explanation_notes || '').substring(0, 150000); // Guard big notes

            const prompt = `بناءً على هذا الملخص التعليمي، صمم اختباراً شاملاً للدرس.
            يجب أن يركز الاختبار على النقاط التي وُضِعت تحت علامة "TEACHER FOCUS" (إن وجدت).

            المطلوب إخراج JSON بالشكل التالي حصراً:
            {
               "focus_points": [ {"title": "كذا", "details": "كذا"} ],
               "quizzes": [
                  {
                    "question": "نص السؤال",
                    "type": "mcq",
                    "options": ["أ", "ب", "ج", "د"],
                    "correctAnswer": 0,
                    "explanation": "شرح الإجابة"
                  }
               ],
               "essay_questions": [
                  { "question": "", "idealAnswer": "" }
               ]
            }

            قواعد: 
            - 10-15 سؤال اختياري
            - 3-5 أسئلة مقالية
            - 5 أهداف تركيز (focus_points)
            - Options مصفوفة من 4. correctAnswer هو المؤشر 0، 1، 2، أو 3.

            النص:
            ${lectureContent}`;

            const quizJson = await callGeminiJSON(prompt, geminiKey);

            // Merge Quiz deeply with existing Note JSON inside storage
            analysisData.quizzes = quizJson.quizzes || [];
            analysisData.focusPoints = quizJson.focus_points || [];
            analysisData.essayQuestions = quizJson.essay_questions || [];

            // Overwrite JSON in Storage
            const { error: storageErr } = await supabase.storage.from('analysis')
                .upload(summary_storage_path, JSON.stringify(analysisData, null, 2), { upsert: true, contentType: 'application/json' });

            if (storageErr) throw new Error(`Failed to update Analysis JSON with Quizzes: ${storageErr.message}`);

            // Complete segment -> mark as quiz_done
            await supabase.from('segmented_lectures')
                .update({ status: 'quiz_done' })
                .eq('id', lecture_id);

            // Check if ALL lectures for this lesson are completely done
            const { count: totalSegments } = await supabase.from('segmented_lectures')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id);

            const { count: finishedSegments } = await supabase.from('segmented_lectures')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson_id)
                .eq('status', 'quiz_done');

            console.log(`[quiz-generator] Lecture ${lecture_id} Quizzes Done. Progress: ${finishedSegments}/${totalSegments}`);

            if (totalSegments && finishedSegments && totalSegments === finishedSegments) {
                // If everything is done, the global aggregator (already waiting) will succeed on next lock
                console.log(`[quiz-generator] All quizzes done for lesson ${lesson_id}!`);
            }

            await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
            return new Response(JSON.stringify({ status: 'completed' }), { headers: corsHeaders });
        }

        throw new Error(`Unhandled quiz job type: ${job_type}`);

    } catch (error: any) {
        console.error('[quiz-generator] Error:', error);
        if (req.method !== 'OPTIONS') {
            try {
                if (jobId) {
                    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
                    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    await supabase.from('processing_queue').update({
                        status: 'failed',
                        error_message: error.message || 'Unknown Quiz Error',
                        locked_by: null,
                        locked_at: null
                    }).eq('id', jobId);
                }
            } catch (_) { }
        }
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
