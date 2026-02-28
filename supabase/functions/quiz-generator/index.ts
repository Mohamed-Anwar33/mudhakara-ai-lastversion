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

            let lectureContent = String(analysisData.explanation_notes || '').substring(0, 150000); // Guard big notes

            // SANITIZATION: Strip garbage patterns from content before quiz generation
            const garbagePatterns = [
                /no extraction possible/gi,
                /extraction failed/gi,
                /unable to extract/gi,
                /error reading/gi,
                /could not process/gi,
                /سؤال وهمي\s*\d*/g,
            ];
            for (const pattern of garbagePatterns) {
                lectureContent = lectureContent.replace(pattern, '');
            }
            lectureContent = lectureContent.trim();

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

            const prompt = `[تعليمات النظام — ممنوع تجاوزها]
أنت خبير تصميم اختبارات أكاديمية جامعية. صمم بنك أسئلة ذكي ومتنوع بناءً على المحتوى التعليمي المقدم فقط.

⛔ قيود صارمة لا يمكن تجاوزها:
1. كل سؤال يجب أن يكون مبنياً على معلومة واردة حرفياً في النص المقدم. ممنوع الاختراع أو الإضافة.
2. ممنوع السؤال عن: "No extraction possible"، "Error"، رسائل نظام، أو أي موضوع خارج النص.
3. كل سؤال يجب أن يكون مختلفاً تماماً عن باقي الأسئلة — ممنوع التكرار أو إعادة الصياغة.
4. الإجابة النموذجية لكل سؤال يجب أن تكون موجودة في النص المقدم.
5. إذا لم يكن هناك محتوى كافٍ، أرجع أقساماً فارغة.

📋 المطلوب - 3 أقسام منفصلة:

القسم 1: أسئلة اختيار من متعدد (MCQ) - 4 إلى 6 أسئلة (لأن هذا قسم واحد من كتاب كبير)
- 4 خيارات لكل سؤال
- خيار واحد صحيح فقط
- الخيارات الخاطئة يجب أن تكون منطقية ومقنعة
- غطّي أهم المفاهيم والتعريفات في هذا القسم
- اسأل عن: تعريفات، مقارنات، تصنيفات، أمثلة، تطبيقات عملية

القسم 2: أسئلة صح وخطأ (TF) - 2 إلى 3 أسئلة
- عبارات تقريرية واضحة ودقيقة
- بعضها صحيح وبعضها خاطئ
- ركّز على: حقائق دقيقة، تفاصيل مهمة، مفاهيم سهلة الخلط

القسم 3: أسئلة مقالية (Essay) - 1 إلى 2 سؤال
- أسئلة ذكية تحتاج تفكير عميق
- اطلب: مقارنة بين مفهومين، تحليل، شرح مفصل، ربط بين مفاهيم
- الإجابة النموذجية تكون شاملة ومفصلة (200+ كلمة)

⚠️ مهم: هذا القسم جزء من كتاب كبير — ركّز على أهم النقاط الفريدة في هذا القسم بالذات

المخرج: JSON بالضبط هكذا:
{
   "mcqQuestions": [
      {"question": "سؤال", "options": ["أ", "ب", "ج", "د"], "correctAnswer": 0, "explanation": "شرح"}
   ],
   "tfQuestions": [
      {"statement": "عبارة تقريرية", "isTrue": true, "explanation": "لماذا صح أو خطأ"}
   ],
   "essayQuestions": [
      {"question": "السؤال المقالي", "idealAnswer": "الإجابة النموذجية الشاملة"}
   ]
}

النص التعليمي:
${lectureContent}`;

            const quizJson = await callGeminiJSON(prompt, geminiKey);

            // Post-processing: Deduplicate questions using Set
            const seenMcq = new Set<string>();
            const uniqueMcq = (quizJson.mcqQuestions || []).filter((q: any) => {
                const key = (q.question || '').trim().substring(0, 80);
                if (!key || seenMcq.has(key)) return false;
                seenMcq.add(key);
                return true;
            });

            const seenTf = new Set<string>();
            const uniqueTf = (quizJson.tfQuestions || []).filter((q: any) => {
                const key = (q.statement || '').trim().substring(0, 80);
                if (!key || seenTf.has(key)) return false;
                seenTf.add(key);
                return true;
            });

            const seenEssay = new Set<string>();
            const uniqueEssay = (quizJson.essayQuestions || []).filter((q: any) => {
                const key = (q.question || '').trim().substring(0, 80);
                if (!key || seenEssay.has(key)) return false;
                seenEssay.add(key);
                return true;
            });

            // Convert to the storage format used by the frontend
            // MCQ: type="mcq", TF: type="tf" 
            const allQuizzes = [
                ...uniqueMcq.map((q: any) => ({ ...q, type: 'mcq' })),
                ...uniqueTf.map((q: any) => ({
                    question: q.statement,
                    type: 'tf',
                    options: ['صح', 'خطأ'],
                    correctAnswer: q.isTrue ? 0 : 1,
                    explanation: q.explanation
                }))
            ];

            // Merge Quiz with existing Note JSON inside storage
            analysisData.quizzes = allQuizzes;
            analysisData.essayQuestions = uniqueEssay;

            console.log(`[quiz-generator] Generated: ${uniqueMcq.length} MCQ, ${uniqueTf.length} TF, ${uniqueEssay.length} Essay for lecture ${lecture_id}`);

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
