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

            // VALIDATION: Skip quiz generation for insufficient or placeholder content
            if (lectureContent.length < 1000) {
                console.warn(`[quiz-generator] Lecture ${lecture_id} has insufficient content (${lectureContent.length} chars). Skipping quiz generation.`);
                // Mark as quiz_done without generating garbage quizzes
                await supabase.from('segmented_lectures')
                    .update({ status: 'quiz_done' })
                    .eq('id', lecture_id);
                await supabase.from('processing_queue').update({ status: 'completed' }).eq('id', jobId);
                return new Response(JSON.stringify({ status: 'skipped_insufficient_content' }), { headers: corsHeaders });
            }

            const prompt = `استناداً إلى الملخص التعليمي التفصيلي التالي، صمم بنك أسئلة شامل للدرس للطلاب.
            يجب أن يركز الاختبار بشدة على النقاط التي وُضِعت تحت علامة "🎤 ما ذكره المعلم" (إن وجدت).

            المطلوب إخراج JSON بالشكل التالي حصراً واختبارات قوية وليست سطحية:
            {
               "quizzes": [
                  {
                    "question": "نص السؤال",
                    "type": "mcq",
                    "options": ["خيار 1", "خيار 2", "خيار 3", "خيار 4"],
                    "correctAnswer": 0,
                    "explanation": "شرح الإجابة ولماذا هي صحيحة"
                  },
                  {
                    "question": "نص سؤال صح أو خطأ",
                    "type": "tf",
                    "options": ["صح", "خطأ"],
                    "correctAnswer": 1,
                    "explanation": "لماذا العبارة خاطئة أو صحيحة"
                  }
               ],
               "essayQuestions": [
                  { "question": "السؤال المقالي العميق", "idealAnswer": "الإجابة النموذجية المرجعية" }
               ]
            }

            قواعد صارمة جداً: 
            - يجب أن تولّد من 10 إلى 15 سؤال موضوعي (quizzes) مقسمة بين اختياري (mcq) وصح/خطأ (tf).
            - يجب أن تولّد من 3 إلى 5 أسئلة مقالية (essayQuestions) تقيس الفهم العميق.
            - بالنسبة لأسئلة الاختياري (mcq)، يجب أن تكون مجموعة (options) تحتوي على 4 نصوص.
            - بالنسبة لأسئلة الصح/الخطأ (tf)، يجب أن تكون مجموعة (options) تحتوي على نصين فقط: ["صح", "خطأ"].
            - قيمة correctAnswer هي دائماً رقم (Index) (0, 1, 2, 3).
            - لا تقم بإنشاء أي مفاتيح أخرى.
            - ⚠️ ممنوع منعاً باتاً اختلاق أسئلة من خارج النص المقدم. كل سؤال يجب أن يكون مبنياً حصرياً على معلومة واردة في النص أدناه.
            - ⚠️ لا تسأل أبداً عن عبارات تقنية أو أخطاء أو ملاحظات نظام (مثل "No extraction possible" أو أي نص لا يمت للمادة بصلة).
            - يجب أن تكون الأسئلة أكاديمية وتختبر فهم الطالب للمفاهيم العلمية الواردة في النص فقط.

            النص:
            ${lectureContent}`;

            const quizJson = await callGeminiJSON(prompt, geminiKey);

            // Merge Quiz deeply with existing Note JSON inside storage
            analysisData.quizzes = quizJson.quizzes || [];
            analysisData.essayQuestions = quizJson.essayQuestions || [];

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
